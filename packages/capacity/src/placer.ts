import {
  ComputeError,
  newId,
  type Allocation,
  type GangSpec,
  type IdGenerator,
  type NodeView,
  type PlacementContext,
  type PlacementOutcome,
  type PlacementRequest,
  type Placer,
  type SqlTx,
} from '@better-compute/core';
import { schedulableSql } from './eligibility.js';
import { assertGang, chooseGang, maxGangSize, planGangs } from './gang.js';
import { choosePlan, planPlacement, summarizeRejections, type NodePlan } from './pipeline.js';
import { applyRollupDelta, rollupResource } from './rollup.js';
import { planFromShortlist, shortlistable } from './shortlist.js';
import { loadNodeViews, lockPool, readPool, type PoolRow } from './store.js';

export interface InlinePlacerOptions {
  /** Placement attempts before the request goes `pending` (PLAN.md §10.3: ≤3). */
  maxAttempts?: number;
  /** Allocation ids (default `newId`); the simulator passes a seeded generator. */
  ids?: IdGenerator;
}

const maxDevicesPerRequest = 64;

/** Rejects malformed requests before any lock is taken. */
export function assertPlacementRequest(request: PlacementRequest): void {
  const fail = (message: string): never => {
    throw new ComputeError('INVALID_INPUT', message);
  };
  if ((request.reservationId === undefined) === (request.instanceId === undefined))
    fail('A placement belongs to exactly one reservation or instance');
  if (!Array.isArray(request.devices)) fail('devices must be a list');
  let total = 0;
  for (const device of request.devices) {
    if (!Number.isSafeInteger(device.count) || device.count < 1)
      fail(`Device count must be a positive integer (${device.class})`);
    total += device.count;
  }
  if (total > maxDevicesPerRequest) fail(`At most ${maxDevicesPerRequest} devices per placement`);
  for (const [resource, amount] of Object.entries(request.resources ?? {}))
    if (!Number.isSafeInteger(amount) || amount < 0)
      fail(`Resource ${resource} must be a non-negative integer`);
  if (total === 0 && Object.values(request.resources ?? {}).every((amount) => amount === 0))
    fail('A placement must claim at least one device or resource');
  const { start, end } = request.during ?? ({} as PlacementRequest['during']);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    fail('during must be a non-empty interval');
}

const archived: PlacementOutcome = Object.freeze({
  status: 'pending',
  reason: 'the pool is archived',
}) as PlacementOutcome;

type Commit = { ok: true; allocation: Allocation } | { ok: false; reason: string };

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Writes one plan inside its own savepoint (§10.3). Every statement is guarded: it
 * returns fewer rows instead of raising, so a lost race rolls back to the savepoint and the
 * admission transaction lives on to replan.
 */
async function commitPlan(
  tx: SqlTx,
  request: PlacementRequest,
  pool: PoolRow,
  plan: NodePlan,
  savepoint: string,
  ids: IdGenerator,
): Promise<Commit> {
  await tx.query(`SAVEPOINT ${savepoint}`);
  const conflict = async (reason: string): Promise<Commit> => {
    await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    return { ok: false, reason };
  };
  try {
    // Linearizes with cordon, taint and liveness writes, which update these node columns.
    const node = await tx.query(
      `SELECT n.id FROM nodes n JOIN pools p ON p.id = n.pool_id
        WHERE n.id = $1 AND n.pool_id = $2 AND ${schedulableSql}
          FOR SHARE OF n`,
      [plan.nodeId, pool.id],
    );
    if (node.rows.length === 0) return conflict(`${plan.nodeId} is no longer schedulable`);

    const atoms = plan.atoms;
    const classes = new Map<string, string>();
    if (atoms.length > 0) {
      // Linearizes with the healthy=false quarantine update.
      const locked = await tx.query<{ id: string; class: string }>(
        `SELECT id, class FROM devices
          WHERE id = ANY($1::text[]) AND node_id = $2 AND healthy AND bookable FOR SHARE`,
        [atoms, plan.nodeId],
      );
      if (locked.rows.length !== atoms.length)
        return conflict(`an atom on ${plan.nodeId} turned unhealthy or unbookable`);
      for (const row of locked.rows) classes.set(row.id, row.class);
    }

    const allocationId = ids('alloc');
    if (atoms.length > 0) {
      // ON CONFLICT DO NOTHING without a target honours the EXCLUDE constraint.
      const booked = await tx.query(
        `INSERT INTO device_bookings (device_id, allocation_id, during)
         SELECT unnest($1::text[]), $2, tstzrange($3::timestamptz, $4::timestamptz)
         ON CONFLICT DO NOTHING RETURNING device_id`,
        [atoms, allocationId, iso(request.during.start), iso(request.during.end)],
      );
      if (booked.rows.length !== atoms.length)
        return conflict(`an atom on ${plan.nodeId} was booked concurrently`);
    }

    for (const [resource, amount] of Object.entries(plan.resources)) {
      if (amount <= 0) continue;
      const claimed = await tx.query(
        `UPDATE node_resources SET allocated = allocated + $3
          WHERE node_id = $1 AND resource = $2 AND allocated + $3 <= floor(allocatable * ratio)
          RETURNING allocated`,
        [plan.nodeId, resource, amount],
      );
      if (claimed.rows.length === 0) return conflict(`${resource} on ${plan.nodeId} ran out`);
    }

    const owner: Allocation['owner'] =
      request.reservationId !== undefined
        ? { kind: 'reservation', id: request.reservationId }
        : { kind: 'instance', id: request.instanceId! };
    const { rows } = await tx.query<{ current: boolean }>(
      `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, atoms,
                                resources, during, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::jsonb,
               tstzrange($9::timestamptz, $10::timestamptz), 1)
       RETURNING during @> compute_now() AS current`,
      [
        allocationId,
        request.tenantId,
        pool.id,
        plan.nodeId,
        owner.kind,
        owner.id,
        atoms,
        JSON.stringify(plan.resources),
        iso(request.during.start),
        iso(request.during.end),
      ],
    );

    const perResource = new Map<string, number>();
    for (const atom of atoms) {
      const resource = rollupResource(classes.get(atom)!);
      perResource.set(resource, (perResource.get(resource) ?? 0) + 1);
    }
    const current = rows[0]?.current === true;
    for (const [resource, count] of perResource)
      await applyRollupDelta(
        tx,
        pool.id,
        resource,
        current ? { allocated: count } : { reserved: count },
      );

    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    return {
      ok: true,
      allocation: {
        id: allocationId,
        tenantId: request.tenantId,
        poolId: pool.id,
        nodeId: plan.nodeId,
        owner,
        atoms: [...atoms],
        resources: { ...plan.resources },
        during: { ...request.during },
      },
    };
  } catch (error) {
    await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

/**
 * The v0.1 placer (PLAN.md §10.3): runs in the admission transaction. Plans on plain reads (from a
 * SQL shortlist of the pool when that decides exactly, else the whole pool), then takes the pool row
 * lock and commits the chosen node with guarded statements; on a lost race it replans without that
 * node, up to `maxAttempts` times, then answers `pending`.
 * Quota is not charged here (see `chargeQuota`): a `pending` reservation keeps its charge (D9).
 */
export function inlinePlacer(options: InlinePlacerOptions = {}): Placer {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw new ComputeError('INVALID_CONFIG', 'maxAttempts must be a positive integer');
  const ids = options.ids ?? newId;
  return Object.freeze({
    id: 'inline',
    async place(
      tx: SqlTx,
      request: PlacementRequest,
      context: PlacementContext,
    ): Promise<PlacementOutcome> {
      assertPlacementRequest(request);
      if (request.gang !== undefined) assertGang(request.gang);
      // Plans on plain reads; the pool row lock is taken only before the first guarded commit, which
      // re-validates node, atoms and scalars, so the critical section is the commit alone.
      let pool = await readPool(tx, request.poolId);
      if (!pool) throw new ComputeError('NOT_FOUND', `Pool ${request.poolId} not found`);
      if (pool.archived) return archived;
      if (context.admission)
        for (const plugin of context.plugins) await plugin.admit?.(request, context.admission);
      let locked = false;
      const lock = async (): Promise<PoolRow | undefined> => {
        if (!locked) {
          pool = await lockPool(tx, request.poolId);
          locked = true;
        }
        return pool!.archived ? undefined : pool!;
      };

      const excluded = new Set(request.excludeNodes ?? []);
      if (request.gang !== undefined)
        return placeGang(
          tx,
          request,
          request.gang,
          pool,
          await loadNodeViews(tx, pool, request.during),
          excluded,
          context,
          maxAttempts,
          ids,
          lock,
        );
      const fast = shortlistable(request, context.plugins);
      let views: NodeView[] | undefined;
      const conflicts: string[] = [];
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let plan = fast
          ? (await planFromShortlist(tx, pool, request, [...excluded], context))?.plan
          : undefined;
        if (!plan) {
          views ??= await loadNodeViews(tx, pool, request.during);
          plan = planPlacement({ ...request, excludeNodes: [...excluded] }, views, pool, {
            plugins: context.plugins,
            weights: context.weights,
          });
        }
        const { ranked, rejected } = plan;
        const choice = choosePlan(ranked, () => context.random(), context.topN);
        if (!choice) {
          const why = summarizeRejections(
            rejected.filter(
              (rejection) => rejection.filter !== 'excluded' || conflicts.length === 0,
            ),
          );
          return {
            status: 'pending',
            reason: conflicts.length ? `${why}; after conflicts: ${conflicts.join('; ')}` : why,
          };
        }
        const current = await lock();
        if (!current) return archived;
        const result = await commitPlan(
          tx,
          request,
          current,
          choice,
          `capacity_place_${attempt}`,
          ids,
        );
        if (result.ok) return { status: 'placed', allocations: [result.allocation] };
        conflicts.push(result.reason);
        excluded.add(choice.nodeId);
      }
      return {
        status: 'pending',
        reason: `Unschedulable after ${maxAttempts} conflicting attempts: ${conflicts.join('; ')}`,
      };
    },
  });
}

/**
 * Places a gang (§10.3, v0.5): plans every node for the per-node request, groups the fits by the
 * topology key, picks a group, and commits all its members inside one outer savepoint. A lost race
 * on any member rolls the whole gang back and replans without that node, up to `maxAttempts`.
 */
async function placeGang(
  tx: SqlTx,
  request: PlacementRequest,
  gang: GangSpec,
  pool: PoolRow,
  views: Awaited<ReturnType<typeof loadNodeViews>>,
  excluded: Set<string>,
  context: PlacementContext,
  maxAttempts: number,
  ids: IdGenerator,
  lock: () => Promise<PoolRow | undefined>,
): Promise<PlacementOutcome> {
  if (gang.size > maxGangSize) throw new ComputeError('INVALID_INPUT', 'gang too large');
  const conflicts: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { ranked, rejected } = planPlacement(
      { ...request, excludeNodes: [...excluded] },
      views,
      pool,
      {
        plugins: context.plugins,
        weights: context.weights,
      },
    );
    const { gangs, reason } = planGangs(ranked, views, gang);
    const choice = chooseGang(gangs, () => context.random(), context.topN);
    if (!choice) {
      const why =
        ranked.length === 0
          ? summarizeRejections(rejected)
          : rejected.length > 0
            ? `${reason!}; ${summarizeRejections(rejected)}`
            : reason!;
      return {
        status: 'pending',
        reason: conflicts.length ? `${why}; after conflicts: ${conflicts.join('; ')}` : why,
      };
    }
    const current = await lock();
    if (!current) return archived;
    pool = current;
    const outer = `capacity_gang_${attempt}`;
    await tx.query(`SAVEPOINT ${outer}`);
    const allocations: Allocation[] = [];
    let lost: { nodeId: string; reason: string } | undefined;
    try {
      for (const [index, member] of choice.members.entries()) {
        const result = await commitPlan(
          tx,
          request,
          pool,
          member,
          `capacity_place_${attempt}_${index}`,
          ids,
        );
        if (!result.ok) {
          lost = { nodeId: member.nodeId, reason: result.reason };
          break;
        }
        allocations.push(result.allocation);
      }
    } catch (error) {
      await tx.query(`ROLLBACK TO SAVEPOINT ${outer}`);
      await tx.query(`RELEASE SAVEPOINT ${outer}`);
      throw error;
    }
    if (lost) {
      await tx.query(`ROLLBACK TO SAVEPOINT ${outer}`);
      await tx.query(`RELEASE SAVEPOINT ${outer}`);
      conflicts.push(lost.reason);
      excluded.add(lost.nodeId);
      continue;
    }
    await tx.query(`RELEASE SAVEPOINT ${outer}`);
    return { status: 'placed', allocations };
  }
  return {
    status: 'pending',
    reason: `Unschedulable after ${maxAttempts} conflicting gang attempts: ${conflicts.join('; ')}`,
  };
}
