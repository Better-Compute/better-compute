import {
  ComputeError,
  instanceStateTable,
  isComputeError,
  type CallContext,
  type ExternalMachine,
  type InstanceSpec,
  type InstanceState,
  type ModuleContext,
  type ProviderImpl,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { refundQuota } from '@better-compute/capacity';
import { readAccount } from './accounts.js';
import {
  instanceWork,
  moveInstance,
  publishInstance,
  readInstance,
  scheduleHosted,
  scheduleRetryMs,
  updateInstance,
  withCondition,
  withoutCondition,
  type InstanceDeps,
  type InstanceRow,
} from './instances.js';
import { releaseAddress } from './ipam.js';

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
export type ReportedState = 'running' | 'stopped' | 'error' | 'absent';

/** Walks `row` to `target` through `complete` steps and `stop`/`start` (e.g. provisioning → running → stopped). */
async function advance(
  tx: SqlTx,
  row: InstanceRow,
  target: 'running' | 'stopped',
): Promise<InstanceRow> {
  let current = row;
  for (let step = 0; step < 4 && current.state !== target; step++) {
    const state: InstanceState = current.state;
    if (state === 'provisioning') current = await moveInstance(tx, current, 'complete', 'starting');
    else if (state === 'starting' || state === 'rebooting')
      current = await moveInstance(tx, current, 'complete', 'running');
    else if (state === 'resizing') current = await moveInstance(tx, current, 'complete', target);
    else if (state === 'running' && target === 'stopped')
      current = await moveInstance(tx, current, 'stop');
    else if (state === 'stopped' && target === 'running')
      current = await moveInstance(tx, current, 'start');
    else if (state === 'lost') current = await moveInstance(tx, current, 'recover', target);
    else break;
  }
  return current;
}

async function finishDeletion(
  deps: InstanceDeps,
  tx: SqlTx,
  row: InstanceRow,
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
  await publishInstance(deps, tx, deleted, 'instance.deleted');
  return deleted;
}

/** Moves into `deleting` when asked to, from any state that allows it. */
async function beginDeletion(
  deps: InstanceDeps,
  tx: SqlTx,
  row: InstanceRow,
): Promise<InstanceRow> {
  if (row.state === 'deleting' || row.state === 'deleted') return row;
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
    if (
      connectivity === 'connected' &&
      (row.reportedState === 'running' || row.reportedState === 'stopped')
    ) {
      const recovered = await moveInstance(tx, row, 'recover', row.reportedState);
      await publishInstance(deps, tx, recovered, 'instance.recovered');
      return now;
    }
    if (await recreateOnLoss(tx, row.poolId)) {
      if (row.allocationId) await deps.capacity.release(tx, row.allocationId);
      await releaseAddress(tx, row.id);
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

  const reported = row.reportedState;
  if (reported === row.desiredState && (reported === 'running' || reported === 'stopped')) {
    if (row.state !== reported) {
      const next = await advance(tx, row, reported);
      if (next.state !== row.state) await publishInstance(deps, tx, next, `instance.${next.state}`);
      return next.state === reported ? undefined : now;
    }
    return undefined;
  }
  // Waiting for the runtime to converge on the desired state.
  return instanceStateTable.terminal.includes(row.state) || row.state === 'error'
    ? undefined
    : now + pollTransitionalMs;
}

function callContext(deps: InstanceDeps, idempotencyKey: string, signal: AbortSignal): CallContext {
  return { idempotencyKey, signal, clock: deps.clock, secrets: deps.secrets, log: deps.log };
}

/** Cloud-init for provider instances: the tenant's keys, or the tenant's own user data. No join tokens, ever. */
export function renderUserData(row: Pick<InstanceRow, 'id' | 'sshKeys' | 'userData'>): string {
  if (row.userData !== undefined) return row.userData;
  const keys = row.sshKeys.map((key) => `  - ${JSON.stringify(key)}`).join('\n');
  return `#cloud-config\nhostname: ${row.id.replaceAll('_', '-').slice(0, 63)}\n${
    keys ? `ssh_authorized_keys:\n${keys}\n` : ''
  }`;
}

type ProviderAction =
  | { kind: 'create' }
  | { kind: 'get' }
  | { kind: 'power'; action: 'on' | 'graceful-off' }
  | { kind: 'delete' }
  | { kind: 'none' };

function providerAction(row: InstanceRow): ProviderAction {
  if (row.state === 'deleting') return row.externalId ? { kind: 'delete' } : { kind: 'none' };
  if (row.state === 'scheduling') return row.externalId ? { kind: 'get' } : { kind: 'create' };
  if (!row.externalId) return { kind: 'none' };
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
    const account = row.providerAccountId
      ? await readAccount(tx, row.providerAccountId)
      : undefined;
    return { row, account };
  });
  if (!planned) return undefined;
  const { row, account } = planned;
  const action = providerAction(row);
  const now = deps.clock.now();

  if (action.kind === 'none') {
    if (row.state === 'deleting')
      await sql.transaction(async (tx) => {
        const current = await readInstance(tx, instanceId, { lock: true });
        if (current && current.version === row.version) await finishDeletion(deps, tx, current);
      });
    return row.state === 'deleting' ? undefined : now + pollSteadyMs;
  }
  if (!account)
    throw new ComputeError('INVALID_STATE', `Instance ${row.id} has no provider account`);

  let machine: ExternalMachine | undefined;
  let failure: unknown;
  try {
    const client: ProviderImpl = await deps.clients.client(account, deps);
    const context = callContext(deps, row.id, signal);
    if (action.kind === 'create') {
      if (!row.shape.offerId)
        throw new ComputeError('INVALID_STATE', `Flavor ${row.shape.name} names no offer`);
      machine = await client.create(
        {
          offerId: row.shape.offerId,
          image: row.imageId,
          userData: renderUserData(row),
          name: row.id,
        },
        context,
      );
    } else if (action.kind === 'delete') {
      try {
        await client.delete(row.externalId!, context);
      } catch (error) {
        if (!isComputeError(error, 'NOT_FOUND')) throw error;
      }
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
    if (action.kind === 'delete') {
      await finishDeletion(deps, tx, await updateInstance(tx, current, { conditions }));
      return undefined;
    }
    if (!machine) {
      // `get` found nothing: gone underneath us.
      if (current.state === 'deleting') {
        await finishDeletion(deps, tx, current);
        return undefined;
      }
      const lost = await moveInstance(tx, current, 'lose', 'lost', {
        conditions,
        reportedState: 'absent',
      });
      await publishInstance(deps, tx, lost, 'instance.lost');
      return undefined;
    }
    const reported = machineStates[machine.state];
    current = await updateInstance(tx, current, {
      conditions,
      externalId: machine.id,
      addresses: machine.addresses,
      reportedState: reported ?? null,
    });
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
      const target =
        current.state === 'provisioning' || current.state === 'starting' ? 'running' : reported;
      const next =
        reported === 'running' || current.state === 'running'
          ? await advance(tx, current, target)
          : current;
      if (next.state !== current.state)
        await publishInstance(deps, tx, next, `instance.${next.state}`);
      current = next;
      if (current.state === current.desiredState) return now + pollSteadyMs;
    }
    return now + pollTransitionalMs;
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

/** One instance as a host runtime reports it. */
export interface InstanceReport {
  id: string;
  state: 'running' | 'stopped' | 'error';
  addresses?: readonly string[];
  message?: string;
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
  }>(
    `SELECT id, reported_state, addresses FROM instances
      WHERE node_id = $1 AND state <> 'deleted' AND NOT draft FOR UPDATE`,
    [nodeId],
  );
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
 * The `instances` section of a hosted node's spec (§7.3): every live instance placed there, with the
 * image it boots and its GPU atoms; deleting instances are sent as `desiredState: 'deleted'`.
 */
export async function instanceSpecs(tx: SqlTx, nodeId: string): Promise<InstanceSpec[]> {
  const { rows } = await tx.query<{
    id: string;
    state: InstanceState;
    desired_state: 'running' | 'stopped' | 'deleted';
    runtime: string;
    flavor: { vcpu: number; memoryGiB: number; diskGiB: number; gpus: number } | string;
    image: { url: string; sha256: string; format: 'raw' | 'qcow2' | 'iso' } | string | null;
    user_data: string | null;
    ssh_keys: string[];
    atoms: string[] | null;
  }>(
    `SELECT i.id, i.state, i.desired_state, i.runtime, i.flavor, i.image, i.user_data, i.ssh_keys, a.atoms
       FROM instances i LEFT JOIN allocations a ON a.id = i.allocation_id
      WHERE i.node_id = $1 AND i.state NOT IN ('deleted', 'pending', 'scheduling') AND NOT i.draft
      ORDER BY i.id`,
    [nodeId],
  );
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
    return [spec];
  });
}
