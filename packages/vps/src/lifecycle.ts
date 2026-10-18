import {
  ComputeError,
  instanceStateTable,
  isComputeError,
  type CallContext,
  type Condition,
  type ExternalMachine,
  type InstanceNicSpec,
  type InstanceSpec,
  type InstanceState,
  type ModuleContext,
  type ProviderImpl,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { refundQuota } from '@better-compute/capacity';
import { readPoolAccount } from './accounts.js';
import {
  attachConflictCondition,
  dropHeldMachineId,
  dropSealedUserData,
  duplicateBlocked,
  duplicateMachineCondition,
  liveHolderOf,
  ownershipBlocked,
  ownershipLostCondition,
  provisionFailed,
  provisionFailedCondition,
  exhaustedHostsCondition,
  exhaustedHostsOf,
  exhaustedReplaceMs,
  hostExhaustedCondition,
  maxExhaustedReplacements,
  instanceWork,
  isSecretRef,
  moveInstance,
  publishInstance,
  readInstance,
  renderUserData,
  scheduleHosted,
  scheduleRetryMs,
  updateInstance,
  withCondition,
  withoutCondition,
  type InstanceDeps,
  type InstanceRow,
} from './instances.js';
import { releaseAddress } from './ipam.js';
import { networkTag, providerResourceName } from './networks.js';
import { specPlacement, type HostPlacement } from './placement.js';
import { markSandboxReady, sandboxWork } from './sandboxes.js';
import { instanceVolumeSpecs, volumePlacement } from './volumes.js';

// The Instance controller (PLAN.md §11.1, §3.6): converges `state` toward `desiredState`.
// - Hosted pools: the daemon's runtime converges `NodeSpec.instances`; its reports arrive through
//   `reportInstances` and this reconciler turns them into transitions.
// - Provider pools: the reconciler drives `ProviderImpl` (create with idempotencyKey = instance id,
//   poll `get`, power, delete). Network calls never run inside a database transaction.

/** How often transitional instances are looked at again. */
export const pollTransitionalMs = 10_000;
/** How often steady provider instances are polled for drift. */
export const pollSteadyMs = 60_000;

/** Runtime states the daemon reports, plus `absent` (the runtime no longer holds the instance). */
export type ReportedState = 'running' | 'stopped' | 'paused' | 'error' | 'absent';

/** The settled states a runtime reports and an instance can be asked for. */
type Settled = 'running' | 'stopped' | 'paused';
const settled = (state: string | undefined): state is Settled =>
  state === 'running' || state === 'stopped' || state === 'paused';

/**
 * Walks `row` to `target` through `complete` steps and `stop`/`start`/`pause`/`resume`
 * (e.g. provisioning → starting → running → paused).
 */
async function advance(tx: SqlTx, row: InstanceRow, target: Settled): Promise<InstanceRow> {
  let current = row;
  for (let step = 0; step < 5 && current.state !== target; step++) {
    const state: InstanceState = current.state;
    if (state === 'provisioning') current = await moveInstance(tx, current, 'complete', 'starting');
    else if (state === 'starting' || state === 'rebooting')
      current = await moveInstance(tx, current, 'complete', 'running');
    else if (state === 'resizing')
      current = await moveInstance(
        tx,
        current,
        'complete',
        target === 'stopped' ? 'stopped' : 'running',
      );
    else if (state === 'running')
      current = await moveInstance(tx, current, target === 'stopped' ? 'stop' : 'pause');
    else if (state === 'paused')
      current = await moveInstance(tx, current, target === 'stopped' ? 'stop' : 'resume');
    else if (state === 'stopped') current = await moveInstance(tx, current, 'start');
    else if (state === 'lost') current = await moveInstance(tx, current, 'recover', target);
    else break;
  }
  return current;
}

async function finishDeletion(
  deps: InstanceDeps,
  tx: SqlTx,
  row: InstanceRow,
  /** Finish as a detach whatever `onDelete` says (the machine is not ours to delete any more). */
  options: { detached?: boolean } = {},
): Promise<InstanceRow> {
  if (row.allocationId) {
    try {
      await deps.capacity.release(tx, row.allocationId);
    } catch (error) {
      if (!isComputeError(error, 'NOT_FOUND')) throw error;
    }
  }
  await releaseAddress(tx, row.id);
  if (row.quotaCharged) await refundQuota(tx, row.tenantId, row.poolId, row.quotaCharged);
  const deleted = await moveInstance(tx, row, 'complete', 'deleted', {
    quotaCharged: null,
    conditions: withoutCondition(row.conditions, 'Unschedulable'),
  });
  await deps.authz.remove(tx, { type: 'instance', id: row.id, tenantId: row.tenantId });
  if (row.nodeId) await deps.desired.invalidate(tx, row.nodeId);
  // Its provider machine is free again (discovery's link); a detached one keeps running.
  await tx.query(`UPDATE provider_machines SET instance_id = NULL WHERE instance_id = $1`, [row.id]);
  const detached =
    row.origin === 'attached' && (row.onDelete === 'detach' || options.detached === true);
  await publishInstance(deps, tx, deleted, detached ? 'instance.detached' : 'instance.deleted', {
    ...(detached && row.externalId ? { externalId: row.externalId } : {}),
  });
  await dropSealedUserData(deps, row);
  // A sandbox's deletion finishes with its instance, not a periodic sandbox pass later.
  if (row.sandboxId !== undefined) await deps.work.enqueue(tx, sandboxWork, 'all');
  return deleted;
}

/** Moves into `deleting` when asked to, from any state that allows it. */
async function beginDeletion(
  deps: InstanceDeps,
  tx: SqlTx,
  row: InstanceRow,
): Promise<InstanceRow> {
  if (row.state === 'deleting' || row.state === 'deleted') return row;
  row = await dropHeldMachineId(tx, row, deps.clock.now());
  const next = await moveInstance(tx, row, 'delete', 'deleting', { reportedState: null });
  if (next.nodeId) await deps.desired.invalidate(tx, next.nodeId);
  return next;
}

async function nodeConnectivity(tx: SqlTx, nodeId: string): Promise<string | undefined> {
  const { rows } = await tx.query<{ connectivity: string }>(
    `SELECT connectivity FROM nodes WHERE id = $1`,
    [nodeId],
  );
  return rows[0]?.connectivity;
}

async function recreateOnLoss(tx: SqlTx, poolId: string): Promise<boolean> {
  const { rows } = await tx.query<{ recreate: boolean | null }>(
    `SELECT (policy->>'recreateOnHostLoss')::boolean AS recreate FROM pools WHERE id = $1`,
    [poolId],
  );
  return rows[0]?.recreate === true;
}

/**
 * Whether an instance whose host refused to start it may go elsewhere: nothing of its tenant's is on that host
 * yet. A new instance (`provisioning`), an unclaimed warm one, or a warm one a sandbox claimed that has not run
 * for it (the sandbox is not ready); never one whose volumes live there.
 */
async function replaceable(tx: SqlTx, row: InstanceRow): Promise<boolean> {
  const warm = row.warmTemplateId !== undefined || row.sandboxId !== undefined;
  if (row.state !== 'provisioning' && !(row.state === 'stopped' && warm)) return false;
  if (await volumePlacement(tx, row.id)) return false;
  if (row.state === 'provisioning' || row.sandboxId === undefined) return true;
  const { rows } = await tx.query<{ ready_at: unknown }>(`SELECT ready_at FROM sandboxes WHERE id = $1`, [
    row.sandboxId,
  ]);
  return rows.length === 1 && rows[0]!.ready_at === null;
}

/** One hosted-pool step in one transaction; the next wake-up time, or `undefined` when settled. */
async function reconcileHosted(
  deps: InstanceDeps,
  tx: SqlTx,
  row: InstanceRow,
): Promise<number | undefined> {
  const now = deps.clock.now();
  if (row.desiredState === 'deleted' && row.state !== 'deleting')
    row = await beginDeletion(deps, tx, row);

  if (row.state === 'pending') row = await moveInstance(tx, row, 'schedule', 'scheduling');
  if (row.state === 'scheduling') {
    try {
      const next = await scheduleHosted(deps, tx, row);
      return next.state === 'scheduling' ? now + scheduleRetryMs : now;
    } catch (error) {
      if (
        !isComputeError(error, 'QUOTA_EXCEEDED') &&
        !isComputeError(error, 'CAPACITY_UNAVAILABLE')
      )
        throw error;
      const failed = await moveInstance(tx, row, 'fail', 'error', {
        conditions: withCondition(
          row.conditions,
          {
            type: 'Unschedulable',
            status: 'true',
            reason: (error as ComputeError).code,
            message: (error as Error).message,
          },
          now,
        ),
      });
      await publishInstance(deps, tx, failed, 'instance.failed', {
        reason: (error as ComputeError).code,
      });
      return undefined;
    }
  }

  if (row.state === 'deleting') {
    if (!row.nodeId || row.reportedState === 'absent') {
      await finishDeletion(deps, tx, row);
      return undefined;
    }
    // Waiting for the runtime to drop it; a node that is gone for good cannot, so finish there.
    if ((await nodeConnectivity(tx, row.nodeId)) === 'lost') {
      await finishDeletion(deps, tx, row);
      return undefined;
    }
    return now + pollTransitionalMs;
  }

  if (row.nodeId && row.state !== 'lost' && row.state !== 'error') {
    if ((await nodeConnectivity(tx, row.nodeId)) === 'lost') {
      const lost = await moveInstance(tx, row, 'lose', 'lost');
      await publishInstance(deps, tx, lost, 'instance.lost', { nodeId: row.nodeId });
      return now;
    }
  }

  if (row.state === 'lost') {
    const connectivity = row.nodeId ? await nodeConnectivity(tx, row.nodeId) : undefined;
    if (connectivity === 'connected' && settled(row.reportedState)) {
      const recovered = await moveInstance(tx, row, 'recover', row.reportedState);
      await publishInstance(deps, tx, recovered, 'instance.recovered');
      return now;
    }
    if (await recreateOnLoss(tx, row.poolId)) {
      if (row.allocationId) await deps.capacity.release(tx, row.allocationId);
      await releaseAddress(tx, row.id);
      // The lost host's spec drops the instance, so a host that comes back removes its stale domain.
      if (row.nodeId) await deps.desired.invalidate(tx, row.nodeId);
      const again = await moveInstance(tx, row, 'recreate', 'scheduling', {
        nodeId: null,
        allocationId: null,
        addresses: [],
        reportedState: null,
      });
      await publishInstance(deps, tx, again, 'instance.recreating');
      return now;
    }
    return now + pollSteadyMs;
  }

  if (row.reportedState === 'error' && row.state !== 'error') {
    const failed = await moveInstance(tx, row, 'fail', 'error', {
      conditions: withCondition(
        row.conditions,
        { type: 'RuntimeError', status: 'true', reason: 'Reported' },
        now,
      ),
    });
    await publishInstance(deps, tx, failed, 'instance.failed', { reason: 'runtime' });
    return undefined;
  }

  // Its host's bcd refuses to start it (host admission, ResourcesExhausted: the control plane's booking
  // and the host drifted apart). One with nothing of its tenant's on that host yet is placed elsewhere
  // once the refusal has stood `exhaustedReplaceMs`, away from every host that refused it, at most
  // `maxExhaustedReplacements` times; then it fails. One that ran there, or whose volumes live there, waits.
  const refusal = row.nodeId
    ? row.conditions.find((c) => c.type === hostExhaustedCondition && c.status === 'true' && c.reason === row.nodeId)
    : undefined;
  if (refusal && row.desiredState !== 'stopped' && (await replaceable(tx, row))) {
    const due = refusal.since + exhaustedReplaceMs;
    if (now < due) return Math.min(due, now + pollTransitionalMs);
    const from = row.nodeId!;
    const avoided = exhaustedHostsOf(row.conditions);
    if (avoided.length >= maxExhaustedReplacements) {
      const failed = await moveInstance(tx, row, 'fail', 'error');
      await publishInstance(deps, tx, failed, 'instance.failed', { reason: 'resources-exhausted', nodeId: from });
      return undefined;
    }
    if (row.allocationId) await deps.capacity.release(tx, row.allocationId);
    await releaseAddress(tx, row.id);
    // Its spec drops the instance there, so that host removes the domain it could not start.
    await deps.desired.invalidate(tx, from);
    const again = await moveInstance(tx, row, 'recreate', 'scheduling', {
      nodeId: null,
      allocationId: null,
      addresses: [],
      reportedState: null,
      conditions: [
        ...row.conditions.filter((c) => c.type !== hostExhaustedCondition && c.type !== exhaustedHostsCondition),
        {
          type: exhaustedHostsCondition,
          status: 'true',
          reason: 'ResourcesExhausted',
          message: [...avoided, from].join(','),
          since: now,
        },
      ],
    });
    await publishInstance(deps, tx, again, 'instance.recreating', { reason: 'resources-exhausted', fromNodeId: from });
    return now;
  }

  const reported = row.reportedState;
  if (reported === row.desiredState && settled(reported)) {
    // Its host started it: the refusals (here and on the hosts it left) are over.
    if (row.conditions.some((c) => c.type === hostExhaustedCondition || c.type === exhaustedHostsCondition))
      row = await updateInstance(tx, row, {
        conditions: row.conditions.filter((c) => c.type !== hostExhaustedCondition && c.type !== exhaustedHostsCondition),
      });
    if (row.state !== reported) {
      const next = await advance(tx, row, reported);
      if (next.state !== row.state) await publishInstance(deps, tx, next, `instance.${next.state}`);
      // A sandbox is ready the moment its instance runs (§3.7), not a sandbox pass later.
      if (next.sandboxId !== undefined && next.state === 'running')
        await markSandboxReady(deps, tx, next.id);
      return next.state === reported ? undefined : now;
    }
    return undefined;
  }
  // Waiting for the runtime to converge on the desired state.
  return instanceStateTable.terminal.includes(row.state) || row.state === 'error'
    ? undefined
    : now + pollTransitionalMs;
}

/**
 * Fails an instance with a condition (and `instance.failed`): to `error` where the state table
 * allows it; an instance already in `error` or `lost` keeps its state and gains the condition.
 */
async function failWith(
  deps: InstanceDeps,
  tx: SqlTx,
  row: InstanceRow,
  condition: { type: string; reason: string; message: string },
  now: number,
): Promise<InstanceRow> {
  const conditions = withCondition(
    withoutCondition(row.conditions, 'ProviderError'),
    { ...condition, status: 'true', message: condition.message.slice(0, 500) },
    now,
  );
  const failed =
    row.state === 'error' || row.state === 'lost'
      ? await updateInstance(tx, row, { conditions })
      : await moveInstance(tx, row, 'fail', 'error', { conditions });
  await publishInstance(deps, tx, failed, 'instance.failed', { reason: condition.type });
  return failed;
}

/** A provider call where a machine that is already gone (`NOT_FOUND`) gives `undefined`. */
async function gone<T>(call: Promise<T>): Promise<T | undefined> {
  try {
    return await call;
  } catch (error) {
    if (isComputeError(error, 'NOT_FOUND')) return undefined;
    throw error;
  }
}

function callContext(deps: InstanceDeps, idempotencyKey: string, signal: AbortSignal): CallContext {
  return { idempotencyKey, signal, clock: deps.clock, secrets: deps.secrets, log: deps.log };
}

type ProviderAction =
  | { kind: 'create' }
  | { kind: 'get' }
  | { kind: 'power'; action: 'on' | 'graceful-off' }
  | { kind: 'delete' }
  /** Attached, before adoption: write the ownership label naming the instance. */
  | { kind: 'claim' }
  /** Attached, detached on delete: remove the label; the machine keeps running. */
  | { kind: 'release' }
  /** Attached, deleted on delete: hand the machine to better-compute (managed), then delete it. */
  | { kind: 'managed-delete' }
  /** `instances.reboot` was asked for and not done yet. */
  | { kind: 'reboot'; action: 'graceful-restart' | 'reset' }
  /** Attached, ownership lost or never won: nothing more is asked of the provider. */
  | { kind: 'blocked' }
  /** Attached, ownership lost or never won, being deleted: finish as a detach, no provider call. */
  | { kind: 'forget' }
  | { kind: 'none' };

function providerAction(row: InstanceRow): ProviderAction {
  const attached = row.origin === 'attached';
  // An attached instance that lost (or never won) its machine's ownership label never touches it.
  // Or whose machine id a live instance holds: that machine is the live one's.
  const blocked = (attached && ownershipBlocked(row.conditions)) || duplicateBlocked(row.conditions);
  if (row.state === 'deleting') {
    if (!row.externalId) return { kind: 'none' };
    if (blocked) return { kind: 'forget' };
    if (attached) return row.onDelete === 'detach' ? { kind: 'release' } : { kind: 'managed-delete' };
    return { kind: 'delete' };
  }
  if (blocked) return { kind: 'blocked' };
  // The provider failed its create for good (W3a): it has no machine to ask about until deleted.
  if (row.state === 'error' && provisionFailed(row.conditions)) return { kind: 'blocked' };
  // Not claimed yet (in any state): the label first, before anything else is asked of it.
  if (attached && row.externalId && !row.claimed) return { kind: 'claim' };
  if (row.state === 'scheduling') return row.externalId ? { kind: 'get' } : { kind: 'create' };
  if (!row.externalId) return { kind: 'none' };
  if (row.state === 'running' && row.desiredState === 'running' && row.rebootPending)
    return { kind: 'reboot', action: row.rebootHard ? 'reset' : 'graceful-restart' };
  if (row.state === 'running' && row.desiredState === 'stopped' && row.reportedState === 'running')
    return { kind: 'power', action: 'graceful-off' };
  if (row.state === 'stopped' && row.desiredState === 'running' && row.reportedState === 'stopped')
    return { kind: 'power', action: 'on' };
  return { kind: 'get' };
}

const machineStates: Partial<Record<ExternalMachine['state'], ReportedState>> = {
  running: 'running',
  stopped: 'stopped',
  error: 'error',
  deleted: 'absent',
};

/**
 * One provider-pool step: plan in a short transaction, call the provider outside any transaction,
 * then apply the result in a second transaction guarded by the row version.
 */
async function reconcileProvider(
  deps: InstanceDeps,
  sql: SqlExecutor,
  instanceId: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  const planned = await sql.transaction(async (tx) => {
    let row = await readInstance(tx, instanceId, { lock: true });
    if (!row || row.draft || row.state === 'deleted') return undefined;
    if (row.desiredState === 'deleted' && row.state !== 'deleting')
      row = await beginDeletion(deps, tx, row);
    if (row.state === 'pending') row = await moveInstance(tx, row, 'schedule', 'scheduling');
    // R1: only an account of the pool owner's tenant (a foreign one reads as none).
    const account = row.providerAccountId
      ? await readPoolAccount(tx, row.providerAccountId, row.poolId)
      : undefined;
    return { row, account };
  });
  if (!planned) return undefined;
  const { row, account } = planned;
  const action = providerAction(row);
  const now = deps.clock.now();

  if (action.kind === 'blocked') return undefined;
  if (action.kind === 'forget') {
    await sql.transaction(async (tx) => {
      const current = await readInstance(tx, instanceId, { lock: true });
      if (current && current.version === row.version)
        await finishDeletion(deps, tx, current, { detached: true });
    });
    return undefined;
  }
  if (action.kind === 'none') {
    if (row.state === 'deleting')
      await sql.transaction(async (tx) => {
        const current = await readInstance(tx, instanceId, { lock: true });
        if (current && current.version === row.version) await finishDeletion(deps, tx, current);
      });
    return row.state === 'deleting' ? undefined : now + pollSteadyMs;
  }
  if (!account && row.providerAccountId !== undefined && row.state === 'deleting') {
    // R1: a pool's account that is not its owner's is never used, deletion included. The instance
    // goes without a provider call; a machine it made stays for the account's owner to remove.
    await sql.transaction(async (tx) => {
      const current = await readInstance(tx, instanceId, { lock: true });
      if (current && current.version === row.version)
        await finishDeletion(deps, tx, current, { detached: true });
    });
    return undefined;
  }
  if (!account)
    throw new ComputeError('INVALID_STATE', `Instance ${row.id} has no provider account`);

  let machine: ExternalMachine | undefined;
  let failure: unknown;
  /** The provider writes ownership labels: every read of a claimed machine must name this instance. */
  let labelled = false;
  /** The delete path found the label gone or foreign: finish as a detach, nothing deleted. */
  let forget = false;
  try {
    const client: ProviderImpl = await deps.clients.client(account, deps);
    labelled = typeof client.claim === 'function';
    const context = callContext(deps, row.id, signal);
    if (action.kind === 'create') {
      // An attached machine existed before better-compute: it is adopted or lost, never made anew.
      if (row.origin === 'attached')
        throw new ComputeError('INVALID_STATE', `Attached instance ${row.id} is never created`);
      if (!row.shape.offerId)
        throw new ComputeError('INVALID_STATE', `Flavor ${row.shape.name} names no offer`);
      machine = await client.create(
        {
          offerId: row.shape.offerId,
          image: row.imageId,
          // A tenant's secret:// ref (checked to be its own at create) is resolved for the provider.
          userData: isSecretRef(row.userData)
            ? await deps.secrets.resolve(row.userData)
            : renderUserData(row),
          name: row.id,
          // (v1.0) On a tenant network: its subnet, and the tag the firewall rules target.
          ...(row.networkId !== undefined && row.subnetId !== undefined
            ? {
                network: {
                  network: providerResourceName(row.networkId),
                  subnet: providerResourceName(row.subnetId),
                  tags: [networkTag(row.id)],
                },
              }
            : {}),
        },
        context,
      );
    } else if (action.kind === 'delete') {
      try {
        await client.delete(row.externalId!, context);
      } catch (error) {
        if (!isComputeError(error, 'NOT_FOUND')) throw error;
      }
    } else if (action.kind === 'claim') {
      // Providers without labels have nothing to write: their own delete/power guards apply.
      machine = client.claim
        ? await gone(client.claim(row.externalId!, row.id, context))
        : await client.get(row.externalId!, context);
    } else if (action.kind === 'release') {
      if (client.release) await gone(client.release(row.externalId!, row.id, context));
    } else if (action.kind === 'managed-delete') {
      // A claimed machine whose label is gone or names someone else is not re-acquired: the
      // instance finishes as a detach, and the machine is left alone.
      const seen = row.claimed && labelled ? await client.get(row.externalId!, context) : undefined;
      if (row.claimed && labelled && seen !== undefined && seen.claimedBy !== row.id) forget = true;
      // Otherwise the label first: a machine another instance claimed is refused (CONFLICT).
      const claimed =
        forget || (row.claimed && labelled && seen === undefined)
          ? undefined
          : client.claim
            ? await gone(client.claim(row.externalId!, row.id, context, { managed: true }))
            : true;
      if (claimed !== undefined)
        try {
          await client.delete(row.externalId!, context);
        } catch (error) {
          if (!isComputeError(error, 'NOT_FOUND')) throw error;
        }
    } else if (action.kind === 'reboot') {
      if (!client.power)
        throw new ComputeError('UNSUPPORTED', `Provider ${account.provider} cannot reboot machines`);
      await client.power(row.externalId!, action.action, context);
      machine = await client.get(row.externalId!, context);
    } else if (action.kind === 'power') {
      if (!client.power)
        throw new ComputeError('UNSUPPORTED', `Provider ${account.provider} has no power control`);
      await client.power(row.externalId!, action.action, context);
      machine = await client.get(row.externalId!, context);
    } else machine = await client.get(row.externalId!, context);
  } catch (error) {
    failure = error;
  }

  return sql.transaction(async (tx) => {
    let current = await readInstance(tx, instanceId, { lock: true });
    if (!current || current.version !== row.version) return deps.clock.now();
    if (failure !== undefined) {
      const code = isComputeError(failure) ? failure.code : 'PROVIDER_ERROR';
      // A reboot the provider cannot do is dropped (with the error as a condition): the instance runs on.
      if (action.kind === 'reboot' && code === 'UNSUPPORTED') {
        await updateInstance(tx, current, {
          rebooted: true,
          conditions: withCondition(
            current.conditions,
            {
              type: 'ProviderError',
              status: 'true',
              reason: code,
              message: String((failure as Error)?.message ?? failure).slice(0, 500),
            },
            now,
          ),
        });
        return now + pollSteadyMs;
      }
      // The machine's ownership label names another instance: this one never owns it.
      if (code === 'CONFLICT' && (action.kind === 'claim' || action.kind === 'managed-delete')) {
        await failWith(deps, tx, current, {
          type: attachConflictCondition,
          reason: 'CONFLICT',
          message: String((failure as Error)?.message ?? failure),
        }, now);
        return undefined;
      }
      // W3a: the provider refused the create for capacity or quota, at once or (read back through
      // `get` while it is still being created) after accepting it. Retrying cannot help: the
      // instance fails, keeping its quota until it is deleted.
      if (
        (code === 'CAPACITY_UNAVAILABLE' || code === 'QUOTA_EXCEEDED') &&
        (action.kind === 'create' || action.kind === 'get') &&
        (current.state === 'scheduling' || current.state === 'provisioning')
      ) {
        const failed = await moveInstance(tx, current, 'fail', 'error', {
          conditions: withCondition(
            withoutCondition(current.conditions, 'ProviderError'),
            {
              type: provisionFailedCondition,
              status: 'true',
              reason: code,
              message: String((failure as Error)?.message ?? failure).slice(0, 500),
            },
            now,
          ),
        });
        await publishInstance(deps, tx, failed, 'instance.failed', { reason: code });
        return undefined;
      }
      current = await updateInstance(tx, current, {
        conditions: withCondition(
          current.conditions,
          {
            type: 'ProviderError',
            status: 'true',
            reason: code,
            message: String((failure as Error)?.message ?? failure).slice(0, 500),
          },
          now,
        ),
      });
      if (code === 'UNSUPPORTED' || code === 'INVALID_STATE' || code === 'INVALID_CONFIG') {
        const failed = await moveInstance(tx, current, 'fail', 'error');
        await publishInstance(deps, tx, failed, 'instance.failed', { reason: code });
        return undefined;
      }
      return now + pollTransitionalMs * 3;
    }
    const conditions = withoutCondition(current.conditions, 'ProviderError');
    if (action.kind === 'delete' || action.kind === 'release' || action.kind === 'managed-delete') {
      await finishDeletion(deps, tx, await updateInstance(tx, current, { conditions }), {
        detached: forget,
      });
      return undefined;
    }
    // A claimed attached machine must still carry this instance's label: one that lost it (or
    // names another instance) is never adopted, recovered or acted on again.
    if (
      machine &&
      labelled &&
      current.origin === 'attached' &&
      (current.claimed || action.kind === 'claim') &&
      machine.claimedBy !== current.id
    ) {
      await failWith(deps, tx, current, {
        type: ownershipLostCondition,
        reason: machine.claimedBy === undefined ? 'LabelMissing' : 'LabelForeign',
        message:
          machine.claimedBy === undefined
            ? `Machine ${machine.id} no longer carries this instance's ownership label`
            : `Machine ${machine.id} is labelled for instance ${machine.claimedBy}`,
      }, now);
      return undefined;
    }
    if (action.kind === 'claim') current = await updateInstance(tx, current, { claimed: true });
    if (action.kind === 'reboot') {
      // The request this run planned is done (a newer one bumps the version and re-plans).
      current = await updateInstance(tx, current, { rebooted: true });
      await publishInstance(deps, tx, current, 'instance.rebooted', {
        hard: action.action === 'reset',
      });
    }
    if (!machine) {
      // `get` found nothing: gone underneath us.
      if (current.state === 'deleting') {
        await finishDeletion(deps, tx, current);
        return undefined;
      }
      // Already lost: it stays lost (an attached machine is never recreated).
      if (current.state === 'lost') return undefined;
      if (current.state === 'scheduling')
        current = await moveInstance(tx, current, 'complete', 'provisioning');
      const lost = await moveInstance(tx, current, 'lose', 'lost', {
        conditions,
        reportedState: 'absent',
      });
      await publishInstance(deps, tx, lost, 'instance.lost');
      return undefined;
    }
    const reported = machineStates[machine.state];
    const machineKnown = current.externalId !== undefined;
    await tx.query('SAVEPOINT vps_external_id');
    try {
      current = await updateInstance(tx, current, {
        conditions,
        externalId: machine.id,
        addresses: machine.addresses,
        reportedState: reported ?? null,
      });
      await tx.query('RELEASE SAVEPOINT vps_external_id');
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT vps_external_id');
      if ((error as { code?: unknown }).code !== '23505') throw error;
      // instances_external_live: another live instance holds this machine (a reused id). Failing
      // here ends the instance's retries instead of looping on the same refusal.
      await failWith(deps, tx, current, {
        type: duplicateMachineCondition,
        reason: '23505',
        message: `Machine ${machine.id} belongs to another live instance`,
      }, now);
      return undefined;
    }
    // When the machine first became known: a reservation scan that began earlier may not count it.
    if (!machineKnown)
      await tx.query(
        `UPDATE instances SET provider_reservation_at = compute_now()
          WHERE id = $1 AND provider_reservation IS NOT NULL AND provider_reservation_at IS NULL`,
        [current.id],
      );
    // A lost or failed row holds no place in instances_external_live: before it can move back into
    // a live state, the machine id must not belong to a live instance (a provider reused it).
    if (current.state === 'lost' || current.state === 'error') {
      const holder = await liveHolderOf(tx, current);
      if (holder !== undefined) {
        await failWith(deps, tx, current, {
          type: duplicateMachineCondition,
          reason: 'LiveHolder',
          message: `Machine ${machine.id} belongs to live instance ${holder}`,
        }, now);
        return undefined;
      }
    }
    // The transitions below may put the row back into instances_external_live: a race that lands
    // there as a unique violation fails the instance the same way, instead of a retry loop.
    const settling = current;
    await tx.query('SAVEPOINT vps_settle');
    try {
      if (current.state === 'scheduling') {
        current = await moveInstance(tx, current, 'complete', 'provisioning');
        await publishInstance(deps, tx, current, 'instance.provisioning', { externalId: machine.id });
      }
      if (reported === 'error') {
        const failed = await moveInstance(tx, current, 'fail', 'error');
        await publishInstance(deps, tx, failed, 'instance.failed', { reason: 'provider' });
        return undefined;
      }
      if (reported === 'absent' && current.state !== 'deleting') {
        const lost = await moveInstance(tx, current, 'lose', 'lost');
        await publishInstance(deps, tx, lost, 'instance.lost');
        return undefined;
      }
      if (reported === 'running' || reported === 'stopped') {
        // A machine that booted while `stopped` is wanted gets powered off next round, and vice versa.
        const booting = current.state === 'provisioning' || current.state === 'starting';
        // An attached machine is adopted as it is, running or stopped.
        const adopting = booting && current.origin === 'attached';
        const target = booting && !adopting ? 'running' : reported;
        const next =
          reported === 'running' || current.state === 'running' || adopting
            ? await advance(tx, current, target)
            : current;
        if (next.state !== current.state)
          await publishInstance(deps, tx, next, `instance.${next.state}`);
        current = next;
        if (current.state === current.desiredState) return now + pollSteadyMs;
      }
      return now + pollTransitionalMs;
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT vps_settle');
      if ((error as { code?: unknown }).code !== '23505') throw error;
      await failWith(deps, tx, settling, {
        type: duplicateMachineCondition,
        reason: '23505',
        message: `Machine ${machine.id} belongs to another live instance`,
      }, now);
      return undefined;
    }
  });
}

/** One reconcile of one instance (the `vps.instances` reconciler). */
export async function reconcileInstance(
  deps: InstanceDeps,
  sql: SqlExecutor,
  instanceId: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  const kind = await sql.query<{ class: string }>(
    `SELECT p.class FROM instances i JOIN pools p ON p.id = i.pool_id WHERE i.id = $1`,
    [instanceId],
  );
  const poolClass = kind.rows[0]?.class;
  if (poolClass === undefined) return undefined;
  if (poolClass === 'provider') return reconcileProvider(deps, sql, instanceId, signal);
  return sql.transaction(async (tx) => {
    const row = await readInstance(tx, instanceId, { lock: true });
    if (!row || row.draft || row.state === 'deleted') return undefined;
    return reconcileHosted(deps, tx, row);
  });
}

/** What bcd's host admission puts before the message of an instance whose start it refused. */
export const resourcesExhausted = 'ResourcesExhausted';

/** One instance as a host runtime reports it. */
export interface InstanceReport {
  id: string;
  state: 'running' | 'stopped' | 'paused' | 'error';
  addresses?: readonly string[];
  message?: string;
  /** The rebind ref the guest confirmed it applied (`InstanceStatus.identity_rebound_ref`). */
  identityReboundRef?: string;
}

/**
 * Ingests a host's runtime report (the gateway calls it inside its ingest transaction). Only
 * instances placed on `nodeId` are touched, so one node can never move another's instances. With
 * `complete: true` the list is the runtime's whole inventory: placed instances missing from it are
 * `absent`. Returns `orphans`: instances the runtime holds that no live row places there (leaks).
 */
export async function reportInstances(
  tx: SqlTx,
  work: ModuleContext['work'],
  nodeId: string,
  reports: readonly InstanceReport[],
  options: { complete?: boolean } = {},
): Promise<{ updated: number; orphans: string[] }> {
  const { rows } = await tx.query<{
    id: string;
    reported_state: string | null;
    addresses: string[];
    identity_rebind_ref: string | null;
    identity_rebound_ref: string | null;
    conditions: Condition[] | string;
  }>(
    `SELECT id, reported_state, addresses, identity_rebind_ref, identity_rebound_ref, conditions FROM instances
      WHERE node_id = $1 AND state <> 'deleted' AND NOT draft FOR UPDATE`,
    [nodeId],
  );
  let clock: number | undefined;
  const now = async () => {
    clock ??= Number(
      (await tx.query<{ now: string }>(`SELECT (extract(epoch FROM compute_now()) * 1000)::bigint AS now`)).rows[0]!.now,
    );
    return clock;
  };
  const placed = new Map(rows.map((row) => [row.id, row]));
  const orphans: string[] = [];
  let updated = 0;
  const seen = new Set<string>();
  for (const report of reports) {
    const row = placed.get(report.id);
    if (!row) {
      orphans.push(report.id);
      continue;
    }
    seen.add(report.id);
    // bcd's host admission refused its start (it stays stopped with the reason, and retries): recorded
    // once as a condition naming this node, cleared once the node reports anything else.
    const conditions: Condition[] =
      typeof row.conditions === 'string' ? JSON.parse(row.conditions) : (row.conditions ?? []);
    const refused = report.state === 'stopped' && (report.message?.startsWith(`${resourcesExhausted}:`) ?? false);
    const standing = conditions.some((c) => c.type === hostExhaustedCondition && c.reason === nodeId);
    if (refused !== standing) {
      const next = refused
        ? withCondition(
            conditions,
            { type: hostExhaustedCondition, status: 'true', reason: nodeId, message: report.message!.slice(0, 512) },
            await now(),
          )
        : conditions.filter((c) => !(c.type === hostExhaustedCondition && c.reason === nodeId));
      await tx.query(`UPDATE instances SET conditions = $2::jsonb, version = version + 1 WHERE id = $1`, [
        report.id,
        JSON.stringify(next),
      ]);
      await work.enqueue(tx, instanceWork, report.id);
      updated++;
    }
    // The guest confirmed it installed the identity this spec sends: exec signs for it alone now.
    if (
      report.identityReboundRef !== undefined &&
      row.identity_rebind_ref !== null &&
      report.identityReboundRef === row.identity_rebind_ref &&
      row.identity_rebound_ref !== row.identity_rebind_ref
    ) {
      await applyIdentityRebind(tx, report.id, row.identity_rebind_ref);
      updated++;
    }
    const addresses = [...new Set([...(row.addresses ?? []), ...(report.addresses ?? [])])];
    if (row.reported_state === report.state && addresses.length === (row.addresses ?? []).length)
      continue;
    await tx.query(
      `UPDATE instances SET reported_state = $2, reported_at = compute_now(), addresses = $3::text[],
                            version = version + 1
        WHERE id = $1`,
      [report.id, report.state, addresses],
    );
    await work.enqueue(tx, instanceWork, report.id);
    updated++;
  }
  if (options.complete)
    for (const row of rows) {
      if (seen.has(row.id) || row.reported_state === 'absent') continue;
      await tx.query(
        `UPDATE instances SET reported_state = 'absent', reported_at = compute_now(), version = version + 1
          WHERE id = $1`,
        [row.id],
      );
      await work.enqueue(tx, instanceWork, row.id);
      updated++;
    }
  return { updated, orphans: orphans.sort() };
}

/**
 * A memory restore's guest installed its own identity (principals, host key and certificate from the
 * sealed bundle): its exec principal becomes the instance itself, and its host certificate the one
 * the bundle carried. Only the ref the spec sent counts, once.
 */
async function applyIdentityRebind(tx: SqlTx, instanceId: string, ref: string): Promise<void> {
  await tx.query(
    `UPDATE instances
        SET identity_rebound_ref = $2,
            restore_from = jsonb_set(restore_from, '{principalInstanceId}', to_jsonb(id)),
            host_certified = rebind_cert_valid_before IS NOT NULL,
            host_cert_valid_before = rebind_cert_valid_before,
            version = version + 1
      WHERE id = $1 AND identity_rebind_ref = $2 AND restore_from IS NOT NULL`,
    [instanceId, ref],
  );
}

/** The host bridge hosted instances' NIC attaches to, unless `vps({ hostNetwork })` names another. */
export const defaultHostNetwork = 'br0';

/**
 * The `instances` section of a hosted node's spec (§7.3): every live instance placed there, with the
 * image it boots, its GPU atoms, its allocation (the host names it to fetch the user data) and one
 * NIC with its IPAM address and a stable locally administered MAC; deleting instances are sent as
 * `desiredState: 'deleted'`.
 */
export async function instanceSpecs(
  tx: SqlTx,
  nodeId: string,
  options: { network?: string } = {},
): Promise<InstanceSpec[]> {
  const { rows } = await tx.query<{
    id: string;
    state: InstanceState;
    desired_state: 'running' | 'stopped' | 'paused' | 'deleted';
    runtime: string;
    flavor: { vcpu: number; memoryGiB: number; diskGiB: number; gpus: number } | string;
    image: { url: string; sha256: string; format: 'raw' | 'qcow2' | 'iso' } | string | null;
    user_data: string | null;
    ssh_keys: string[];
    allocation_id: string | null;
    atoms: string[] | null;
    address: string | null;
    gateway: string | null;
    dns: string[] | null;
    mac: string;
    restore_from: { snapshotId: string; url: string; sha256: string } | string | null;
    network_policy: 'private' | 'none' | null;
    identity_rebind_ref: string | null;
    host_placement: HostPlacement | string | null;
    sandboxed: boolean;
  }>(
    `SELECT i.id, i.state, i.desired_state, i.runtime, i.flavor, i.image, i.user_data, i.ssh_keys,
            i.allocation_id, a.atoms, i.restore_from, i.network_policy, i.identity_rebind_ref,
            i.host_placement,
            (i.sandbox_id IS NOT NULL OR i.warm_template_id IS NOT NULL) AS sandboxed,
            host(l.address) || '/' || masklen(p.cidr) AS address,
            CASE WHEN l.address IS NOT NULL THEN host(p.gateway) END AS gateway,
            CASE WHEN l.address IS NOT NULL THEN ARRAY(SELECT host(d) FROM unnest(p.dns) d) END AS dns,
            regexp_replace('02' || substr(encode(sha256(convert_to(i.id, 'UTF8')), 'hex'), 1, 10),
                           '(..)(?=.)', '\\1:', 'g') AS mac
       FROM instances i
       LEFT JOIN allocations a ON a.id = i.allocation_id
       LEFT JOIN ip_leases l ON l.instance_id = i.id
       LEFT JOIN ip_pools p ON p.pool_id = l.pool_id
      WHERE i.node_id = $1 AND i.state NOT IN ('deleted', 'pending', 'scheduling') AND NOT i.draft
      ORDER BY i.id`,
    [nodeId],
  );
  const network = options.network ?? defaultHostNetwork;
  // Agent memory: the host volumes each instance attaches, in order.
  const volumes = await instanceVolumeSpecs(tx, rows.map((row) => row.id));
  return rows.flatMap((row) => {
    const image = typeof row.image === 'string' ? JSON.parse(row.image) : row.image;
    if (!image) return [];
    const flavor = typeof row.flavor === 'string' ? JSON.parse(row.flavor) : row.flavor;
    const spec: InstanceSpec = {
      id: row.id,
      desiredState: row.state === 'deleting' ? 'deleted' : row.desired_state,
      runtime: row.runtime,
      flavor: {
        vcpu: flavor.vcpu,
        memoryGiB: flavor.memoryGiB,
        diskGiB: flavor.diskGiB,
        ...(flavor.gpus ? { gpus: flavor.gpus } : {}),
      },
      image: { url: image.url, sha256: image.sha256, format: image.format },
      userData: renderUserData({
        id: row.id,
        sshKeys: row.ssh_keys ?? [],
        ...(row.user_data !== null ? { userData: row.user_data } : {}),
      }),
    };
    if (row.atoms && row.atoms.length > 0) spec.deviceIds = [...row.atoms];
    if (row.allocation_id) spec.allocationId = row.allocation_id;
    // A restored sandbox (§3.7): the host fetches and verifies the snapshot instead of a fresh boot.
    const restore =
      typeof row.restore_from === 'string' ? JSON.parse(row.restore_from) : row.restore_from;
    if (restore)
      spec.restoreFrom = { url: restore.url, sha256: restore.sha256, imageId: restore.snapshotId };
    // A sandbox template's network (§3.7): the host enforces it on the instance's taps.
    if (row.network_policy) spec.networkPolicy = row.network_policy;
    // Sandbox guests take ssh only from their host (the exec tunnel's dial), never from each other.
    if (row.sandboxed) spec.sshFromHostOnly = true;
    // A memory restore's own identity, which the host installs into the resumed guest (§3.7).
    if (row.identity_rebind_ref) spec.identityRebindRef = row.identity_rebind_ref;
    // Where its vCPUs and memory live on the host (§3.8), as chosen at placement.
    const placement = specPlacement(
      typeof row.host_placement === 'string' ? JSON.parse(row.host_placement) : (row.host_placement ?? undefined),
    );
    if (placement) spec.placement = placement;
    const attached = volumes.get(row.id);
    if (attached?.length) spec.volumes = attached;
    const nic: InstanceNicSpec = { network, mac: row.mac, addresses: row.address ? [row.address] : [] };
    // The guest's network-config (bcd renders it into the NoCloud seed): route and resolvers.
    if (row.gateway) nic.gateway = row.gateway;
    if (row.dns?.length) nic.nameservers = [...row.dns];
    spec.nics = [nic];
    return [spec];
  });
}
