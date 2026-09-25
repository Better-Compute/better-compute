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
import {
  choosePlan,
  planPlacement,
  summarizeRejections,
  type NodePlan,
  type PlacementPlan,
} from './pipeline.js';
import type { PoolIndex } from './pool-index.js';
import { applyRollupDelta, rollupResource } from './rollup.js';
import { planFromShortlist, shortlistable, shortlistPlan } from './shortlist.js';
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
      const current = pool;
      return placeSingle(
        tx,
        request,
        async (without) => {
          const short = fast
            ? (await planFromShortlist(tx, current, request, without, context))?.plan
            : undefined;
          if (short) return short;
          views ??= await loadNodeViews(tx, current, request.during);
          return planPlacement({ ...request, excludeNodes: without }, views, current, {
            plugins: context.plugins,
            weights: context.weights,
          });
        },
        excluded,
        context,
        maxAttempts,
        ids,
        lock,
      );
    },
  });
}

/**
 * The v0.4 pool-lease placer (PLAN.md §10.3): a reservation is checked (pool, admission plugins)
 * and answered `queued`; the worker that owns the pool's shard places queued reservations in
 * batches of ≤64 against an in-memory index (`placeQueued`, work kind `capacity.placer`). The
 * admission transaction never takes the pool lock. Instances (which need an answer at once) and
 * gangs go through the inline placer.
 */
export function poolLeasePlacer(options: InlinePlacerOptions = {}): Placer {
  const inline = inlinePlacer(options);
  return Object.freeze({
    id: 'pool-lease',
    async place(
      tx: SqlTx,
      request: PlacementRequest,
      context: PlacementContext,
    ): Promise<PlacementOutcome> {
      if (request.reservationId === undefined || request.gang !== undefined)
        return inline.place(tx, request, context);
      assertPlacementRequest(request);
      const pool = await readPool(tx, request.poolId);
      if (!pool) throw new ComputeError('NOT_FOUND', `Pool ${request.poolId} not found`);
      if (pool.archived) return archived;
      if (context.admission)
        for (const plugin of context.plugins) await plugin.admit?.(request, context.admission);
      return { status: 'queued' };
    },
  });
}

/**
 * The single-node replan loop (§10.3): plan without the excluded nodes, pick among the top N, take
 * the pool lock (`lock`), commit with guarded statements; a lost race excludes that node and replans,
 * up to `maxAttempts` times, then `pending`.
 */
async function placeSingle(
  tx: SqlTx,
  request: PlacementRequest,
  plan: (excluded: string[]) => Promise<PlacementPlan>,
  excluded: Set<string>,
  context: PlacementContext,
  maxAttempts: number,
  ids: IdGenerator,
  lock: () => Promise<PoolRow | undefined>,
): Promise<PlacementOutcome> {
  const conflicts: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { ranked, rejected } = await plan([...excluded]);
    const choice = choosePlan(ranked, () => context.random(), context.topN);
    if (!choice) {
      const why = summarizeRejections(
        rejected.filter((rejection) => rejection.filter !== 'excluded' || conflicts.length === 0),
      );
      return {
        status: 'pending',
        reason: conflicts.length ? `${why}; after conflicts: ${conflicts.join('; ')}` : why,
      };
    }
    const current = await lock();
    if (!current) return archived;
    const result = await commitPlan(tx, request, current, choice, `capacity_place_${attempt}`, ids);
    if (result.ok) return { status: 'placed', allocations: [result.allocation] };
    conflicts.push(result.reason);
    excluded.add(choice.nodeId);
  }
  return {
    status: 'pending',
    reason: `Unschedulable after ${maxAttempts} conflicting attempts: ${conflicts.join('; ')}`,
  };
}

/**
 * Places one request against a `PoolIndex` (the v0.4 pool-lease placer's batch): views come from
 * memory, commits are the same guarded statements, and every committed allocation is recorded in
 * the index. The caller holds the pool lock for the batch.
 */
export async function placeFromIndex(
  tx: SqlTx,
  index: PoolIndex,
  request: PlacementRequest,
  context: PlacementContext,
  options: InlinePlacerOptions = {},
): Promise<PlacementOutcome> {
  assertPlacementRequest(request);
  if (request.gang !== undefined) assertGang(request.gang);
  const pool = index.pool;
  if (pool.archived) return archived;
  const maxAttempts = options.maxAttempts ?? 3;
  const ids = options.ids ?? newId;
  const excluded = new Set(request.excludeNodes ?? []);
  const lock = async () => pool;
  const outcome =
    request.gang !== undefined
      ? await placeGang(
          tx,
          request,
          request.gang,
          pool,
          index.views(request.during),
          excluded,
          context,
          maxAttempts,
          ids,
          lock,
        )
      : await placeSingle(
          tx,
          request,
          indexPlanner(index, request, context),
          excluded,
          context,
          maxAttempts,
          ids,
          lock,
        );
  if (outcome.status === 'placed')
    for (const allocation of outcome.allocations) index.record(allocation);
  return outcome;
}

/** Plans a single-node request on a `PoolIndex`: the exact shortlist when it decides, else every node. */
function indexPlanner(
  index: PoolIndex,
  request: PlacementRequest,
  context: Pick<PlacementContext, 'plugins' | 'weights' | 'topN'>,
): (excluded: string[]) => Promise<PlacementPlan> {
  const pool = index.pool;
  const fast = shortlistable(request, context.plugins);
  let whole: NodeView[] | undefined;
  return async (without) => {
    const short = fast
      ? await shortlistPlan(pool, request, without, context, {
          counts: () => index.counts(request, without),
          views: (nodeIds) => index.views(request.during, nodeIds),
          linked: () => index.linked(),
        })
      : undefined;
    return (
      short?.plan ??
      planPlacement(
        { ...request, excludeNodes: without },
        (whole ??= index.views(request.during)),
        pool,
        { plugins: context.plugins, weights: context.weights },
      )
    );
  };
}

/** Whether a request can go through `commitPlansBulk`: one node, devices only. */
export function bulkCommittable(request: PlacementRequest): boolean {
  return (
    request.gang === undefined &&
    request.reservationId !== undefined &&
    Object.values(request.resources ?? {}).every((amount) => !(amount > 0))
  );
}

/**
 * Plans one request on the index and records it there tentatively (for the requests planned after
 * it in the same batch). `undefined` when nothing fits; call `index.forget` if the commit fails.
 */
export async function planOnIndex(
  index: PoolIndex,
  request: PlacementRequest,
  context: PlacementContext,
): Promise<NodePlan | undefined> {
  assertPlacementRequest(request);
  const { ranked } = await indexPlanner(index, request, context)([...(request.excludeNodes ?? [])]);
  const choice = choosePlan(ranked, () => context.random(), context.topN);
  if (choice)
    index.record({
      nodeId: choice.nodeId,
      atoms: choice.atoms,
      resources: choice.resources,
      during: request.during,
    });
  return choice;
}

/** One planned request of a bulk commit. */
export interface BulkPlan {
  request: PlacementRequest;
  plan: NodePlan;
}

/**
 * Commits many planned single-node requests with set-based guarded statements (the pool-lease
 * batch, §10.3): the nodes are locked `FOR SHARE` under `schedulableSql` and the atoms `FOR SHARE`
 * where healthy and bookable, all at once; every booking is inserted in one statement (`ON CONFLICT
 * DO NOTHING` honours `EXCLUDE`); an allocation whose atoms did not all land is removed again;
 * allocations and rollup deltas are written in one statement each. Returns the allocation of each
 * plan that committed (by index) and why the others did not; the caller replans those. Runs in its
 * own savepoint, so a failure leaves nothing behind. The caller holds the pool lock.
 */
export async function commitPlansBulk(
  tx: SqlTx,
  pool: PoolRow,
  items: readonly BulkPlan[],
  ids: IdGenerator = newId,
): Promise<{ placed: Map<number, Allocation>; failed: Map<number, string> }> {
  const placed = new Map<number, Allocation>();
  const failed = new Map<number, string>();
  if (items.length === 0) return { placed, failed };
  await tx.query(`SAVEPOINT capacity_bulk`);
  try {
    const nodeIds = [...new Set(items.map((item) => item.plan.nodeId))];
    const nodes = await tx.query<{ id: string }>(
      `SELECT n.id FROM nodes n JOIN pools p ON p.id = n.pool_id
        WHERE n.id = ANY($1::text[]) AND n.pool_id = $2 AND ${schedulableSql}
        ORDER BY n.id FOR SHARE OF n`,
      [nodeIds, pool.id],
    );
    const okNodes = new Set(nodes.rows.map((row) => row.id));
    const atomIds = items.flatMap((item) => item.plan.atoms);
    const atoms = await tx.query<{ id: string; class: string }>(
      `SELECT id, class FROM devices WHERE id = ANY($1::text[]) AND healthy AND bookable
        ORDER BY id FOR SHARE`,
      [atomIds],
    );
    const classes = new Map(atoms.rows.map((row) => [row.id, row.class]));

    const allocationIds = new Map<number, string>();
    items.forEach((item, index) => {
      if (!okNodes.has(item.plan.nodeId))
        failed.set(index, `${item.plan.nodeId} is no longer schedulable`);
      else if (!item.plan.atoms.every((atom) => classes.has(atom)))
        failed.set(index, `an atom on ${item.plan.nodeId} turned unhealthy or unbookable`);
      else allocationIds.set(index, ids('alloc'));
    });

    const devices: string[] = [];
    const owners: string[] = [];
    const starts: string[] = [];
    const ends: string[] = [];
    for (const [index, allocationId] of allocationIds) {
      const { request, plan } = items[index]!;
      for (const atom of plan.atoms) {
        devices.push(atom);
        owners.push(allocationId);
        starts.push(iso(request.during.start));
        ends.push(iso(request.during.end));
      }
    }
    if (devices.length > 0) {
      const booked = await tx.query<{ allocation_id: string }>(
        `INSERT INTO device_bookings (device_id, allocation_id, during)
         SELECT d, a, tstzrange(s, e)
           FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[]) AS t(d, a, s, e)
         ON CONFLICT DO NOTHING RETURNING allocation_id`,
        [devices, owners, starts, ends],
      );
      const landed = new Map<string, number>();
      for (const row of booked.rows)
        landed.set(row.allocation_id, (landed.get(row.allocation_id) ?? 0) + 1);
      const partial: string[] = [];
      for (const [index, allocationId] of allocationIds)
        if ((landed.get(allocationId) ?? 0) !== items[index]!.plan.atoms.length) {
          failed.set(index, `an atom on ${items[index]!.plan.nodeId} was booked concurrently`);
          partial.push(allocationId);
          allocationIds.delete(index);
        }
      if (partial.length > 0)
        await tx.query(`DELETE FROM device_bookings WHERE allocation_id = ANY($1::text[])`, [
          partial,
        ]);
    }

    const rows = [...allocationIds].map(([index, allocationId]) => {
      const { request, plan } = items[index]!;
      return {
        id: allocationId,
        tenant: request.tenantId,
        node: plan.nodeId,
        owner: request.reservationId!,
        atoms: plan.atoms,
        s: iso(request.during.start),
        e: iso(request.during.end),
      };
    });
    if (rows.length > 0) {
      const inserted = await tx.query<{ id: string; current: boolean }>(
        `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, atoms,
                                  resources, during, version)
         SELECT x.id, x.tenant, $2, x.node, 'reservation', x.owner,
                ARRAY(SELECT jsonb_array_elements_text(x.atoms)), '{}'::jsonb,
                tstzrange(x.s, x.e), 1
           FROM jsonb_to_recordset($1::jsonb)
                AS x(id text, tenant text, node text, owner text, atoms jsonb, s timestamptz, e timestamptz)
         RETURNING id, during @> compute_now() AS current`,
        [JSON.stringify(rows), pool.id],
      );
      const current = new Map(inserted.rows.map((row) => [row.id, row.current === true]));
      const deltas = new Map<string, { allocated: number; reserved: number }>();
      for (const [index, allocationId] of allocationIds) {
        const { request, plan } = items[index]!;
        for (const atom of plan.atoms) {
          const resource = rollupResource(classes.get(atom)!);
          const delta = deltas.get(resource) ?? { allocated: 0, reserved: 0 };
          if (current.get(allocationId)) delta.allocated++;
          else delta.reserved++;
          deltas.set(resource, delta);
        }
        placed.set(index, {
          id: allocationId,
          tenantId: request.tenantId,
          poolId: pool.id,
          nodeId: plan.nodeId,
          owner: { kind: 'reservation', id: request.reservationId! },
          atoms: [...plan.atoms],
          resources: {},
          during: { ...request.during },
        });
      }
      for (const [resource, delta] of deltas)
        await applyRollupDelta(tx, pool.id, resource, {
          ...(delta.allocated ? { allocated: delta.allocated } : {}),
          ...(delta.reserved ? { reserved: delta.reserved } : {}),
        });
    }
    await tx.query(`RELEASE SAVEPOINT capacity_bulk`);
    return { placed, failed };
  } catch (error) {
    await tx.query(`ROLLBACK TO SAVEPOINT capacity_bulk`);
    await tx.query(`RELEASE SAVEPOINT capacity_bulk`);
    throw error;
  }
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
