import {
  newId,
  type Allocation,
  type Device,
  type IdGenerator,
  type NodeView,
  type PlacementContext,
  type PlacementOutcome,
  type PlacementRequest,
  type SqlTx,
} from '@better-compute/core';
import { dedicatedTaint, dedicatedTaintPrefix } from './eligibility.js';
import { chooseGang, planGangs } from './gang.js';
import type { NodePlan } from './pipeline.js';
import { applyRollupDelta, rollupResource } from './rollup.js';
import { matchesSelector } from './selector.js';
import { lockPool, readDevices, readNodeLabels, type PoolRow } from './store.js';

// Whole-node leases (PLAN.md §13 dedicated-root, v0.5): a `binding: 'node'` reservation in a
// `tenantRoot` pool books every bookable atom of a `ready` node, and metal deploys the tenant's
// profile on it. The contract with metal is rows only, with no imports either way:
// - capacity enqueues `('metal', nodeId)` when the lease starts binding and when it is released;
// - metal marks the allocation bound (`bound_at`, `binding = {"node": true}`) once the deploy
//   completes and enqueues `('capacity.reservations', reservationId)`;
// - a node is leasable again only after metal returns it to `ready` with `trust = 'platform'`.

/** The work kind metal's node reconciler runs under. */
export const metalWork = 'metal';

/** How long metal has to deploy a leased node before the lease fails (not re-placed). */
export const nodeBindTimeoutMs = 2 * 3_600_000;

/** Whether a pool leases whole nodes (`policy.tenantRoot`). */
export function isTenantRootPool(pool: { policy?: unknown }): boolean {
  const policy = pool.policy;
  return (
    typeof policy === 'object' &&
    policy !== null &&
    (policy as Record<string, unknown>).tenantRoot === true
  );
}

/** The SQL predicate of a leasable node over `nodes n`. */
export const leasableSql = `n.provision_state = 'ready' AND NOT n.maintenance AND NOT n.cordoned
   AND n.trust = 'platform'`;

/**
 * `leasableSql` for one tenant's lease: a node dedicated to another tenant (§10.6
 * `dedicated=<tenant>`) is not leasable by it. `tolerated` is an SQL `text[]` expression bound to
 * `[dedicatedTaint(tenantId)]`.
 */
export function leasableSqlFor(tolerated: string): string {
  return `${leasableSql}
   AND NOT EXISTS (SELECT 1 FROM unnest(n.no_schedule_reasons) AS r(reason)
                    WHERE r.reason LIKE '${dedicatedTaintPrefix}%' AND NOT (r.reason = ANY(${tolerated})))`;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A node a lease could take, with every bookable atom it would book. */
export type LeaseFit = { nodeId: string; atoms: Device[] };

function fits(
  request: PlacementRequest,
  devices: readonly Device[],
  labels: Record<string, string>,
) {
  const taken = new Set<string>();
  for (const want of request.devices) {
    const candidates = devices.filter(
      (device) =>
        device.class === want.class &&
        device.bookable &&
        device.healthy &&
        !taken.has(device.id) &&
        matchesSelector(want.selector, { attributes: device.attributes, labels }),
    );
    if (candidates.length < want.count) return false;
    for (const device of candidates.slice(0, want.count)) taken.add(device.id);
  }
  return true;
}

/**
 * The nodes a lease could take in its window: leasable, no live allocation overlapping, healthy
 * atoms covering `request.devices`. Each comes with every bookable atom (what a lease books).
 */
export async function leaseCandidates(
  tx: SqlTx,
  poolId: string,
  request: PlacementRequest,
  excluded: readonly string[] = [],
): Promise<{ candidates: LeaseFit[]; labels: Map<string, Record<string, string>> }> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT n.id FROM nodes n
      WHERE n.pool_id = $1 AND ${leasableSqlFor('$5::text[]')} AND NOT (n.id = ANY($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.node_id = n.id AND a.released_at IS NULL
                           AND a.during && tstzrange($3::timestamptz, $4::timestamptz))
      ORDER BY n.id`,
    [
      poolId,
      [...excluded],
      iso(request.during.start),
      iso(request.during.end),
      [dedicatedTaint(request.tenantId)],
    ],
  );
  const only = request.onlyNodes ? new Set(request.onlyNodes) : undefined;
  const nodeIds = rows.map((row) => row.id).filter((id) => !only || only.has(id));
  const [devices, labels] = [await readDevices(tx, nodeIds), await readNodeLabels(tx, nodeIds)];
  const byNode = new Map<string, Device[]>();
  for (const device of devices)
    byNode.set(device.nodeId, [...(byNode.get(device.nodeId) ?? []), device]);
  const candidates = nodeIds
    .filter((nodeId) => fits(request, byNode.get(nodeId) ?? [], labels.get(nodeId) ?? {}))
    .map((nodeId) => ({
      nodeId,
      atoms: (byNode.get(nodeId) ?? []).filter((device) => device.bookable),
    }));
  return { candidates, labels };
}

/** Lease candidates grouped for a gang (or one group for a single node): the best choice, if any. */
export function leaseGroups(
  request: PlacementRequest,
  candidates: readonly LeaseFit[],
  labels: ReadonlyMap<string, Record<string, string>>,
): LeaseFit[] | undefined {
  return choose(request, candidates, labels, { random: () => 0, topN: 1 });
}

/**
 * Places a node lease: `gang.size` (default 1) leasable nodes of the pool that have no live booking
 * or allocation in the window and whose healthy atoms cover `request.devices`, all on one topology
 * value for gangs. Each node gets one allocation booking all its bookable atoms. Runs under the pool
 * lock; a node lost to a race is excluded and the plan retried, up to `maxAttempts`.
 */
export async function placeNodeLease(
  tx: SqlTx,
  request: PlacementRequest,
  context: Pick<PlacementContext, 'random' | 'topN'>,
  options: { maxAttempts?: number; ids?: IdGenerator } = {},
): Promise<PlacementOutcome> {
  const pool = await lockPool(tx, request.poolId);
  if (pool.archived) return { status: 'pending', reason: 'the pool is archived' };
  if (!isTenantRootPool(pool))
    return { status: 'pending', reason: 'the pool does not lease whole nodes (policy.tenantRoot)' };
  const ids = options.ids ?? newId;
  const excluded = new Set(request.excludeNodes ?? []);
  const conflicts: string[] = [];
  for (let attempt = 1; attempt <= (options.maxAttempts ?? 3); attempt++) {
    const { candidates, labels } = await leaseCandidates(tx, pool.id, request, [...excluded]);
    const chosen = choose(request, candidates, labels, context);
    if (!chosen) {
      const size = request.gang?.size ?? 1;
      const why =
        candidates.length < size
          ? `${candidates.length} leasable node(s) fit, ${size} needed`
          : `no ${size} leasable nodes share one ${request.gang?.topologyKey ?? 'pool'}`;
      return {
        status: 'pending',
        reason: conflicts.length ? `${why}; after conflicts: ${conflicts.join('; ')}` : why,
      };
    }
    const savepoint = `capacity_lease_${attempt}`;
    await tx.query(`SAVEPOINT ${savepoint}`);
    try {
      const allocations: Allocation[] = [];
      let lost: string | undefined;
      for (const fit of chosen) {
        const allocation = await commitLease(tx, request, pool, fit, ids);
        if (!allocation) {
          lost = fit.nodeId;
          break;
        }
        allocations.push(allocation);
      }
      if (lost) {
        await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
        conflicts.push(`${lost} was taken concurrently`);
        excluded.add(lost);
        continue;
      }
      await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
      return { status: 'placed', allocations };
    } catch (error) {
      await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
  return { status: 'pending', reason: `Unschedulable after conflicts: ${conflicts.join('; ')}` };
}

function choose(
  request: PlacementRequest,
  candidates: readonly LeaseFit[],
  labels: ReadonlyMap<string, Record<string, string>>,
  context: Pick<PlacementContext, 'random' | 'topN'>,
): LeaseFit[] | undefined {
  const byId = new Map(candidates.map((fit) => [fit.nodeId, fit]));
  if (request.gang === undefined) {
    const window = Math.min(Math.max(1, Math.floor(context.topN ?? 5)), candidates.length);
    if (window === 0) return undefined;
    const index = Math.min(window - 1, Math.floor(context.random() * window));
    return [candidates[index]!];
  }
  const ranked: NodePlan[] = candidates.map((fit) => ({
    nodeId: fit.nodeId,
    atoms: fit.atoms.map((atom) => atom.id),
    resources: {},
    scores: {},
    score: 0,
  }));
  const views = candidates.map(
    (fit) => ({ id: fit.nodeId, labels: labels.get(fit.nodeId) ?? {} }) as unknown as NodeView,
  );
  const gang = chooseGang(
    planGangs(ranked, views, request.gang).gangs,
    context.random,
    context.topN,
  );
  return gang?.members.map((member) => byId.get(member.nodeId)!);
}

/** Books one leased node; `undefined` when the node or an atom was lost to a race. */
async function commitLease(
  tx: SqlTx,
  request: PlacementRequest,
  pool: PoolRow,
  fit: LeaseFit,
  ids: IdGenerator,
): Promise<Allocation | undefined> {
  const node = await tx.query(
    `SELECT n.id FROM nodes n
      WHERE n.id = $1 AND n.pool_id = $2 AND ${leasableSqlFor('$3::text[]')} FOR SHARE OF n`,
    [fit.nodeId, pool.id, [dedicatedTaint(request.tenantId)]],
  );
  if (node.rows.length === 0) return undefined;
  const allocationId = ids('alloc');
  const atoms = fit.atoms.map((atom) => atom.id);
  if (atoms.length > 0) {
    const booked = await tx.query(
      `INSERT INTO device_bookings (device_id, allocation_id, during)
       SELECT unnest($1::text[]), $2, tstzrange($3::timestamptz, $4::timestamptz)
       ON CONFLICT DO NOTHING RETURNING device_id`,
      [atoms, allocationId, iso(request.during.start), iso(request.during.end)],
    );
    if (booked.rows.length !== atoms.length) return undefined;
  }
  const owner: Allocation['owner'] = { kind: 'reservation', id: request.reservationId! };
  const { rows } = await tx.query<{ current: boolean }>(
    `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, atoms,
                              resources, during, version)
     VALUES ($1, $2, $3, $4, 'reservation', $5, $6::text[], '{}'::jsonb,
             tstzrange($7::timestamptz, $8::timestamptz), 1)
     RETURNING during @> compute_now() AS current`,
    [
      allocationId,
      request.tenantId,
      pool.id,
      fit.nodeId,
      owner.id,
      atoms,
      iso(request.during.start),
      iso(request.during.end),
    ],
  );
  const current = rows[0]?.current === true;
  const perResource = new Map<string, number>();
  for (const atom of fit.atoms) {
    const resource = rollupResource(atom.class);
    perResource.set(resource, (perResource.get(resource) ?? 0) + 1);
  }
  for (const [resource, count] of perResource)
    await applyRollupDelta(
      tx,
      pool.id,
      resource,
      current ? { allocated: count } : { reserved: count },
    );
  return {
    id: allocationId,
    tenantId: request.tenantId,
    poolId: pool.id,
    nodeId: fit.nodeId,
    owner,
    atoms,
    resources: {},
    during: { ...request.during },
  };
}
