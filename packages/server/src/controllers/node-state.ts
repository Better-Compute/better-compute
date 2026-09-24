import type { AuthzRow, AuthzWriter, Condition, SqlTx } from '@better-compute/core';

// Shared pieces of the node controllers (PLAN.md §8.4): work kinds, conditions and the
// `no_schedule_reasons` column every writer shares.

/**
 * Work kind of the node reconciler (NodeLifecycle + the event side of Liveness). The gateway
 * enqueues it on connect, disconnect, settled commands and status reports; keys are node ids.
 */
export const nodeWorkKind = 'node';
/** Work kind of the NodeSpec reconciler (`DesiredState.invalidate`, the placer); keys are node ids. */
export const nodeSpecWorkKind = 'nodespec';
/** Work kind of the Drain controller (`nodes.drain`); keys are node ids. */
export const drainWorkKind = 'drain';
/** The `no_schedule_reasons` entry of a drain in progress; `nodes.uncordon` clears it. */
export const drainingReason = 'draining';

/**
 * Upserts a `node_conditions` row. `since` moves only when the status changes, as the Inventory
 * reconciler writes it.
 */
export async function setCondition(
  tx: SqlTx,
  nodeId: string,
  condition: Pick<Condition, 'type' | 'status'> & { reason?: string | undefined },
): Promise<void> {
  await tx.query(
    `INSERT INTO node_conditions (node_id, type, status, reason, since)
     VALUES ($1, $2, $3, $4, compute_now())
     ON CONFLICT (node_id, type) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason,
       since = CASE WHEN node_conditions.status = EXCLUDED.status THEN node_conditions.since
                    ELSE EXCLUDED.since END`,
    [nodeId, condition.type, condition.status, condition.reason ?? null],
  );
}

/** One condition of a node, or undefined. */
export async function getCondition(
  tx: SqlTx,
  nodeId: string,
  type: string,
): Promise<{ status: Condition['status']; reason: string | null; since: number } | undefined> {
  const { rows } = await tx.query<{
    status: Condition['status'];
    reason: string | null;
    since: Date;
  }>('SELECT status, reason, since FROM node_conditions WHERE node_id = $1 AND type = $2', [
    nodeId,
    type,
  ]);
  const row = rows[0];
  return row && { status: row.status, reason: row.reason, since: toMs(row.since)! };
}

/**
 * `no_schedule_reasons` with `add` added and `remove` removed; every other entry (taints, other
 * controllers' conditions) is kept. Sorted and duplicate-free, like the Inventory reconciler's.
 */
export function mergeReasons(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): string[] {
  const removed = new Set(remove);
  return [...new Set([...current.filter((reason) => !removed.has(reason)), ...add])].sort();
}

export const sameReasons = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((reason, index) => reason === [...b].sort()[index]);

/**
 * How a node looks to IAM in its owner tenant's view (§12.3 `compute-node`, §12.4): parent pool,
 * lifecycle, trust, region and GPUs. JoinService writes it at join; `nodes.adopt` and the node
 * reconciler keep it current (the writer skips rows that did not change).
 */
export async function nodeAuthzRow(tx: SqlTx, nodeId: string): Promise<AuthzRow | undefined> {
  const { rows } = await tx.query<{
    owner_tenant_id: string;
    pool_id: string | null;
    provision_state: string;
    trust: string;
    region: string;
    gpu_model: string | null;
    gpus: unknown;
  }>(
    `SELECT n.owner_tenant_id, n.pool_id, n.provision_state, n.trust, s.region, p.gpu_model,
       (SELECT count(*) FROM devices d WHERE d.node_id = n.id AND d.class = 'gpu') AS gpus
     FROM nodes n JOIN sites s ON s.id = n.site_id LEFT JOIN pools p ON p.id = n.pool_id
     WHERE n.id = $1`,
    [nodeId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const authz: AuthzRow = {
    type: 'node',
    id: nodeId,
    tenantId: row.owner_tenant_id,
    attributes: {
      region: row.region,
      gpuCount: Number(row.gpus),
      lifecycle: row.provision_state,
      trust: row.trust,
      ...(row.gpu_model === null ? {} : { gpuModel: row.gpu_model }),
    },
  };
  if (row.pool_id !== null) {
    authz.parentType = 'pool';
    authz.parentId = row.pool_id;
  }
  return authz;
}

/** Writes the node's current projection row in `tx` (no change, no write). */
export async function refreshNodeAuthz(
  tx: SqlTx,
  authz: AuthzWriter,
  nodeId: string,
): Promise<void> {
  const row = await nodeAuthzRow(tx, nodeId);
  if (row) await authz.upsert(tx, row);
}

/** Epoch milliseconds of a timestamp column (`Date` from the drivers, text from `to_jsonb`). */
export function toMs(value: Date | string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? undefined : time;
}
