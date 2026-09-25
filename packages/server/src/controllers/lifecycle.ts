import {
  ComputeError,
  commandTerminalStates,
  provisionStateTable,
  transition,
  type AcceptanceCheck,
  type CommandState,
  type ModuleContext,
  type PoolPolicy,
  type ProvisionState,
  type SqlTx,
  type WorkQueue,
} from '@better-compute/core';
import { decodeCommandResult, isCommandKind, type DiagNvmlRequest } from '@better-compute/protocol';
import {
  getCondition,
  mergeReasons,
  nodeSpecWorkKind,
  nodeWorkKind,
  refreshNodeAuthz,
  setCondition,
} from './node-state.js';

// NodeLifecycle (PLAN.md §3.3 step 7, §11.1): an adopting node runs its pool's acceptance checks
// (v0.1: `diag.nvml`) as commands. On pass it becomes `adopted` and the NodeSpec controller writes
// generation 1; on failure it keeps `adopting` with the `AcceptanceFailed` condition and a NoSchedule
// reason until an operator re-runs acceptance (`nodes.adopt` → `requestAcceptance`).
//
// The condition doubles as the controller's state, so a crash between steps loses nothing:
//   (none) | false | unknown/Requested → start the next attempt once the node is connected;
//   unknown/Running → wait for that attempt's commands to settle;
//   true → failed; wait for `requestAcceptance`.

/** The condition (and NoSchedule reason) of a failed acceptance. */
export const acceptanceCondition = 'AcceptanceFailed';
/** How long an acceptance command may wait for dispatch before it expires (`not_after`). */
export const acceptanceWindowMs = 10 * 60_000;

/** `acceptance:<nodeId>:<attempt>:<kind>` (unique per node, like every command idempotency key). */
export const acceptanceKey = (nodeId: string, attempt: number, kind: string): string =>
  `acceptance:${nodeId}:${attempt}:${kind}`;
const acceptancePrefix = (nodeId: string) => `acceptance:${nodeId}:`;

interface LifecycleRow {
  id: string;
  provision_state: ProvisionState;
  connectivity: string;
  role: string;
  pool_id: string | null;
  owner_tenant_id: string;
  no_schedule_reasons: string[];
  version: number;
  policy: PoolPolicy | null;
}

interface CommandRow {
  id: string;
  kind: string;
  state: CommandState;
  reason: string | null;
  idempotency_key: string;
  /** `\x…` hex of `commands.result` (core/0003), or null. */
  result: string | null;
}

/** The acceptance checks a node runs: its pool's, deduplicated by kind; none for site agents. */
export function acceptanceChecks(node: {
  role: string;
  pool_id: string | null;
  policy: PoolPolicy | null;
}): AcceptanceCheck[] {
  if (node.role === 'site' || !node.pool_id) return [];
  const seen = new Set<string>();
  const checks: AcceptanceCheck[] = [];
  for (const check of node.policy?.acceptance ?? [])
    if (check && typeof check.kind === 'string' && !seen.has(check.kind)) {
      seen.add(check.kind);
      checks.push(check);
    }
  return checks;
}

function attemptOf(key: string): number {
  const attempt = Number(key.split(':')[2]);
  return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
}

async function acceptanceCommands(tx: SqlTx, nodeId: string): Promise<CommandRow[]> {
  const prefix = acceptancePrefix(nodeId);
  const { rows } = await tx.query<CommandRow>(
    `SELECT c.id, c.kind, c.state, c.reason, c.idempotency_key, to_jsonb(c) ->> 'result' AS result
       FROM commands c
      WHERE c.node_id = $1 AND left(c.idempotency_key, length($2)) = $2`,
    [nodeId, prefix],
  );
  return rows;
}

const hexBytes = (value: string | null): Uint8Array | undefined =>
  value && value.startsWith('\\x') && value.length > 2
    ? new Uint8Array(Buffer.from(value.slice(2), 'hex'))
    : undefined;

/** Why one settled acceptance command failed, or undefined when it passed. */
function commandFailure(command: CommandRow): { reason: string; message: string } | undefined {
  if (command.state !== 'succeeded')
    return {
      reason: command.state === 'expired' ? 'Expired' : `${command.kind}:${command.state}`,
      message: `${command.kind} ${command.state}${command.reason ? `: ${command.reason}` : ''}`,
    };
  const bytes = hexBytes(command.result);
  if (command.kind !== 'diag.nvml' || !bytes) return undefined;
  try {
    const result = decodeCommandResult('diag.nvml', bytes);
    if (result.passed) return undefined;
    const failed =
      result.checks.find((check) => !check.passed)?.name ??
      result.gpus.find((gpu) => !gpu.passed)?.checks.find((check) => !check.passed)?.name ??
      'failed';
    return { reason: `diag.nvml:${failed}`, message: `diag.nvml failed ${failed}` };
  } catch {
    return { reason: 'diag.nvml:unreadable', message: 'diag.nvml returned an unreadable result' };
  }
}

/**
 * The command payload of a check. `diag.nvml` checks the GPUs inventory found (every visible GPU
 * before inventory arrived) against the pool's expected count; other kinds run with their default
 * message (their `with` arguments need the kind's own mapping, v0.2).
 */
async function checkPayload(
  tx: SqlTx,
  node: LifecycleRow,
  check: AcceptanceCheck,
): Promise<DiagNvmlRequest | undefined> {
  if (check.kind !== 'diag.nvml') return undefined;
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM devices WHERE node_id = $1 AND class = 'gpu' ORDER BY id`,
    [node.id],
  );
  const gpuUuids = rows.map((row) => row.id);
  const expect = (node.policy as { expect?: { gpuCount?: unknown } } | null)?.expect;
  const expectedGpuCount =
    typeof expect?.gpuCount === 'number' && Number.isSafeInteger(expect.gpuCount)
      ? expect.gpuCount
      : gpuUuids.length;
  return { $typeName: 'bettercompute.agent.v1.DiagNvmlRequest', gpuUuids, expectedGpuCount };
}

/** Whether a check's command kind exists: registered by a module, or built into the protocol. */
const knownKind = (context: ModuleContext, kind: string) =>
  context.registry.commandKind(kind) !== undefined || isCommandKind(kind);

/** What one lifecycle pass did, for the caller's own steps in the same transaction. */
export interface LifecyclePass {
  /** The node's authz projection row was refreshed (the caller need not refresh it again). */
  authzRefreshed?: boolean;
}

async function pass(context: ModuleContext, tx: SqlTx, node: LifecycleRow, reason: string, report?: LifecyclePass) {
  const next = transition(provisionStateTable, node.provision_state, 'complete');
  const reasons = mergeReasons(node.no_schedule_reasons, [], [acceptanceCondition]);
  const updated = await tx.query(
    `UPDATE nodes SET provision_state = $2, no_schedule_reasons = $3, version = version + 1
      WHERE id = $1 AND provision_state = $4 AND version = $5`,
    [node.id, next, reasons, node.provision_state, node.version],
  );
  if (updated.rowCount !== 1)
    throw new ComputeError('CONFLICT', `Node ${node.id} changed during acceptance`);
  await setCondition(tx, node.id, { type: acceptanceCondition, status: 'false', reason });
  // IAM sees the new lifecycle in the same transaction (§12.4).
  await refreshNodeAuthz(tx, context.authz, node.id);
  if (report) report.authzRefreshed = true;
  // NodeSpec writes generation 1 now that desired state applies (§3.3 step 7).
  await context.work.enqueue(tx, nodeSpecWorkKind, node.id);
  await context.events.publish(tx, {
    type: 'node.adopted',
    tenantId: node.owner_tenant_id,
    subject: `node/${node.id}`,
    data: { nodeId: node.id, reason },
  });
}

async function fail(
  context: ModuleContext,
  tx: SqlTx,
  node: LifecycleRow,
  failure: { reason: string; message: string; commandId?: string },
) {
  const reasons = mergeReasons(node.no_schedule_reasons, [acceptanceCondition], []);
  await tx.query('UPDATE nodes SET no_schedule_reasons = $2, version = version + 1 WHERE id = $1', [
    node.id,
    reasons,
  ]);
  await setCondition(tx, node.id, {
    type: acceptanceCondition,
    status: 'true',
    reason: failure.reason,
  });
  await context.events.publish(tx, {
    type: 'node.acceptance.failed',
    tenantId: node.owner_tenant_id,
    subject: `node/${node.id}`,
    data: {
      nodeId: node.id,
      reason: failure.reason,
      message: failure.message,
      ...(failure.commandId ? { commandId: failure.commandId } : {}),
    },
  });
}

/**
 * One NodeLifecycle pass over a node, in one transaction with the node row locked. Returns `DONE`
 * in every state: progress comes from the events that enqueue the `node` kind (Hello, settled or
 * swept commands, `requestAcceptance`).
 */
export async function reconcileLifecycle(
  context: ModuleContext,
  nodeId: string,
): Promise<'DONE' | 'SYNC_AGAIN'> {
  return context.sql.transaction((tx) => lifecycleIn(context, tx, nodeId));
}

/** One NodeLifecycle pass in the caller's transaction (the `node` reconciler's one transaction). */
export async function lifecycleIn(
  context: ModuleContext,
  tx: SqlTx,
  nodeId: string,
  report?: LifecyclePass,
): Promise<'DONE' | 'SYNC_AGAIN'> {
  {
    const { rows } = await tx.query<LifecycleRow>(
      `SELECT n.id, n.provision_state, n.connectivity, n.role, n.pool_id, n.owner_tenant_id,
              n.no_schedule_reasons, n.version, p.policy
         FROM nodes n LEFT JOIN pools p ON p.id = n.pool_id
        WHERE n.id = $1 FOR UPDATE OF n`,
      [nodeId],
    );
    const node = rows[0];
    if (!node || node.provision_state !== 'adopting') return 'DONE';
    node.version = Number(node.version);

    const checks = acceptanceChecks(node);
    if (checks.length === 0) {
      await pass(context, tx, node, 'NoChecks', report);
      return 'DONE';
    }
    const condition = await getCondition(tx, nodeId, acceptanceCondition);
    if (condition?.status === 'true') return 'DONE';

    const commands = await acceptanceCommands(tx, nodeId);
    const latest = commands.reduce((max, row) => Math.max(max, attemptOf(row.idempotency_key)), 0);
    const running = condition?.status === 'unknown' && condition.reason === 'Running';
    const current = commands.filter((row) => attemptOf(row.idempotency_key) === latest);

    if (running && current.length > 0) {
      if (current.some((row) => !commandTerminalStates.has(row.state))) return 'DONE';
      for (const command of current.sort((a, b) => a.kind.localeCompare(b.kind))) {
        const failure = commandFailure(command);
        if (failure) {
          await fail(context, tx, node, { ...failure, commandId: command.id });
          return 'DONE';
        }
      }
      await pass(context, tx, node, 'Passed', report);
      return 'DONE';
    }

    // Start the next attempt; the checks need a connected node (Hello enqueues this kind).
    if (node.connectivity !== 'connected') return 'DONE';
    const unsupported = checks.filter((check) => !knownKind(context, check.kind));
    if (unsupported.length) {
      await fail(context, tx, node, {
        reason: 'UnsupportedCheck',
        message: `acceptance check ${unsupported.map((check) => check.kind).join(', ')} is not a registered command kind`,
      });
      return 'DONE';
    }
    const attempt = latest + 1;
    const notAfter = context.clock.now() + acceptanceWindowMs;
    const started: string[] = [];
    for (const check of checks) {
      const command = await context.commands.enqueue(tx, {
        nodeId,
        kind: check.kind,
        payload: await checkPayload(tx, node, check),
        idempotencyKey: acceptanceKey(nodeId, attempt, check.kind),
        notAfter,
      });
      started.push(command.id);
    }
    await setCondition(tx, nodeId, {
      type: acceptanceCondition,
      status: 'unknown',
      reason: 'Running',
    });
    await context.events.publish(tx, {
      type: 'node.acceptance.started',
      tenantId: node.owner_tenant_id,
      subject: `node/${nodeId}`,
      data: { nodeId, attempt, commandIds: started, checks: checks.map((check) => check.kind) },
    });
    return 'DONE';
  }
}

/**
 * Asks NodeLifecycle for a new acceptance attempt, in the caller's transaction, after the caller
 * applied the `adopt` verb itself (`nodes.adopt`). Without it a node whose acceptance failed keeps
 * waiting: the failure is sticky until someone asks again.
 */
export async function markAcceptanceRequested(
  tx: SqlTx,
  work: WorkQueue,
  nodeId: string,
): Promise<void> {
  await setCondition(tx, nodeId, {
    type: acceptanceCondition,
    status: 'unknown',
    reason: 'Requested',
  });
  await work.enqueue(tx, nodeWorkKind, nodeId);
}

/**
 * Re-runs acceptance (`nodes.adopt`, a reclaimed identity): applies the `adopt` verb, which throws
 * `INVALID_STATE` from any state but `adopting` and `adopted`, marks acceptance requested and wakes
 * the node reconciler. Runs in the caller's transaction.
 */
export async function requestAcceptance(
  tx: SqlTx,
  work: WorkQueue,
  nodeId: string,
): Promise<{ provisionState: ProvisionState }> {
  const { rows } = await tx.query<{ provision_state: ProvisionState }>(
    'SELECT provision_state FROM nodes WHERE id = $1 FOR UPDATE',
    [nodeId],
  );
  const row = rows[0];
  if (!row) throw new ComputeError('NOT_FOUND', `Node ${nodeId} does not exist`);
  const next = transition(provisionStateTable, row.provision_state, 'adopt');
  await tx.query('UPDATE nodes SET provision_state = $2, version = version + 1 WHERE id = $1', [
    nodeId,
    next,
  ]);
  await markAcceptanceRequested(tx, work, nodeId);
  return { provisionState: next };
}
