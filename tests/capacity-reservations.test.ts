import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apiMethod,
  ComputeError,
  draftId,
  fleetResourceId,
  manualClock,
  type AuthzAttributes,
  type AuthzRow,
  type Caller,
  type ManualClock,
  type MethodContext,
  type ModuleContext,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  capacityMigrations,
  capacityModule,
  createCapacityPort,
  deviceAssignments,
  deviceLimitsCapabilityLabel,
  kubernetesBindingCapabilityLabel,
  assignmentLimits,
  formatCpuList,
  parseCpuList,
  activeRecheckMs,
  cancelPendingReservation,
  capacityTenantDeleted,
  finishStaleReleases,
  markAllocationBound,
  placeablePending,
  readReservationsBy,
  reservationAuthzRow,
  markAllocationFailed,
  markAllocationReleased,
  meterReservations,
  readQuotas,
  reservationWork,
  maxStuckCarryMs,
  stuckReleaseStepMs,
  wakePendingForNode,
  wakeStartedOnNode,
  type AllocationBindingCheck,
  type CapacityApi,
} from '@better-compute/capacity';

// Reservations end to end below the envelope (PLAN.md §3.4, §10.5): admission prepare/deny, placement
// in transaction 2, the lifecycle reconciler, extend/renew/release/cancel, and the pools, capacity
// and quotas groups — against PGlite with recording fakes for the ModuleContext seams.

const T0 = Date.UTC(2026, 8, 24, 12);
const HOUR = 3_600_000;
let db: SqlExecutor;
let clock: ManualClock;

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations]);
});
afterAll(async () => {
  await db.close();
});

interface Recorded {
  authz: AuthzRow[];
  pending: { id: string; pending: AuthzAttributes | null }[];
  removed: { type: string; id: string; tenantId?: string }[];
  events: { type: string; subject: string; data: unknown }[];
  work: { kind: string; key: string; notBefore?: number }[];
  invalidated: string[];
}
let recorded: Recorded;

const caller: Caller = {
  identityId: 'usr_alice',
  identityKind: 'user',
  tenantId: 'acme',
  sessionId: 'ses_1',
  sessionKind: 'user',
  mfa: false,
};

function moduleContext(sql: SqlExecutor): ModuleContext {
  return {
    sql,
    clock,
    authz: {
      async upsert(_tx, row) {
        recorded.authz.push(row);
      },
      async remove(_tx, ref) {
        recorded.removed.push(ref);
      },
      async setPending(_tx, ref, pending) {
        recorded.pending.push({ id: ref.id, pending });
      },
    },
    events: {
      async publish(_tx, event) {
        recorded.events.push({ type: event.type, subject: event.subject, data: event.data });
      },
    },
    work: {
      async enqueue(_tx, kind, key, options) {
        recorded.work.push({
          kind,
          key,
          ...(options?.notBefore !== undefined ? { notBefore: options.notBefore } : {}),
        });
      },
    },
    desired: {
      async invalidate(_tx, nodeId) {
        recorded.invalidated.push(nodeId);
      },
    },
    iam: {
      async billingCheck(input: { tenantId: string; identityId?: string }) {
        billingChecks.push(input);
        return billing;
      },
    },
  } as unknown as ModuleContext;
}

/** What `iam.billingCheck` answers (the admission's budget check), and who asked. */
let billing: {
  allowed: boolean;
  budgets: unknown[];
  blockedBy?: { budgetId: string; name: string };
} = {
  allowed: true,
  budgets: [],
};
const billingChecks: { tenantId: string; identityId?: string }[] = [];

/** The executor handlers see inside the envelope's transaction. */
function within(tx: SqlTx): SqlExecutor {
  return {
    dialect: 'postgres',
    kind: 'pglite',
    query: (text, params) => tx.query(text, params),
    transaction: (fn, options) => db.transaction(fn, options),
    migrate: () => Promise.reject(new Error('no')),
    close: () => Promise.reject(new Error('no')),
  };
}

const module = capacityModule({ random: () => 0, topN: 1 });
const api = module.api!(moduleContext(db)) as CapacityApi;

/** Runs a method the way the envelope does: validate, (prepare → decide → handler | denied). */
async function call<G extends keyof CapacityApi, M extends keyof CapacityApi[G]>(
  group: G,
  method: M,
  raw: unknown,
  options: {
    deny?: boolean | ComputeError;
    who?: Caller;
    api?: CapacityApi;
    admission?: MethodContext['admission'];
    requestId?: string;
  } = {},
): Promise<unknown> {
  const definition = ((options.api ?? api)[group] as Record<string, CapacityApi[G][M]>)[
    method as string
  ] as unknown as {
    validate(raw: unknown): unknown;
    handler(context: MethodContext, input: unknown): Promise<unknown>;
    admission?: {
      prepare(
        context: MethodContext,
        input: unknown,
        tx: SqlTx,
      ): Promise<{ status: string; result?: unknown }>;
      denied?(context: MethodContext, input: unknown, tx: SqlTx, error: unknown): Promise<void>;
      check?(context: MethodContext, input: unknown, resource: unknown): Promise<void>;
    };
  };
  const input = definition.validate(raw);
  const who = options.who ?? caller;
  const context = (tx: SqlTx) =>
    ({
      ...moduleContext(within(tx)),
      caller: who,
      requestId: options.requestId ?? 'req_1',
      ...(options.admission ? { admission: options.admission } : {}),
    }) as MethodContext;
  if (definition.admission) {
    const plan = await db.transaction((tx) =>
      definition.admission!.prepare(context(tx), input, tx),
    );
    if (plan.status === 'replay') return plan.result;
    if (options.deny) {
      const refusal =
        options.deny instanceof ComputeError
          ? options.deny
          : new ComputeError('ACCESS_DENIED', 'Access denied');
      await db.transaction(
        (tx) =>
          definition.admission!.denied?.(context(tx), input, tx, refusal) ?? Promise.resolve(),
      );
      throw refusal;
    }
    // After an allowed decision, with no transaction open: a throw refuses, `denied` is not called.
    await definition.admission.check?.(
      { ...moduleContext(db), caller: who, requestId: options.requestId ?? 'req_1' } as MethodContext,
      input,
      (plan as { resource?: unknown }).resource,
    );
  }
  return db.transaction((tx) => definition.handler(context(tx), input));
}

async function reconcile(key: string): Promise<void> {
  const reconciler = module.reconcilers!.find((entry) => entry.name === reservationWork)!;
  await reconciler.run({ ...moduleContext(db), signal: new AbortController().signal }, key);
}

async function advance(ms: number): Promise<void> {
  clock.advance(ms);
  await setSimClock(db, clock.now());
}

const tables = [
  'usage_windows',
  'capacity_device_links',
  'pool_capacity_rollup',
  'device_bookings',
  'allocations',
  'reservations',
  'node_resources',
  'devices',
  'quota_usage',
  'node_labels',
  'node_inventory',
  'inventory_snapshots',
  'nodes',
  'pool_offers',
  'pools',
  'sites',
];

let poolId: string;
beforeEach(async () => {
  for (const table of tables) await db.query(`DELETE FROM ${table}`);
  recorded = { authz: [], pending: [], removed: [], events: [], work: [], invalidated: [] };
  clock = manualClock(T0);
  await useSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_01jz00000000000000000000aa', 'root', 'shared', 'eu-central', 1)`,
  );
  const pool = (await call(
    'pools',
    'create',
    {
      tenantId: 'root',
      siteId: 'site_01jz00000000000000000000aa',
      class: 'metal-host',
      gpuModel: 'H100',
    },
    { who: { ...caller, tenantId: 'root', identityId: 'usr_root' } },
  )) as { id: string };
  poolId = pool.id;
  await call(
    'pools',
    'offer',
    { tenantId: 'root', poolId, toTenantId: 'acme', quota: { gpu: 8 } },
    {
      who: { ...caller, tenantId: 'root', identityId: 'usr_root' },
    },
  );
  await addNode('node_01jz00000000000000000000na', 4);
  await addNode('node_01jz00000000000000000000nb', 4);
  recorded = { authz: [], pending: [], removed: [], events: [], work: [], invalidated: [] };
});

async function addNode(id: string, gpus: number): Promise<void> {
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
                        cordoned, connectivity, trust, generation, observed_generation, next_cmd_seq,
                        identity_gen, shard, version)
     VALUES ($1, 'site_01jz00000000000000000000aa', $2, 'root', 'host', 'adopted', false, false,
             'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
    [id, poolId],
  );
  for (let index = 0; index < gpus; index++)
    await db.query(
      `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
       VALUES ($1, $2, 'gpu', true, true, '{"gpuModel":"H100","vramGiB":80}')`,
      [`GPU-${id.slice(-2)}-${index}`, id],
    );
}

const create = (extra: Record<string, unknown> = {}) => ({
  tenantId: 'acme',
  poolId,
  devices: [{ class: 'gpu', count: 2 }],
  duration: '2h',
  idempotencyKey: 'key-1',
  ...extra,
});

type Rsv = {
  id: string;
  state: string;
  during?: { start: number; end: number };
  conditions: { type: string }[];
  binding?: unknown;
  leaseExpiresAt?: number;
};

describe('capacityModule API surface', () => {
  it('matches the §9.2 rows: action, kind and module for every method', () => {
    for (const [group, methods] of Object.entries(api))
      for (const [method, definition] of Object.entries(
        methods as Record<string, { action: string; kind: string }>,
      )) {
        const row = apiMethod(group, method);
        expect(row, `${group}.${method}`).toBeDefined();
        expect(row!.module, `${group}.${method}`).toBe('capacity');
        expect(definition.action, `${group}.${method}`).toBe(row!.action);
        expect(definition.kind, `${group}.${method}`).toBe(row!.kind);
      }
  });

  it('lets a platform site’s pool join only a cluster the platform operates (review M4)', async () => {
    const who = { who: { ...caller, tenantId: 'root', identityId: 'usr_root' } };
    const join = {
      apiServer: 'https://k8s.example:6443',
      caCertSha256: `sha256:${'ab'.repeat(32)}`,
      joinTokenRef: 'secret://root/k8s-join',
    };
    const base = { tenantId: 'root', siteId: 'site_01jz00000000000000000000aa', class: 'metal-host' };
    await expect(
      call('pools', 'create', { ...base, policy: { kubernetes: join } }, who),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('platformOperated') });
    const pool = (await call(
      'pools',
      'create',
      { ...base, policy: { kubernetes: { ...join, platformOperated: true } } },
      who,
    )) as { id: string };
    await expect(
      call('pools', 'update', { tenantId: 'root', poolId: pool.id, policy: { kubernetes: join } }, who),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // Hosted mode (no join set) needs no confirmation.
    await call('pools', 'update', { tenantId: 'root', poolId: pool.id, policy: { kubernetes: {} } }, who);
  });

  it('runs the pool-policy validators on pools.create and pools.update', async () => {
    const seen: unknown[] = [];
    const checked = capacityModule({
      policyValidators: [
        {
          extension: 'pool-policy',
          id: 'test.hugepages',
          async validate(policy, pool) {
            seen.push({ policy, pool });
            if (policy.hugepages !== undefined) throw new Error('hugepages.count must be > 0');
          },
        },
      ],
    }).api!(moduleContext(db)) as CapacityApi;
    const who = { who: { ...caller, tenantId: 'root', identityId: 'usr_root' }, api: checked };
    const base = { tenantId: 'root', siteId: 'site_01jz00000000000000000000aa', class: 'metal-host' };
    await expect(
      call('pools', 'create', { ...base, policy: { hugepages: { size: '1Gi', count: 0 } } }, who),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'policy: hugepages.count must be > 0' });
    const pool = (await call('pools', 'create', { ...base, sharing: 'mig' }, who)) as { id: string };
    expect(seen.at(-1)).toEqual({ policy: {}, pool: { class: 'metal-host', sharing: 'mig' } });
    await expect(
      call(
        'pools',
        'update',
        { tenantId: 'root', poolId: pool.id, policy: { hugepages: { size: '2Mi', count: 0 } } },
        who,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('declares its migration, reconcilers and a devices node spec', () => {
    expect(module.name).toBe('capacity');
    expect(module.migrations!.map((migration) => migration.name)).toEqual([
      'capacity/0001_device_links',
      'capacity/0002_lease_health',
      'capacity/0003_device_counts',
      'capacity/0004_mig_layouts',
      'capacity/0005_extend_holds',
    ]);
    expect(module.reconcilers!.map((reconciler) => reconciler.name)).toEqual([
      reservationWork,
      'capacity.rollup',
      'capacity.usage',
      // §3.8: every host's vcpu/memoryGiB/hugepages from inventory.
      'capacity.hosts',
      'capacity.mig',
    ]);
    expect(module.reconcilers![1]!.periodic).toEqual([{ key: 'all', every: '5m' }]);
    // A deleted tenant's teardown (§12.8) goes through capacityTenantDeleted.
    expect(module.tenantDeleted).toBeTypeOf('function');
  });
});

describe('reservations.create', () => {
  it('decides on a deterministic draft, places in transaction 2, and replays by key', async () => {
    const first = (await call('reservations', 'create', create())) as Rsv;
    expect(first).toMatchObject({ state: 'placed', during: { start: T0, end: T0 + 2 * HOUR } });
    expect(first.id).toMatch(/^rsv_[0-9a-z]{52}$/);
    expect(recorded.authz.at(-1)).toMatchObject({
      type: 'reservation',
      id: first.id,
      tenantId: 'acme',
      parentType: 'pool',
      parentId: poolId,
      ownerId: 'usr_alice',
      attributes: {
        gpuModel: 'H100',
        gpuCount: 2,
        durationHours: 2,
        region: 'eu-central',
        binding: 'hold',
        spot: false,
      },
    });
    expect(recorded.events.map((event) => event.type)).toEqual(['reservation.placed']);
    expect(recorded.work).toEqual([{ kind: reservationWork, key: first.id, notBefore: T0 }]);
    expect((await readQuotas(db, 'acme', poolId))[0]).toMatchObject({ used: 2, max: 8 });

    const replay = (await call(
      'reservations',
      'create',
      create({ wait: { timeoutMs: 1000 } }),
    )) as Rsv;
    expect(replay).toMatchObject({ id: first.id, state: 'placed' });
    expect((await readQuotas(db, 'acme', poolId))[0]!.used).toBe(2);

    await expect(call('reservations', 'create', create({ duration: '3h' }))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const other = (await call('reservations', 'create', create(), {
      who: { ...caller, identityId: 'usr_bob' },
    })) as Rsv;
    expect(other.id).not.toBe(first.id);
  });

  it('marks a refused draft denied and keeps refusing that key', async () => {
    await expect(call('reservations', 'create', create(), { deny: true })).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    const { rows } = await db.query<{ state: string }>(`SELECT state FROM reservations`);
    expect(rows).toEqual([{ state: 'denied' }]);
    await expect(call('reservations', 'create', create())).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    expect((await readQuotas(db, 'acme', poolId))[0]!.used).toBe(0);
  });

  it('refuses over quota with QUOTA_EXCEEDED and leaves the draft', async () => {
    await expect(
      call('reservations', 'create', create({ devices: [{ class: 'gpu', count: 9 }] })),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', details: { max: 8, requested: 9 } });
    const { rows } = await db.query<{ state: string }>(`SELECT state FROM reservations`);
    expect(rows).toEqual([{ state: 'draft' }]);
  });

  it('hides pools that are not offered to the tenant, and validates input', async () => {
    await expect(
      call('reservations', 'create', create({ tenantId: 'other', idempotencyKey: 'k2' })),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    for (const bad of [
      create({ duration: '10s' }),
      create({ devices: [] }),
      create({ devices: [{ class: 'tpu', count: 1 }] }),
      create({ extra: true }),
      create({ poolId: 'nope' }),
      create({ idempotencyKey: '' }),
    ])
      await expect(call('reservations', 'create', bad)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    await expect(call('reservations', 'create', create({ spot: 'yes' }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      call('reservations', 'create', create({ binding: 'instance' })),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });

  it('goes pending with Unschedulable when nothing fits, and places on a later retry', async () => {
    await db.query(`UPDATE nodes SET cordoned = true`);
    const pending = (await call('reservations', 'create', create())) as Rsv;
    expect(pending.state).toBe('pending');
    expect(pending.conditions).toMatchObject([
      { type: 'Unschedulable', status: 'true', reason: 'NoFit' },
    ]);
    expect(recorded.work.at(-1)).toEqual({
      kind: reservationWork,
      key: pending.id,
      notBefore: T0 + 30_000,
    });
    expect((await readQuotas(db, 'acme', poolId))[0]!.used).toBe(2);

    await advance(30_000);
    await reconcile(pending.id);
    expect(
      ((await call('reservations', 'get', { tenantId: 'acme', reservationId: pending.id })) as Rsv)
        .state,
    ).toBe('pending');

    await db.query(`UPDATE nodes SET cordoned = false`);
    await advance(30_000);
    await reconcile(pending.id);
    const placed = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: pending.id,
    })) as Rsv;
    expect(placed).toMatchObject({
      state: 'placed',
      conditions: [],
      during: { start: T0 + 60_000, end: T0 + 60_000 + 2 * HOUR },
    });
  });

  it('reports each reservation’s async operation (§9.1): succeeded, pending, running, failed', async () => {
    await db.query(`UPDATE quota_usage SET max = 100`);
    const placed = (await call('reservations', 'create', create({ idempotencyKey: 'op1' }))) as Rsv;
    expect(placed.operation).toEqual({ id: placed.id, state: 'succeeded' });
    const big = (await call(
      'reservations',
      'create',
      create({ devices: [{ class: 'gpu', count: 64 }], idempotencyKey: 'op2' }),
    )) as Rsv;
    expect(big.operation).toEqual({ id: big.id, state: 'pending' });
    const queued = (await call('reservations', 'create', create({ idempotencyKey: 'op3' }), {
      api: capacityModule({ placer: 'pool-lease' }).api!(moduleContext(db)) as CapacityApi,
    })) as Rsv;
    expect(queued.operation).toEqual({ id: queued.id, state: 'running' });
    const cancelled = (await call('reservations', 'cancel', {
      tenantId: 'acme',
      reservationId: big.id,
    })) as Rsv;
    expect(cancelled.operation).toMatchObject({
      state: 'failed',
      error: { code: 'INVALID_STATE' },
    });
  });

  it('cancels unstarted reservations on the system’s behalf, and selects them by agent (IAM reactions)', async () => {
    await db.query(`UPDATE quota_usage SET max = 100`);
    const agent = {
      ...caller,
      identityKind: 'agent' as const,
      agentId: 'agt_1',
      delegationId: 'dlg_1',
    };
    const byAgent = (await call('reservations', 'create', create({ idempotencyKey: 'ag1' }), {
      who: agent,
    })) as Rsv;
    const mine = (await call('reservations', 'create', create({ idempotencyKey: 'me1' }))) as Rsv;
    const deps = { ...moduleContext(db) } as unknown as Parameters<
      typeof cancelPendingReservation
    >[0];
    await db.transaction(async (tx) => {
      const rows = await readReservationsBy(tx, 'acme', ['pending', 'placed'], {
        agentId: 'agt_1',
      });
      expect(rows.map((row) => row.id)).toEqual([byAgent.id]);
      expect(
        (await readReservationsBy(tx, 'acme', ['placed'], { anyAgent: true })).map((r) => r.id),
      ).toEqual([byAgent.id]);
      const cancelled = await cancelPendingReservation(deps, tx, rows[0]!, 'agent suspended');
      expect(cancelled.state).toBe('cancelled');
      // Idempotent, and started or terminal ones come back unchanged.
      expect((await cancelPendingReservation(deps, tx, cancelled, 'again')).state).toBe(
        'cancelled',
      );
      const authz = await reservationAuthzRow(tx, rows[0]!, 'usr_successor');
      expect(authz).toMatchObject({
        type: 'reservation',
        id: byAgent.id,
        parentId: poolId,
        ownerId: 'usr_successor',
        attributes: { gpuCount: 2 },
      });
    });
    expect(recorded.events.filter((event) => event.type === 'reservation.cancelled')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ reason: 'agent suspended' }) }),
    ]);
    // The quota and the bookings came back; the owner's own reservation is untouched.
    const { rows } = await db.query(
      `SELECT 1 FROM allocations WHERE owner_id = $1 AND released_at IS NULL`,
      [byAgent.id],
    );
    expect(rows).toEqual([]);
    expect(
      ((await call('reservations', 'get', { tenantId: 'acme', reservationId: mine.id })) as Rsv)
        .state,
    ).toBe('placed');
  });

  it('tears a deleted tenant down: reservations ended, offers withdrawn, owned pools archived (§12.8)', async () => {
    await db.query(`UPDATE quota_usage SET max = 100`);
    const placed = (await call('reservations', 'create', create({ idempotencyKey: 't1' }))) as Rsv;
    const pending = (await call(
      'reservations',
      'create',
      create({ devices: [{ class: 'gpu', count: 64 }], idempotencyKey: 't2' }),
    )) as Rsv;
    await advance(0);
    await reconcile(placed.id); // → binding
    const context = moduleContext(db);
    expect(await capacityTenantDeleted(context, 'acme')).toBe('DONE');
    const state = async (id: string) =>
      (await db.query<{ state: string }>(`SELECT state FROM reservations WHERE id = $1`, [id]))
        .rows[0]!.state;
    expect(await state(placed.id)).toBe('released');
    expect(await state(pending.id)).toBe('cancelled');
    const { rows: offers } = await db.query(`SELECT 1 FROM pool_offers WHERE tenant_id = 'acme'`);
    expect(offers).toEqual([]);
    const { rows: quotas } = await db.query(`SELECT 1 FROM quota_usage WHERE tenant_id = 'acme'`);
    expect(quotas).toEqual([]);
    expect(recorded.removed).toContainEqual({ type: 'pool', id: poolId, tenantId: 'acme' });
    // The pool is root's: it stays, unarchived.
    const { rows: pool } = await db.query<{ archived: boolean }>(
      `SELECT archived_at IS NOT NULL AS archived FROM pools WHERE id = $1`,
      [poolId],
    );
    expect(pool[0]!.archived).toBe(false);
    // Idempotent.
    expect(await capacityTenantDeleted(context, 'acme')).toBe('DONE');

    // Root deleted: its pool is archived, offers to everyone withdrawn.
    await db.query(`INSERT INTO pool_offers (pool_id, tenant_id) VALUES ($1, 'beta')`, [poolId]);
    expect(await capacityTenantDeleted(context, 'root')).toBe('DONE');
    const { rows: archived } = await db.query<{ archived: boolean }>(
      `SELECT archived_at IS NOT NULL AS archived FROM pools WHERE id = $1`,
      [poolId],
    );
    expect(archived[0]!.archived).toBe(true);
    const { rows: left } = await db.query(`SELECT 1 FROM pool_offers WHERE pool_id = $1`, [poolId]);
    expect(left).toEqual([]);
    expect(recorded.events.map((event) => event.type)).toContain('pool.archived');
  });

  it('finds pending reservations an offline solver could place (I7)', async () => {
    await db.query(`UPDATE quota_usage SET max = 100`);
    const first = (await call(
      'reservations',
      'create',
      create({ devices: [{ class: 'gpu', count: 4 }], idempotencyKey: 'f1' }),
    )) as Rsv;
    await call(
      'reservations',
      'create',
      create({ devices: [{ class: 'gpu', count: 4 }], idempotencyKey: 'f2' }),
    );
    const waiting = (await call('reservations', 'create', create({ idempotencyKey: 'w' }))) as Rsv;
    expect(waiting.state).toBe('pending');
    expect(await placeablePending(db, { now: T0 })).toEqual([]);
    // Capacity frees up behind the scheduler's back (no wake-up): the waiting one now fits.
    await db.query(
      `DELETE FROM device_bookings WHERE allocation_id IN (SELECT id FROM allocations WHERE owner_id = $1)`,
      [first.id],
    );
    await db.query(`UPDATE allocations SET released_at = compute_now() WHERE owner_id = $1`, [
      first.id,
    ]);
    expect(await placeablePending(db, { now: T0, poolId })).toEqual([
      { reservationId: waiting.id, poolId, nodeIds: [expect.any(String)] },
    ]);
    expect(
      await placeablePending(db, { now: T0, poolId: 'pool_01jz00000000000000000000zz' }),
    ).toEqual([]);
    await reconcile(waiting.id);
    expect(
      ((await call('reservations', 'get', { tenantId: 'acme', reservationId: waiting.id })) as Rsv)
        .state,
    ).toBe('placed');
    expect(await placeablePending(db, { now: T0 })).toEqual([]);
  });

  it('fails a reservation pending longer than maxPending and refunds its quota', async () => {
    await db.query(`UPDATE pools SET policy = '{"maxPending": "10m"}'`);
    await db.query(`UPDATE nodes SET cordoned = true`);
    const pending = (await call('reservations', 'create', create())) as Rsv;
    await advance(11 * 60_000);
    await reconcile(pending.id);
    const failed = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: pending.id,
    })) as Rsv;
    expect(failed.state).toBe('failed');
    expect(failed.conditions).toMatchObject([
      { type: 'Unschedulable', reason: 'MaxPendingExceeded' },
    ]);
    expect((await readQuotas(db, 'acme', poolId))[0]!.used).toBe(0);
  });
});

describe('the reservation lifecycle', () => {
  it('starts, binds, goes active, expires and releases', async () => {
    const created = (await call('reservations', 'create', create({ start: T0 + HOUR }))) as Rsv;
    expect(recorded.work.at(-1)!.notBefore).toBe(T0 + HOUR);
    await reconcile(created.id);
    // BookingRepair looks again 15 minutes before the start.
    expect(recorded.work.at(-1)).toMatchObject({ notBefore: T0 + 45 * 60_000 });

    await advance(HOUR);
    await reconcile(created.id);
    const binding = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: created.id,
    })) as Rsv;
    expect(binding.state).toBe('binding');
    const node = recorded.invalidated.at(-1)!;
    const [assignment] = await deviceAssignments(db, node);
    expect(assignment).toMatchObject({ until: T0 + 3 * HOUR });
    expect(assignment!.deviceIds).toHaveLength(2);
    const spec = await module.nodeSpec!(moduleContext(db), { id: node } as never);
    expect(spec.devices!.assignments).toEqual([assignment]);

    await db.transaction((tx) =>
      markAllocationBound(tx, moduleContext(db).work, assignment!.allocationId, {
        cdiDevices: ['nvidia.com/gpu=0', 'nvidia.com/gpu=1'],
        envFile: '/run/bcd/alloc.env',
      }),
    );
    await reconcile(created.id);
    const active = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: created.id,
    })) as Rsv;
    expect(active).toMatchObject({
      state: 'active',
      binding: {
        nodeId: node,
        cdiDevices: ['nvidia.com/gpu=0', 'nvidia.com/gpu=1'],
        envFile: '/run/bcd/alloc.env',
      },
    });

    await advance(2 * HOUR);
    await reconcile(created.id);
    const released = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: created.id,
    })) as Rsv;
    expect(released.state).toBe('released');
    expect(recorded.events.map((event) => event.type)).toEqual([
      'reservation.placed',
      'reservation.binding',
      'reservation.active',
      'reservation.released',
    ]);
    expect((await readQuotas(db, 'acme', poolId))[0]!.used).toBe(0);
    expect(await deviceAssignments(db, node)).toEqual([]);
  });

  it('marks an active reservation Degraded and NodeUnreachable from its node, and never releases it (P6)', async () => {
    const created = (await call('reservations', 'create', create())) as Rsv;
    await reconcile(created.id); // → binding
    const { rows } = await db.query<{ id: string; node_id: string; atoms: string[] }>(
      `SELECT id, node_id, atoms FROM allocations WHERE owner_id = $1`,
      [created.id],
    );
    const allocation = rows[0]!;
    await db.transaction((tx) =>
      markAllocationBound(tx, moduleContext(db).work, allocation.id, { cdiDevices: ['a'] }),
    );
    await reconcile(created.id); // → active
    const conditions = async () =>
      ((await call('reservations', 'get', { tenantId: 'acme', reservationId: created.id })) as Rsv)
        .conditions;

    await db.query(`UPDATE devices SET healthy = false WHERE id = $1`, [allocation.atoms[0]]);
    await db.query(`UPDATE nodes SET connectivity = 'lost' WHERE id = $1`, [allocation.node_id]);
    recorded.work = [];
    expect(
      await db.transaction((tx) =>
        wakeStartedOnNode(tx, moduleContext(db).work, allocation.node_id),
      ),
    ).toBe(1);
    expect(recorded.work).toEqual([{ kind: reservationWork, key: created.id }]);
    await reconcile(created.id);
    expect(await conditions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'Degraded',
          reason: 'AtomUnhealthy',
          message: `unhealthy: ${allocation.atoms[0]}`,
        }),
        expect.objectContaining({ type: 'NodeUnreachable', message: allocation.node_id }),
      ]),
    );
    // Conditions only: the booking stays, and the next look is the recheck.
    const { rows: live } = await db.query(
      `SELECT 1 FROM allocations WHERE id = $1 AND released_at IS NULL`,
      [allocation.id],
    );
    expect(live).toHaveLength(1);
    expect(recorded.work.at(-1)).toMatchObject({
      key: created.id,
      notBefore: T0 + activeRecheckMs,
    });

    await db.query(`UPDATE devices SET healthy = true WHERE id = $1`, [allocation.atoms[0]]);
    await db.query(`UPDATE nodes SET connectivity = 'connected' WHERE id = $1`, [
      allocation.node_id,
    ]);
    await reconcile(created.id);
    expect((await conditions()).map((condition) => condition.type)).not.toEqual(
      expect.arrayContaining(['Degraded']),
    );
    expect((await conditions()).map((condition) => condition.type)).not.toContain(
      'NodeUnreachable',
    );

    // GPUs exposed outside bcd on its node (review 2, M4): Degraded while the condition holds.
    await db.query(
      `INSERT INTO node_conditions (node_id, type, status, reason, since)
       VALUES ($1, 'ForeignGpuExposure', 'true', 'nvidia.com/gpu allocatable', compute_now())`,
      [allocation.node_id],
    );
    await reconcile(created.id);
    expect(await conditions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'Degraded', reason: 'ForeignGpuExposure' }),
      ]),
    );
    await db.query(`DELETE FROM node_conditions WHERE node_id = $1`, [allocation.node_id]);
    await reconcile(created.id);
    expect((await conditions()).map((condition) => condition.type)).not.toContain('Degraded');
  });

  it('re-places after a bind timeout, and fails after the retries run out', async () => {
    const created = (await call('reservations', 'create', create())) as Rsv;
    await reconcile(created.id); // → binding
    for (let attempt = 1; attempt <= 2; attempt++) {
      await advance(5 * 60_000);
      await reconcile(created.id); // bind timeout → pending
      const pending = (await call('reservations', 'get', {
        tenantId: 'acme',
        reservationId: created.id,
      })) as Rsv;
      expect(pending.state).toBe('pending');
      await reconcile(created.id); // → placed (starts now)
      await reconcile(created.id); // → binding
    }
    await advance(5 * 60_000);
    await reconcile(created.id);
    const failed = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: created.id,
    })) as Rsv;
    expect(failed.state).toBe('failed');
    expect(failed.conditions).toMatchObject([{ type: 'BindTimeout', message: '3' }]);
    const { rows } = await db.query(
      `SELECT 1 FROM device_bookings WHERE upper(during) > compute_now()`,
    );
    expect(rows).toEqual([]);
  });

  it('releases early, truncating the booking, and is idempotent', async () => {
    const created = (await call('reservations', 'create', create())) as Rsv;
    await advance(15 * 60_000);
    const released = (await call('reservations', 'release', {
      tenantId: 'acme',
      reservationId: created.id,
    })) as Rsv;
    expect(released.state).toBe('released');
    const again = (await call('reservations', 'release', {
      tenantId: 'acme',
      reservationId: created.id,
    })) as Rsv;
    expect(again.state).toBe('released');
    const { rows } = await db.query<{ end_ms: number }>(
      `SELECT (extract(epoch FROM upper(during)) * 1000)::float8 AS end_ms FROM device_bookings`,
    );
    expect(rows.map((row) => row.end_ms)).toEqual([T0 + 15 * 60_000, T0 + 15 * 60_000]);
  });

  it('cancels pending and not-yet-started reservations only', async () => {
    const later = (await call('reservations', 'create', create({ start: T0 + HOUR }))) as Rsv;
    const cancelled = (await call('reservations', 'cancel', {
      tenantId: 'acme',
      reservationId: later.id,
    })) as Rsv;
    expect(cancelled.state).toBe('cancelled');
    expect((await db.query(`SELECT 1 FROM device_bookings`)).rows).toEqual([]);
    const now = (await call('reservations', 'create', create({ idempotencyKey: 'key-2' }))) as Rsv;
    await reconcile(now.id);
    await expect(
      call('reservations', 'cancel', { tenantId: 'acme', reservationId: now.id }),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('extends through the pending projection, and reports the reachable end on a conflict', async () => {
    const created = (await call(
      'reservations',
      'create',
      create({ devices: [{ class: 'gpu', count: 4 }] }),
    )) as Rsv;
    const extended = (await call('reservations', 'extend', {
      tenantId: 'acme',
      reservationId: created.id,
      by: '1h',
      idempotencyKey: 'ext-1',
    })) as { extended: boolean; reservation: Rsv };
    expect(extended.extended).toBe(true);
    expect(extended.reservation.during).toEqual({ start: T0, end: T0 + 3 * HOUR });
    expect(recorded.pending).toEqual([
      { id: created.id, pending: { durationHours: 3, gpuCount: 4, idempotencyKey: 'ext-1' } },
      { id: created.id, pending: null },
    ]);
    expect(recorded.authz.at(-1)!.attributes.durationHours).toBe(3);

    // Every GPU of both nodes is booked from T0+4h: the extension can reach T0+4h only.
    await db.query(`UPDATE quota_usage SET max = 100`);
    for (const key of ['blocker-a', 'blocker-b']) {
      const blocker = (await call(
        'reservations',
        'create',
        create({
          start: T0 + 4 * HOUR,
          devices: [{ class: 'gpu', count: 4 }],
          idempotencyKey: key,
        }),
      )) as Rsv;
      expect(blocker.state).toBe('placed');
    }
    const blocked = (await call('reservations', 'extend', {
      tenantId: 'acme',
      reservationId: created.id,
      until: T0 + 6 * HOUR,
      idempotencyKey: 'ext-2',
    })) as { extended: boolean; availableUntil?: number; reservation: Rsv };
    expect(blocked).toMatchObject({ extended: false, availableUntil: T0 + 4 * HOUR });
    expect(blocked.reservation.during!.end).toBe(T0 + 3 * HOUR);
    expect(recorded.pending.at(-1)).toEqual({ id: created.id, pending: null });

    // An `until` already reached replays without a decision.
    const replay = (await call('reservations', 'extend', {
      tenantId: 'acme',
      reservationId: created.id,
      until: T0 + 2 * HOUR,
      idempotencyKey: 'ext-3',
    })) as { extended: boolean };
    expect(replay.extended).toBe(false);
    await expect(
      call('reservations', 'extend', {
        tenantId: 'acme',
        reservationId: created.id,
        by: '1h',
        until: 5,
        idempotencyKey: 'x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('decides one extend at a time: a concurrent one never replaces the duration being decided', async () => {
    const created = (await call('reservations', 'create', create())) as Rsv;
    const extend = api.reservations.extend as unknown as {
      validate(raw: unknown): unknown;
      handler(context: MethodContext, input: unknown): Promise<unknown>;
      admission: {
        prepare(context: MethodContext, input: unknown, tx: SqlTx): Promise<unknown>;
        abandoned(context: MethodContext, input: unknown, tx: SqlTx, error: unknown): Promise<void>;
      };
    };
    const as = (tx: SqlTx, requestId: string) =>
      ({ ...moduleContext(within(tx)), caller, requestId }) as MethodContext;
    const input = (by: string, key: string) =>
      extend.validate({ tenantId: 'acme', reservationId: created.id, by, idempotencyKey: key });
    const long = input('8h', 'long');
    const short = input('1h', 'short');
    recorded.pending = [];
    await db.transaction((tx) => extend.admission.prepare(as(tx, 'req-same'), long, tx));
    // Every call shares one request id (callers choose it): the hold is the admission's own nonce.
    // A (short) must not overwrite B's (long) pending duration while B is decided.
    await expect(
      db.transaction((tx) => extend.admission.prepare(as(tx, 'req-same'), short, tx)),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'extend-in-flight' } });
    await db.transaction((tx) => extend.admission.abandoned(as(tx, 'req-same'), short, tx, 'x'));
    expect(recorded.pending).toHaveLength(1);
    expect(recorded.pending[0]!.pending).toMatchObject({ durationHours: 10 });
    const done = (await db.transaction((tx) => extend.handler(as(tx, 'req-same'), long))) as {
      extended: boolean;
    };
    expect(done.extended).toBe(true);
    expect(recorded.pending.at(-1)).toEqual({ id: created.id, pending: null });

    // A stalled extend is taken over after a minute; its late transaction 2 then applies nothing.
    const stalled = input('1h', 'stalled');
    await db.transaction((tx) => extend.admission.prepare(as(tx, 'req-same'), stalled, tx));
    await advance(61_000);
    const next = input('2h', 'next');
    await db.transaction((tx) => extend.admission.prepare(as(tx, 'req-same'), next, tx));
    recorded.pending = [];
    await expect(
      db.transaction((tx) => extend.handler(as(tx, 'req-same'), stalled)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await db.transaction((tx) => extend.admission.abandoned(as(tx, 'req-same'), stalled, tx, 'x'));
    expect(recorded.pending).toEqual([]);
    await db.transaction((tx) => extend.handler(as(tx, 'req-same'), next));
    expect(recorded.pending.at(-1)).toEqual({ id: created.id, pending: null });
    expect((await db.query(`SELECT 1 FROM capacity_extend_holds`)).rows).toEqual([]);
  });

  it('renews leases and releases a lapsed renewable reservation', async () => {
    const created = (await call('reservations', 'create', create({ leaseSeconds: 300 }))) as Rsv;
    expect(created.leaseExpiresAt).toBe(T0 + 300_000);
    await advance(200_000);
    const renewed = (await call('reservations', 'renew', {
      tenantId: 'acme',
      reservationId: created.id,
    })) as Rsv;
    expect(renewed.leaseExpiresAt).toBe(T0 + 500_000);
    await advance(301_000);
    await reconcile(created.id);
    const lapsed = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: created.id,
    })) as Rsv;
    expect(lapsed.state).toBe('released');
    const plain = (await call(
      'reservations',
      'create',
      create({ idempotencyKey: 'plain' }),
    )) as Rsv;
    await expect(
      call('reservations', 'renew', { tenantId: 'acme', reservationId: plain.id }),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('lists a tenant’s reservations newest first with a cursor', async () => {
    for (const key of ['a', 'b', 'c'])
      await call(
        'reservations',
        'create',
        create({ idempotencyKey: key, devices: [{ class: 'gpu', count: 1 }] }),
      );
    const first = (await call('reservations', 'list', { tenantId: 'acme', limit: 2 })) as {
      items: Rsv[];
      cursor?: string;
    };
    expect(first.items).toHaveLength(2);
    expect(first.cursor).toBe(first.items[1]!.id);
    const second = (await call('reservations', 'list', {
      tenantId: 'acme',
      limit: 2,
      cursor: first.cursor,
    })) as { items: Rsv[]; cursor?: string };
    expect(second.items).toHaveLength(1);
    expect(second.cursor).toBeUndefined();
    const none = (await call('reservations', 'list', { tenantId: 'acme', state: 'released' })) as {
      items: Rsv[];
    };
    expect(none.items).toEqual([]);
  });
});

describe('pools, capacity and quotas', () => {
  const root = { ...caller, tenantId: 'root', identityId: 'usr_root' };

  it('shows owned and offered pools with the caller’s quotas', async () => {
    const acme = (await call('pools', 'list', { tenantId: 'acme' })) as {
      items: { id: string; owned: boolean; quotas: { resource: string; max: number }[] }[];
    };
    expect(acme.items).toMatchObject([
      { id: poolId, owned: false, quotas: [{ resource: 'gpu', max: 8 }] },
    ]);
    const mine = (await call('pools', 'get', { tenantId: 'root', poolId }, { who: root })) as {
      owned: boolean;
    };
    expect(mine.owned).toBe(true);
    await expect(call('pools', 'get', { tenantId: 'other', poolId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses offers of pools with tenant-owned nodes, and unoffers without touching live bookings', async () => {
    const booked = (await call('reservations', 'create', create())) as Rsv;
    const removed = (await call(
      'pools',
      'unoffer',
      { tenantId: 'root', poolId, toTenantId: 'acme' },
      { who: root },
    )) as { removed: boolean };
    expect(removed.removed).toBe(true);
    expect(recorded.removed).toEqual([{ type: 'pool', id: poolId, tenantId: 'acme' }]);
    expect((await readQuotas(db, 'acme', poolId))[0]).toMatchObject({ max: 2, used: 2 });
    expect(
      ((await call('reservations', 'get', { tenantId: 'acme', reservationId: booked.id })) as Rsv)
        .state,
    ).toBe('placed');

    await db.query(
      `UPDATE nodes SET trust = 'tenant-owned' WHERE id = 'node_01jz00000000000000000000na'`,
    );
    await expect(
      call(
        'pools',
        'offer',
        { tenantId: 'root', poolId, toTenantId: 'acme', quota: { gpu: 8 } },
        { who: root },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      call('pools', 'offer', { tenantId: 'acme', poolId, toTenantId: 'acme', quota: { gpu: 8 } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('checks the caller’s budget at admission when the pool or the offer asks (SPEND_LIMIT_REACHED, draft kept)', async () => {
    billingChecks.length = 0;
    billing = { allowed: true, budgets: [] };
    await call('reservations', 'create', create({ idempotencyKey: 'b0' }));
    expect(billingChecks).toEqual([]); // neither the pool nor the offer asks: no IAM call

    // The offer stops new work when a budget is spent (§12.8 stop-new).
    await db.query(
      `UPDATE pool_offers SET on_budget_exceeded = 'stop-new' WHERE pool_id = $1 AND tenant_id = 'acme'`,
      [poolId],
    );
    billing = {
      allowed: false,
      budgets: [],
      blockedBy: { budgetId: 'bud_team', name: 'team-a' },
    };
    await expect(
      call('reservations', 'create', create({ idempotencyKey: 'b1' })),
    ).rejects.toMatchObject({
      code: 'SPEND_LIMIT_REACHED',
      details: { budgetId: 'bud_team', name: 'team-a' },
    });
    expect(billingChecks.at(-1)).toEqual({ tenantId: 'acme', identityId: caller.identityId });
    // Not denied: the same key re-decides once the budget's window resets.
    const { rows } = await db.query<{ state: string }>(
      `SELECT state FROM reservations WHERE idempotency_key = 'b1'`,
    );
    expect(rows[0]!.state).toBe('draft');
    billing = { allowed: true, budgets: [] };
    const placed = (await call('reservations', 'create', create({ idempotencyKey: 'b1' }))) as Rsv;
    expect(placed.state).toBe('placed');

    // Extends too; a refusal clears the pending change it wrote.
    billing = { allowed: false, budgets: [] };
    recorded.pending = [];
    await expect(
      call('reservations', 'extend', {
        tenantId: 'acme',
        reservationId: placed.id,
        by: '1h',
        idempotencyKey: 'bx',
      }),
    ).rejects.toMatchObject({ code: 'SPEND_LIMIT_REACHED' });
    expect(recorded.pending.at(-1)).toEqual({ id: placed.id, pending: null });

    // The pool itself can ask for it on every admission (`admission.budgetCheck: 'meter'`).
    await db.query(`UPDATE pool_offers SET on_budget_exceeded = 'notify' WHERE pool_id = $1`, [
      poolId,
    ]);
    await db.query(
      `UPDATE pools SET policy = '{"admission": {"budgetCheck": "meter"}}' WHERE id = $1`,
      [poolId],
    );
    await expect(
      call('reservations', 'create', create({ idempotencyKey: 'b2' })),
    ).rejects.toMatchObject({ code: 'SPEND_LIMIT_REACHED' });
    await db.query(`UPDATE pools SET policy = '{}' WHERE id = $1`, [poolId]);
    billing = { allowed: true, budgets: [] };
  });

  it('invalidates the site agents’ specs when a pool’s prewarmImages change', async () => {
    const { rows } = await db.query<{ site_id: string }>(
      `SELECT site_id FROM pools WHERE id = $1`,
      [poolId],
    );
    const siteId = rows[0]!.site_id;
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                          connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ('node_01jz00000000000000000000st', $1, NULL, 'root', 'site', 'adopted', false, false,
               'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
      [siteId],
    );
    const update = (policy: Record<string, unknown>) =>
      call('pools', 'update', { tenantId: 'root', poolId, policy }, { who: root });
    recorded.invalidated = [];
    await update({ prewarmImages: ['img_ubuntu'] });
    expect(recorded.invalidated).toEqual(['node_01jz00000000000000000000st']);
    recorded.invalidated = [];
    await update({ prewarmImages: ['img_ubuntu'], maxPending: '1h' });
    expect(recorded.invalidated).toEqual([]);
  });

  it('offers a single-tenant pool to one tenant besides its owner, without descendants', async () => {
    const offer = (toTenantId: string, extra: Record<string, unknown> = {}) =>
      call(
        'pools',
        'offer',
        { tenantId: 'root', poolId, toTenantId, quota: { gpu: 8 }, ...extra },
        { who: root },
      );
    const update = (policy: Record<string, unknown>) =>
      call('pools', 'update', { tenantId: 'root', poolId, policy }, { who: root });
    // acme holds an offer already; with a second tenant the flag cannot be turned on.
    await offer('beta');
    await expect(update({ singleTenant: true })).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: expect.stringMatching(/offered to 2 tenants \(acme, beta\)/),
    });
    await call('pools', 'unoffer', { tenantId: 'root', poolId, toTenantId: 'beta' }, { who: root });
    await offer('acme', { includeDescendants: true });
    await expect(update({ singleTenant: true })).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: expect.stringMatching(/includeDescendants/),
    });
    await offer('acme');
    await update({ singleTenant: true });

    await expect(offer('beta')).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: expect.stringMatching(/single-tenant and already offered to acme/),
    });
    await expect(offer('acme', { includeDescendants: true })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    // The one tenant may be re-offered (new quota), and the owner always.
    await offer('acme', { quota: { gpu: 4 } });
    await offer('root');
    expect((await readQuotas(db, 'acme', poolId))[0]).toMatchObject({ max: 4 });
    // Once acme is unoffered, another tenant may take its place.
    await call('pools', 'unoffer', { tenantId: 'root', poolId, toTenantId: 'acme' }, { who: root });
    await offer('beta');
    await expect(update({ singleTenant: 'yes' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('summarizes capacity by GPU model and previews a request without booking', async () => {
    await call('reservations', 'create', create());
    const summary = (await call('capacity', 'summary', { tenantId: 'acme' })) as {
      byGpuModel: Record<string, { total: number; allocated: number }>;
    };
    expect(summary.byGpuModel.H100).toMatchObject({ allocated: 2 });

    const fits = (await call(
      'capacity',
      'preview',
      create({ devices: [{ class: 'gpu', count: 4 }], idempotencyKey: 'p' }),
    )) as { fits: boolean; candidates: unknown[] };
    expect(fits.fits).toBe(true);
    expect(fits.candidates).toHaveLength(1);
    const tooBig = (await call(
      'capacity',
      'preview',
      create({ devices: [{ class: 'gpu', count: 5 }], idempotencyKey: 'p' }),
    )) as { fits: boolean; reason?: string };
    expect(tooBig).toMatchObject({ fits: false, reason: expect.stringMatching(/no node fits/) });
    expect((await db.query(`SELECT 1 FROM device_bookings`)).rows).toHaveLength(2);

    const rows = (await call('pools', 'capacity', { tenantId: 'acme', poolId })) as {
      resource: string;
      total: number;
    }[];
    expect(rows.find((row) => row.resource === 'gpu')).toMatchObject({ total: 0 });
    await module.reconcilers![1]!.run(
      { ...moduleContext(db), signal: new AbortController().signal },
      'all',
    );
    const rebuilt = (await call('capacity', 'byPool', { tenantId: 'acme', poolId })) as {
      resource: string;
      total: number;
      allocated: number;
    }[];
    expect(rebuilt.find((row) => row.resource === 'gpu')).toMatchObject({ total: 8, allocated: 2 });
  });

  it('reports quotas and answers NOT_IMPLEMENTED for later-phase methods', async () => {
    const quotas = (await call('quotas', 'get', { tenantId: 'acme' })) as {
      items: { resource: string }[];
    };
    expect(quotas.items.map((row) => row.resource)).toEqual(['gpu']);
  });

  it('archives a pool: unoffered everywhere, no new work, live bookings run out', async () => {
    const live = (await call('reservations', 'create', create())) as Rsv;
    await db.query(`UPDATE nodes SET cordoned = true`);
    const waiting = (await call(
      'reservations',
      'create',
      create({ idempotencyKey: 'waiting', devices: [{ class: 'gpu', count: 1 }] }),
    )) as Rsv;
    expect(waiting.state).toBe('pending');
    await db.query(`UPDATE nodes SET cordoned = false`);
    recorded.removed = [];

    const archived = (await call(
      'pools',
      'archive',
      { tenantId: 'root', poolId },
      { who: root },
    )) as {
      archived: boolean;
      version: number;
    };
    expect(archived).toMatchObject({ archived: true });
    expect(recorded.removed).toEqual([{ type: 'pool', id: poolId, tenantId: 'acme' }]);
    expect(recorded.events.at(-1)).toMatchObject({
      type: 'pool.archived',
      data: { unoffered: ['acme'] },
    });
    // Quota max drops to what live work holds: 2 (placed) + 1 (pending, D9).
    expect((await readQuotas(db, 'acme', poolId))[0]).toMatchObject({ max: 3, used: 3 });

    expect(
      ((await call('pools', 'list', { tenantId: 'acme' })) as { items: unknown[] }).items,
    ).toEqual([]);
    const own = (await call('pools', 'get', { tenantId: 'root', poolId }, { who: root })) as {
      archived: boolean;
    };
    expect(own.archived).toBe(true);
    await expect(
      call('reservations', 'create', create({ idempotencyKey: 'new' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      call(
        'pools',
        'offer',
        { tenantId: 'root', poolId, toTenantId: 'acme', quota: { gpu: 1 } },
        { who: root },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(
      (
        (await call('pools', 'archive', { tenantId: 'root', poolId }, { who: root })) as {
          archived: boolean;
        }
      ).archived,
    ).toBe(true);

    // The placed reservation keeps its booking; the pending one fails at its next retry.
    expect(
      ((await call('reservations', 'get', { tenantId: 'acme', reservationId: live.id })) as Rsv)
        .state,
    ).toBe('placed');
    await reconcile(waiting.id);
    const failed = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: waiting.id,
    })) as Rsv;
    expect(failed).toMatchObject({ state: 'failed', conditions: [{ reason: 'PoolGone' }] });
  });

  it('draws a booking timeline in buckets', async () => {
    await call('reservations', 'create', create({ devices: [{ class: 'gpu', count: 3 }] }));
    await call(
      'reservations',
      'create',
      create({ idempotencyKey: 'later', start: T0 + 2 * HOUR, duration: '1h' }),
    );
    const timeline = (await call('capacity', 'timeline', {
      tenantId: 'acme',
      poolId,
      from: T0,
      to: T0 + 4 * HOUR,
    })) as { allocatable: number; buckets: { start: number; booked: number; free: number }[] };
    expect(timeline.buckets.map((bucket) => [bucket.start - T0, bucket.booked])).toEqual([
      [0, 3],
      [HOUR, 3],
      [2 * HOUR, 2],
      [3 * HOUR, 0],
    ]);
    await expect(
      call('capacity', 'timeline', { tenantId: 'acme', poolId, from: T0, to: T0 + 30 * 24 * HOUR }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(call('capacity', 'timeline', { tenantId: 'other', poolId })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });

  it('lets the owner update a pool and the fleet set quotas', async () => {
    const updated = (await call(
      'pools',
      'update',
      { tenantId: 'root', poolId, policy: { maxPending: '1h' }, gpuModel: 'H200' },
      { who: root },
    )) as { gpuModel: string; policy: { maxPending: string }; version: number };
    expect(updated).toMatchObject({ gpuModel: 'H200', policy: { maxPending: '1h' }, version: 2 });
    expect(recorded.authz.map((row) => [row.tenantId, row.attributes.gpuModel])).toEqual([
      ['root', 'H200'],
      ['acme', 'H200'],
    ]);
    await expect(
      call('pools', 'update', { tenantId: 'acme', poolId, gpuModel: 'B200' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      call('pools', 'update', { tenantId: 'root', poolId }, { who: root }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const quota = await call(
      'quotas',
      'set',
      { tenantId: 'acme', poolId, resource: 'gpu', max: 16 },
      { who: root },
    );
    expect(quota).toMatchObject({ resource: 'gpu', max: 16, used: 0, available: 16 });
  });
});

describe('createCapacityPort', () => {
  it('charges and places together, and gives the charge back when nothing fits or on release', async () => {
    const port = createCapacityPort({ clock }, { random: () => 0, topN: 1 });
    const request = {
      tenantId: 'acme',
      poolId,
      instanceId: 'inst_01jz00000000000000000000aa',
      devices: [{ class: 'gpu' as const, count: 3 }],
      during: { start: T0, end: T0 + HOUR },
    };
    const outcome = await db.transaction((tx) => port.reserve(tx, request));
    expect(outcome.status).toBe('placed');
    expect((await readQuotas(db, 'acme', poolId))[0]!.used).toBe(3);
    const none = await db.transaction((tx) =>
      port.reserve(tx, { ...request, devices: [{ class: 'gpu', count: 5 }] }),
    );
    expect(none.status).toBe('pending');
    expect((await readQuotas(db, 'acme', poolId))[0]!.used).toBe(3);
    if (outcome.status !== 'placed') return;
    await db.transaction((tx) => port.release(tx, outcome.allocations[0]!.id));
    await db.transaction((tx) => port.release(tx, outcome.allocations[0]!.id));
    expect((await readQuotas(db, 'acme', poolId))[0]!.used).toBe(0);
  });
});

describe('node reports', () => {
  it('re-places at once when a node rejects the binding, and marks lost bindings Degraded', async () => {
    const created = (await call('reservations', 'create', create())) as Rsv;
    await reconcile(created.id); // → binding
    const node = recorded.invalidated.at(-1)!;
    const [first] = await deviceAssignments(db, node);
    const work = moduleContext(db).work;
    expect(
      await db.transaction((tx) =>
        markAllocationFailed(tx, work, first!.allocationId, { reason: 'cdi: no such device' }),
      ),
    ).toBe(true);
    await reconcile(created.id); // rejected → pending without waiting for the timeout
    const pending = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: created.id,
    })) as Rsv;
    expect(pending.state).toBe('pending');
    expect(pending.conditions).toMatchObject([
      { type: 'BindTimeout', reason: 'NodeRejectedBinding', message: '1' },
    ]);

    await reconcile(created.id); // → placed
    await reconcile(created.id); // → binding
    const [second] = await deviceAssignments(db, recorded.invalidated.at(-1)!);
    await db.transaction((tx) =>
      markAllocationBound(tx, work, second!.allocationId, { cdiDevices: ['nvidia.com/gpu=0'] }),
    );
    await reconcile(created.id); // → active
    // Late reports about the first allocation are stale.
    expect(
      await db.transaction((tx) =>
        markAllocationFailed(tx, work, first!.allocationId, { reason: 'late' }),
      ),
    ).toBe(false);
    expect(
      await db.transaction((tx) =>
        markAllocationBound(tx, work, first!.allocationId, { cdiDevices: [] }),
      ),
    ).toBe(false);

    expect(
      await db.transaction((tx) => markAllocationReleased(tx, work, second!.allocationId)),
    ).toBe(true);
    await reconcile(created.id);
    const degraded = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: created.id,
    })) as Rsv;
    expect(degraded).toMatchObject({
      state: 'active',
      conditions: [{ type: 'Degraded', reason: 'BindingLost' }],
    });
    expect(degraded.binding).toBeUndefined();

    await db.transaction((tx) =>
      markAllocationBound(tx, work, second!.allocationId, { cdiDevices: ['nvidia.com/gpu=0'] }),
    );
    await reconcile(created.id);
    const healed = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: created.id,
    })) as Rsv;
    expect(healed.conditions).toEqual([]);
    expect(healed.binding).toMatchObject({ cdiDevices: ['nvidia.com/gpu=0'] });

    await call('reservations', 'release', { tenantId: 'acme', reservationId: created.id });
    expect(
      await db.transaction((tx) => markAllocationReleased(tx, work, second!.allocationId)),
    ).toBe(false);
  });
});

describe('delegated confirmation (§3.4 step 7)', () => {
  const agent = {
    ...caller,
    sessionKind: 'delegated' as const,
    agentId: 'agt_1',
    delegationId: 'dlg_1',
  };
  const confirmation = (expiresAt?: number) =>
    new ComputeError('CONFIRMATION_REQUIRED', 'A human must confirm', 403, {
      confirmationId: 'cnf_1',
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      action: 'compute:reservations:create',
      resource: { type: 'compute-reservation', id: 'x' },
    });

  it('parks the draft, then re-decides the same id when the agent retries after approval', async () => {
    await expect(
      call('reservations', 'create', create(), {
        who: agent,
        deny: confirmation(T0 + 10 * 60_000),
      }),
    ).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { confirmationId: 'cnf_1' },
    });
    const { rows } = await db.query<{ id: string; state: string }>(
      `SELECT id, state FROM reservations`,
    );
    expect(rows).toMatchObject([{ state: 'awaiting-confirmation' }]);
    expect(recorded.work.at(-1)).toEqual({
      kind: reservationWork,
      key: rows[0]!.id,
      notBefore: T0 + 10 * 60_000,
    });
    expect(recorded.events).toEqual(
      ['reservation.awaiting-confirmation'].map((type) => expect.objectContaining({ type })),
    );
    expect((await readQuotas(db, 'acme', poolId))[0]!.used).toBe(0);

    await advance(5 * 60_000);
    const placed = (await call('reservations', 'create', create(), { who: agent })) as Rsv;
    expect(placed).toMatchObject({ id: rows[0]!.id, state: 'placed' });
    expect(placed.conditions).toEqual([]);
  });

  it('clamps the deadline to 30 minutes and expires unconfirmed requests', async () => {
    await expect(
      call('reservations', 'create', create(), { who: agent, deny: confirmation(T0 + 5 * HOUR) }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const id = (await db.query<{ id: string }>(`SELECT id FROM reservations`)).rows[0]!.id;
    expect(recorded.work.at(-1)!.notBefore).toBe(T0 + 30 * 60_000);
    await reconcile(id);
    expect(
      (await db.query<{ state: string }>(`SELECT state FROM reservations`)).rows[0]!.state,
    ).toBe('awaiting-confirmation');
    await advance(30 * 60_000);
    await reconcile(id);
    expect(
      (await db.query<{ state: string }>(`SELECT state FROM reservations`)).rows[0]!.state,
    ).toBe('expired');
    const replay = (await call('reservations', 'create', create(), { who: agent })) as Rsv;
    expect(replay.state).toBe('expired');
  });

  it('expires on a late retry even before the reconciler ran, and denies plain refusals', async () => {
    await expect(
      call('reservations', 'create', create(), { who: agent, deny: confirmation() }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await advance(31 * 60_000);
    expect(((await call('reservations', 'create', create(), { who: agent })) as Rsv).state).toBe(
      'expired',
    );

    await expect(
      call('reservations', 'create', create({ idempotencyKey: 'k2' }), {
        who: agent,
        deny: new ComputeError('CONFIRMATION_REQUIRED', 'no id', 403, {}),
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const { rows } = await db.query<{ state: string }>(
      `SELECT state FROM reservations WHERE idempotency_key = 'k2'`,
    );
    expect(rows).toEqual([{ state: 'denied' }]);
  });
});

describe('reservations.list scope', () => {
  it('lists the caller’s own by default and the whole tenant with scope all', async () => {
    await call(
      'reservations',
      'create',
      create({ idempotencyKey: 'mine-1', devices: [{ class: 'gpu', count: 1 }] }),
    );
    await call(
      'reservations',
      'create',
      create({ idempotencyKey: 'bob-1', devices: [{ class: 'gpu', count: 1 }] }),
      {
        who: { ...caller, identityId: 'usr_bob' },
      },
    );
    const mine = (await call('reservations', 'list', { tenantId: 'acme' })) as { items: Rsv[] };
    expect(mine.items).toHaveLength(1);
    const all = (await call('reservations', 'list', { tenantId: 'acme', scope: 'all' })) as {
      items: Rsv[];
    };
    expect(all.items).toHaveLength(2);
    await expect(
      call('reservations', 'list', { tenantId: 'acme', scope: 'everyone' }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('keyed pools.create (FleetConfig ids)', () => {
  const root = { ...caller, tenantId: 'root', identityId: 'usr_root' };
  const body = (extra: Record<string, unknown> = {}) => ({
    tenantId: 'root',
    siteId: 'site_01jz00000000000000000000aa',
    class: 'metal-host',
    gpuModel: 'H100',
    idempotencyKey: 'fleet:root:pool:h100-a',
    ...extra,
  });

  it('derives the id from the key, replays, and refuses a reused key', async () => {
    const expected = await draftId('pool', 'root', 'usr_root', 'fleet:root:pool:h100-a');
    const first = (await call('pools', 'create', body(), { who: root })) as { id: string };
    expect(first.id).toBe(expected);
    const again = (await call('pools', 'create', body({ gpuModel: 'H200' }), { who: root })) as {
      id: string;
    };
    expect(again.id).toBe(expected); // gpuModel is updatable, so not part of the request identity
    await expect(
      call('pools', 'create', body({ class: 'vps-host' }), { who: root }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const other = (await call('pools', 'create', body({ idempotencyKey: undefined }), {
      who: root,
    })) as { id: string };
    expect(other.id).not.toBe(expected);
    await expect(
      call('pools', 'create', body({ idempotencyKey: 'bad key' }), { who: root }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('fleet-scoped methods', () => {
  it('decide on fleet/global like every other fleet method', () => {
    const set = api.quotas.set as unknown as { resource(input: unknown): unknown };
    expect(set.resource({ tenantId: 'acme', poolId, resource: 'gpu', max: 1 })).toEqual({
      type: 'fleet',
      id: fleetResourceId,
    });
    expect(fleetResourceId).toBe('global');
  });
});

describe('gang reservations (v0.5)', () => {
  it('book, bind and release every member together; quota and IAM see the whole gang', async () => {
    const gang = (await call(
      'reservations',
      'create',
      create({ devices: [{ class: 'gpu', count: 4 }], gang: { size: 2 } }),
    )) as Rsv;
    expect(gang.state).toBe('placed');
    expect((await readQuotas(db, 'acme', poolId))[0]).toMatchObject({ used: 8 });
    expect(recorded.authz.at(-1)!.attributes).toMatchObject({ gpuCount: 8, gangSize: 2 });

    await reconcile(gang.id);
    const nodes = [...new Set(recorded.invalidated)].sort();
    expect(nodes).toEqual(['node_01jz00000000000000000000na', 'node_01jz00000000000000000000nb']);
    const work = moduleContext(db).work;
    const [first] = await deviceAssignments(db, nodes[0]!);
    const [second] = await deviceAssignments(db, nodes[1]!);
    await db.transaction((tx) =>
      markAllocationBound(tx, work, first!.allocationId, { cdiDevices: ['a'] }),
    );
    await reconcile(gang.id);
    expect(
      ((await call('reservations', 'get', { tenantId: 'acme', reservationId: gang.id })) as Rsv)
        .state,
    ).toBe('binding');
    await db.transaction((tx) =>
      markAllocationBound(tx, work, second!.allocationId, { cdiDevices: ['b'] }),
    );
    await reconcile(gang.id);
    expect(
      ((await call('reservations', 'get', { tenantId: 'acme', reservationId: gang.id })) as Rsv)
        .state,
    ).toBe('active');

    await call('reservations', 'release', { tenantId: 'acme', reservationId: gang.id });
    expect((await readQuotas(db, 'acme', poolId))[0]!.used).toBe(0);
    const { rows } = await db.query(`SELECT 1 FROM allocations WHERE released_at IS NULL`);
    expect(rows).toEqual([]);
  });

  it('previews gangs, and a gang larger than the pool stays pending', async () => {
    const fits = (await call(
      'capacity',
      'preview',
      create({ devices: [{ class: 'gpu', count: 2 }], gang: { size: 2 }, idempotencyKey: 'p' }),
    )) as { fits: boolean; candidates: unknown[] };
    expect(fits).toMatchObject({ fits: true });
    expect(fits.candidates).toHaveLength(2);
    await db.query(`UPDATE quota_usage SET max = 100`);
    const tooBig = (await call(
      'reservations',
      'create',
      create({ devices: [{ class: 'gpu', count: 1 }], gang: { size: 3 }, idempotencyKey: 'big' }),
    )) as Rsv;
    expect(tooBig).toMatchObject({
      state: 'pending',
      conditions: [
        { type: 'Unschedulable', message: expect.stringContaining('no gang of 3 nodes') },
      ],
    });
    await expect(
      call('reservations', 'create', create({ gang: { size: 1 }, idempotencyKey: 'bad' })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('waking pending reservations', () => {
  it('re-places a pending reservation as soon as a release frees room', async () => {
    await db.query(`UPDATE quota_usage SET max = 100`);
    const big = (await call(
      'reservations',
      'create',
      create({ devices: [{ class: 'gpu', count: 4 }] }),
    )) as Rsv;
    await call(
      'reservations',
      'create',
      create({ devices: [{ class: 'gpu', count: 4 }], idempotencyKey: 'b2' }),
    );
    const waiting = (await call(
      'reservations',
      'create',
      create({ devices: [{ class: 'gpu', count: 4 }], idempotencyKey: 'b3' }),
    )) as Rsv;
    expect(waiting.state).toBe('pending');
    recorded.work = [];
    await call('reservations', 'release', { tenantId: 'acme', reservationId: big.id });
    expect(recorded.work).toContainEqual({ kind: reservationWork, key: waiting.id });
    await reconcile(waiting.id);
    const placed = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: waiting.id,
    })) as Rsv;
    expect(placed.state).toBe('placed');
  });

  it('wakes a node’s pool on node-controller edges', async () => {
    await db.query(`UPDATE nodes SET cordoned = true`);
    const waiting = (await call('reservations', 'create', create())) as Rsv;
    recorded.work = [];
    await db.query(`UPDATE nodes SET cordoned = false`);
    const woken = await db.transaction((tx) =>
      wakePendingForNode(tx, moduleContext(db).work, 'node_01jz00000000000000000000na'),
    );
    expect(woken).toBe(1);
    expect(recorded.work).toEqual([{ kind: reservationWork, key: waiting.id }]);
    expect(
      await db.transaction((tx) => wakePendingForNode(tx, moduleContext(db).work, 'node_missing')),
    ).toBe(0);
  });
});

describe('BookingRepair (v0.5)', () => {
  const soon = () => create({ start: T0 + 2 * HOUR, devices: [{ class: 'gpu', count: 4 }] });

  it('leaves a healthy booking alone and re-checks at the start', async () => {
    const created = (await call('reservations', 'create', soon())) as Rsv;
    await reconcile(created.id);
    expect(recorded.work.at(-1)).toMatchObject({ notBefore: T0 + 2 * HOUR - 15 * 60_000 });
    await advance(2 * HOUR - 15 * 60_000);
    recorded.events = [];
    await reconcile(created.id);
    expect(recorded.events.map((event) => event.type)).toEqual([]);
    expect(recorded.work.at(-1)).toMatchObject({ notBefore: T0 + 2 * HOUR });
  });

  it('moves a booking off a node cordoned since, for the same window, keeping the quota', async () => {
    const created = (await call('reservations', 'create', soon())) as Rsv;
    const { rows } = await db.query<{ node_id: string }>(
      `SELECT node_id FROM allocations WHERE owner_id = $1`,
      [created.id],
    );
    const before = rows[0]!.node_id;
    await db.query(`UPDATE nodes SET cordoned = true WHERE id = $1`, [before]);
    await advance(2 * HOUR - 15 * 60_000);
    await reconcile(created.id);
    const after = await db.query<{ node_id: string; start_ms: number }>(
      `SELECT node_id, (extract(epoch FROM lower(during)) * 1000)::float8 AS start_ms FROM allocations
        WHERE owner_id = $1 AND released_at IS NULL`,
      [created.id],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.node_id).not.toBe(before);
    expect(after.rows[0]!.start_ms).toBe(T0 + 2 * HOUR);
    expect(recorded.events.at(-1)).toMatchObject({
      type: 'reservation.repaired',
      data: { from: [before] },
    });
    expect((await readQuotas(db, 'acme', poolId))[0]!.used).toBe(4);
    const view = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: created.id,
    })) as Rsv;
    expect(view.state).toBe('placed');
  });

  it('repairs around a quarantined GPU, and goes pending when nothing else fits', async () => {
    const created = (await call('reservations', 'create', soon())) as Rsv;
    // The other node is taken for the same window, so there is nowhere to move to.
    await call(
      'reservations',
      'create',
      create({
        start: T0 + 2 * HOUR,
        devices: [{ class: 'gpu', count: 4 }],
        idempotencyKey: 'other',
      }),
    );
    const { rows } = await db.query<{ atoms: string[] }>(
      `SELECT atoms FROM allocations WHERE owner_id = $1`,
      [created.id],
    );
    await db.query(`UPDATE devices SET healthy = false WHERE id = $1`, [rows[0]!.atoms[0]]);
    await advance(2 * HOUR - 15 * 60_000);
    await reconcile(created.id);
    const view = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: created.id,
    })) as Rsv;
    expect(view).toMatchObject({
      state: 'pending',
      conditions: [{ type: 'Unschedulable', reason: 'BookingRepairFailed' }],
    });
    expect((await readQuotas(db, 'acme', poolId))[0]!.used).toBe(8);
    const live = await db.query(
      `SELECT 1 FROM allocations WHERE owner_id = $1 AND released_at IS NULL`,
      [created.id],
    );
    expect(live.rows).toEqual([]);
  });
});

describe('spot reservations (v0.5)', () => {
  const NOTICE = 2 * 60_000;
  const four = (key: string, extra: Record<string, unknown> = {}) =>
    create({
      devices: [{ class: 'gpu', count: 4 }],
      duration: '8h',
      idempotencyKey: key,
      ...extra,
    });
  const get = async (id: string) =>
    (await call('reservations', 'get', { tenantId: 'acme', reservationId: id })) as Rsv;

  /** Starts a placed reservation and binds all its allocations. */
  async function activate(id: string): Promise<void> {
    await reconcile(id);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM allocations WHERE owner_id = $1 AND released_at IS NULL`,
      [id],
    );
    for (const row of rows)
      await db.transaction((tx) =>
        markAllocationBound(tx, moduleContext(db).work, row.id, { cdiDevices: ['x'] }),
      );
    await reconcile(id);
    expect((await get(id)).state).toBe('active');
  }

  beforeEach(async () => {
    await db.query(`UPDATE quota_usage SET max = 100`);
  });

  it('gives a running spot reservation a notice, then releases it; the preemptor starts at the deadline', async () => {
    const spotA = (await call('reservations', 'create', four('s1', { spot: true }))) as Rsv;
    const spotB = (await call('reservations', 'create', four('s2', { spot: true }))) as Rsv;
    expect([spotA.state, spotB.state]).toEqual(['placed', 'placed']);
    expect(recorded.authz.at(-1)!.attributes).toMatchObject({ spot: true });
    await activate(spotA.id);
    await activate(spotB.id);
    recorded.events = [];
    recorded.work = [];

    // Preview says a regular request fits by preempting one spot reservation, a spot one does not.
    const previewOf = async (extra: Record<string, unknown>) =>
      (await call('capacity', 'preview', four('p', { duration: '2h', ...extra }))) as {
        fits: boolean;
        preemptible?: { reservations: number; startsAt: number };
      };
    expect(await previewOf({})).toMatchObject({
      fits: false,
      preemptible: { reservations: 1, startsAt: T0 + NOTICE },
    });
    expect((await previewOf({ spot: true })).preemptible).toBeUndefined();

    // A regular request finds the pool full of spot work: it takes one node after the notice.
    const regular = (await call('reservations', 'create', four('r1', { duration: '2h' }))) as Rsv;
    expect(regular.state).toBe('placed');
    expect(regular.during).toEqual({ start: T0 + NOTICE, end: T0 + NOTICE + 2 * HOUR });
    const preempting = recorded.events.filter((event) => event.type === 'reservation.preempting');
    expect(preempting).toHaveLength(1);
    expect(preempting[0]!.data).toMatchObject({ by: regular.id, at: T0 + NOTICE });
    const victimId = preempting[0]!.subject.replace('reservation/', '');
    const survivor = victimId === spotA.id ? spotB.id : spotA.id;
    const victim = await get(victimId);
    expect(victim).toMatchObject({
      state: 'active',
      during: { start: T0, end: T0 + NOTICE },
      conditions: expect.arrayContaining([
        expect.objectContaining({ type: 'Preempted', message: `preempted by ${regular.id}` }),
      ]),
    });
    expect(recorded.work).toContainEqual({
      kind: reservationWork,
      key: victimId,
      notBefore: T0 + NOTICE,
    });
    expect(recorded.invalidated.length).toBeGreaterThan(0);
    expect((await get(survivor)).during).toEqual({ start: T0, end: T0 + 8 * HOUR });

    // At the deadline the lifecycle releases it, reason preempted, and refunds its quota.
    await advance(NOTICE);
    await reconcile(victimId);
    expect((await get(victimId)).state).toBe('released');
    expect(recorded.events.at(-1)).toMatchObject({
      type: 'reservation.released',
      data: expect.objectContaining({ reason: 'preempted' }),
    });
    expect((await readQuotas(db, 'acme', poolId))[0]!.used).toBe(8);

    // Billing: the victim bills the spot meter up to the deadline; the regular one bills from its bind.
    await activate(regular.id);
    await advance(HOUR);
    await db.transaction((tx) => meterReservations(tx, clock.now()));
    const { rows } = await db.query<{ allocation_id: string; meter: string; quantity: string }>(
      `SELECT w.allocation_id, w.meter, w.quantity::text AS quantity
         FROM usage_windows w JOIN allocations a ON a.id = w.allocation_id
        WHERE a.owner_id = $1`,
      [victimId],
    );
    expect(rows.map((row) => [row.meter, Number(row.quantity)])).toEqual([
      ['gpu.h100.spot.hours', Math.round(4 * (2 / 60) * 1e6) / 1e6],
    ]);
    const bookings = await db.query<{ overlaps: string }>(
      `SELECT count(*)::text AS overlaps FROM device_bookings a JOIN device_bookings b
          ON a.device_id = b.device_id AND a.allocation_id < b.allocation_id AND a.during && b.during`,
    );
    expect(bookings.rows[0]!.overlaps).toBe('0');
  });

  it('re-queues a spot reservation that has not started, keeping its quota', async () => {
    const later = T0 + 3 * HOUR;
    const spot = (await call(
      'reservations',
      'create',
      four('s1', { spot: true, start: later, duration: '2h' }),
    )) as Rsv;
    const regularHolder = (await call('reservations', 'create', four('n1'))) as Rsv;
    expect([spot.state, regularHolder.state]).toEqual(['placed', 'placed']);
    recorded.events = [];

    const regular = (await call(
      'reservations',
      'create',
      four('r1', { start: later, duration: '2h' }),
    )) as Rsv;
    expect(regular).toMatchObject({ state: 'placed', during: { start: later } });
    expect(await get(spot.id)).toMatchObject({
      state: 'pending',
      conditions: [expect.objectContaining({ type: 'Unschedulable', reason: 'SpotPreempted' })],
    });
    expect(recorded.events.map((event) => event.type)).toContain('reservation.preempted');
    const live = await db.query(
      `SELECT 1 FROM allocations WHERE owner_id = $1 AND released_at IS NULL`,
      [spot.id],
    );
    expect(live.rows).toEqual([]);
    expect((await readQuotas(db, 'acme', poolId))[0]!.used).toBe(12);
  });

  it('preempts every spot reservation a gang needs, all in one notice', async () => {
    const spots = [
      (await call('reservations', 'create', four('s1', { spot: true }))) as Rsv,
      (await call('reservations', 'create', four('s2', { spot: true }))) as Rsv,
    ];
    recorded.events = [];
    const gang = (await call(
      'reservations',
      'create',
      four('g1', { gang: { size: 2 }, duration: '1h' }),
    )) as Rsv;
    expect(gang).toMatchObject({ state: 'placed', during: { start: T0 + NOTICE } });
    const noticed = recorded.events
      .filter((event) => event.type === 'reservation.preempting')
      .map((event) => event.subject.replace('reservation/', ''))
      .sort();
    expect(noticed).toEqual(spots.map((spot) => spot.id).sort());
  });

  it('never tells another tenant which reservation preempted it', async () => {
    const root = { ...caller, tenantId: 'root', identityId: 'usr_root' };
    await call(
      'pools',
      'offer',
      { tenantId: 'root', poolId, toTenantId: 'globex', quota: { gpu: 100 } },
      { who: root },
    );
    const globex: Caller = { ...caller, tenantId: 'globex', identityId: 'usr_gus' };
    const theirs = (await call(
      'reservations',
      'create',
      four('g1', { tenantId: 'globex', spot: true }),
      {
        who: globex,
      },
    )) as Rsv;
    await call('reservations', 'create', four('g2', { tenantId: 'globex', spot: true }), {
      who: globex,
    });
    recorded.events = [];
    const ours = (await call('reservations', 'create', four('r1'))) as Rsv;
    expect(ours.state).toBe('placed');
    const notice = recorded.events.find((event) => event.type === 'reservation.preempting')!;
    expect(notice.data).not.toHaveProperty('by');
    expect(JSON.stringify(recorded.events)).not.toContain(`"by":"${ours.id}"`);
    const victim = (await call(
      'reservations',
      'get',
      { tenantId: 'globex', reservationId: notice.subject.replace('reservation/', '') },
      { who: globex },
    )) as Rsv & { conditions: { type: string; message?: string }[] };
    expect(JSON.stringify(victim.conditions)).not.toContain(ours.id);
    expect(victim.conditions).toContainEqual(
      expect.objectContaining({
        type: 'Preempted',
        message: 'preempted by a non-spot reservation',
      }),
    );
    expect(theirs.state).toBe('placed');
  });

  it('never preempts for spot requests, and never preempts regular work', async () => {
    const spot = (await call('reservations', 'create', four('s1', { spot: true }))) as Rsv;
    await call('reservations', 'create', four('n1'));
    // Spot does not preempt spot.
    expect(((await call('reservations', 'create', four('s2', { spot: true }))) as Rsv).state).toBe(
      'pending',
    );
    // Once the spot capacity is gone, a regular request waits like any other.
    await call('reservations', 'create', four('r1'));
    expect((await get(spot.id)).conditions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'Preempted' })]),
    );
    expect(((await call('reservations', 'create', four('r2'))) as Rsv).state).toBe('pending');
  });
});

describe('node leases: binding node (v0.5)', () => {
  let leasePool: string;
  const root = { ...caller, tenantId: 'root', identityId: 'usr_root' };

  async function addReadyNode(id: string, gpus: number): Promise<void> {
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
                          cordoned, connectivity, trust, generation, observed_generation, next_cmd_seq,
                          identity_gen, shard, version)
       VALUES ($1, 'site_01jz00000000000000000000aa', $2, 'root', 'host', 'ready', false, false,
               'disconnected', 'platform', 1, 0, 1, 1, 0, 1)`,
      [id, leasePool],
    );
    for (let index = 0; index < gpus; index++)
      await db.query(
        `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
         VALUES ($1, $2, 'gpu', true, $3, '{"gpuModel":"H100"}')`,
        [`GPU-${id.slice(-2)}-${index}`, id, index < 4],
      );
  }

  beforeEach(async () => {
    const pool = (await call(
      'pools',
      'create',
      {
        tenantId: 'root',
        siteId: 'site_01jz00000000000000000000aa',
        class: 'metal-host',
        gpuModel: 'H100',
        policy: { tenantRoot: true },
      },
      { who: root },
    )) as { id: string };
    leasePool = pool.id;
    await call(
      'pools',
      'offer',
      { tenantId: 'root', poolId: leasePool, toTenantId: 'acme', quota: { gpu: 100 } },
      { who: root },
    );
    await addReadyNode('node_01jz00000000000000000000la', 5);
    await addReadyNode('node_01jz00000000000000000000lb', 5);
    recorded.work = [];
  });

  const lease = (extra: Record<string, unknown> = {}) =>
    create({
      poolId: leasePool,
      devices: [{ class: 'gpu', count: 4 }],
      duration: '8h',
      binding: 'node',
      node: { profileId: 'prf_ubuntu-24', profileVersion: 2 },
      idempotencyKey: 'lease-1',
      ...extra,
    });
  const get = async (id: string) =>
    (await call('reservations', 'get', { tenantId: 'acme', reservationId: id })) as Rsv & {
      request: Record<string, unknown>;
    };
  const allocationsOf = async (id: string) =>
    (
      await db.query<{ id: string; node_id: string; atoms: string[]; released: boolean }>(
        `SELECT id, node_id, atoms, released_at IS NOT NULL AS released FROM allocations
          WHERE owner_id = $1 ORDER BY id`,
        [id],
      )
    ).rows;

  it('books the whole node, lets metal deploy it from the start, and hands it back on release', async () => {
    expect(await call('capacity', 'preview', lease())).toMatchObject({
      fits: true,
      candidates: [{ nodeId: 'node_01jz00000000000000000000la', atoms: expect.any(Array) }],
    });
    expect(await call('capacity', 'preview', lease({ gang: { size: 3 } }))).toMatchObject({
      fits: false,
      reason: '2 leasable node(s) fit, 3 needed',
    });
    const leased = (await call('reservations', 'create', lease())) as Rsv;
    expect(leased.state).toBe('placed');
    expect((await get(leased.id)).request).toMatchObject({
      binding: 'node',
      node: { profileId: 'prf_ubuntu-24', profileVersion: 2 },
    });
    const [allocation] = await allocationsOf(leased.id);
    // Every bookable atom, the unhealthy fifth GPU included.
    expect(allocation!.atoms).toHaveLength(5);
    const nodeId = allocation!.node_id;
    expect(recorded.work.filter((entry) => entry.kind === 'metal')).toEqual([]);

    await reconcile(leased.id);
    expect((await get(leased.id)).state).toBe('binding');
    expect(recorded.work).toContainEqual({ kind: 'metal', key: nodeId });
    // bcd on the node gets no CDI assignments for a lease.
    expect(await deviceAssignments(db, nodeId)).toEqual([]);

    // Metal finished the deploy: it marks the allocation bound and wakes the reservation.
    await db.query(
      `UPDATE allocations SET bound_at = compute_now(), binding = '{"node": true}'::jsonb WHERE id = $1`,
      [allocation!.id],
    );
    await db.query(
      `UPDATE nodes SET provision_state = 'deployed', trust = 'tenant-controlled' WHERE id = $1`,
      [nodeId],
    );
    await reconcile(leased.id);
    expect((await get(leased.id)).state).toBe('active');

    // The other node is still leasable; this one is not while the tenant holds it.
    const second = (await call(
      'reservations',
      'create',
      lease({ idempotencyKey: 'lease-2' }),
    )) as Rsv;
    expect(second.state).toBe('placed');
    expect((await allocationsOf(second.id))[0]!.node_id).not.toBe(nodeId);
    const third = (await call(
      'reservations',
      'create',
      lease({ idempotencyKey: 'lease-3' }),
    )) as Rsv;
    expect(third).toMatchObject({
      state: 'pending',
      conditions: [expect.objectContaining({ message: expect.stringContaining('leasable') })],
    });

    recorded.work = [];
    await call('reservations', 'release', { tenantId: 'acme', reservationId: leased.id });
    expect((await allocationsOf(leased.id))[0]!.released).toBe(true);
    expect(recorded.work).toContainEqual({ kind: 'metal', key: nodeId });

    // After metal's teardown the node is ready and platform-owned again: leasable.
    await db.query(`UPDATE nodes SET provision_state = 'ready', trust = 'platform' WHERE id = $1`, [
      nodeId,
    ]);
    await reconcile(third.id);
    expect((await get(third.id)).state).toBe('placed');
  });

  it('fails a lease metal did not deploy in time, without placing it again', async () => {
    const leased = (await call('reservations', 'create', lease())) as Rsv;
    await reconcile(leased.id);
    const nodeId = (await allocationsOf(leased.id))[0]!.node_id;
    await advance(5 * 60_000 + 1);
    await reconcile(leased.id);
    expect((await get(leased.id)).state).toBe('binding');
    recorded.work = [];
    await advance(2 * HOUR);
    await reconcile(leased.id);
    expect(await get(leased.id)).toMatchObject({
      state: 'failed',
      conditions: [expect.objectContaining({ type: 'BindTimeout' })],
    });
    expect(recorded.work).toContainEqual({ kind: 'metal', key: nodeId });
    expect((await allocationsOf(leased.id)).every((row) => row.released)).toBe(true);
  });

  it('bills node.metal.hours plus the GPUs healthy at each window start', async () => {
    const leased = (await call('reservations', 'create', lease())) as Rsv;
    await reconcile(leased.id);
    const [allocation] = await allocationsOf(leased.id);
    await db.query(`UPDATE allocations SET bound_at = compute_now() WHERE id = $1`, [
      allocation!.id,
    ]);
    await reconcile(leased.id);
    const meter = () => db.transaction((tx) => meterReservations(tx, clock.now()));
    const flip = (healthy: boolean) =>
      db.query(`UPDATE devices SET healthy = $2 WHERE id = $1`, [allocation!.atoms[0], healthy]);

    const unhealthy = async () =>
      (await get(leased.id)).conditions.find((c) => c.type === 'UnhealthyAtoms') as
        | { message: string }
        | undefined;
    await meter(); // 12:00 snapshot: 4 of 5 GPUs healthy
    expect((await unhealthy())?.message).toMatch(/^1 of 5 GPUs unhealthy, not billed: GPU-la-4$/);
    await advance(30 * 60_000);
    await flip(false); // an XID at 12:30
    await advance(31 * 60_000);
    await meter(); // 13:01: 12:00 is final; 13:00 snapshot: 3 healthy
    expect((await unhealthy())?.message).toMatch(/^2 of 5 GPUs/);
    await advance(60 * 60_000);
    await meter(); // 14:01: 13:00 is final
    await advance(9 * 60_000);
    await flip(true); // recovered at 14:10
    await advance(51 * 60_000);
    await meter(); // 15:01: 14:00 is final (its snapshot says 3)
    expect((await meter()).windows).toBe(0); // repeating a pass writes nothing
    expect((await unhealthy())?.message).toMatch(/^1 of 5 GPUs/);

    const { rows } = await db.query<{ start: string; meter: string; quantity: string }>(
      `SELECT to_char(window_start AT TIME ZONE 'UTC', 'HH24:MI') AS start, meter, quantity::text AS quantity
         FROM usage_windows WHERE allocation_id = $1 ORDER BY window_start, meter`,
      [allocation!.id],
    );
    expect(rows.map((row) => [row.start, row.meter, Number(row.quantity)])).toEqual([
      ['12:00', 'gpu.h100.hours', 4],
      ['12:00', 'node.metal.hours', 1],
      ['13:00', 'gpu.h100.hours', 3],
      ['13:00', 'node.metal.hours', 1],
      ['14:00', 'gpu.h100.hours', 3],
      ['14:00', 'node.metal.hours', 1],
    ]);
    await db.query(`UPDATE devices SET healthy = true WHERE node_id = $1`, [allocation!.node_id]);
    await advance(HOUR);
    await meter(); // every GPU healthy at 16:00: the condition goes away
    expect(await unhealthy()).toBeUndefined();
  });

  it('leases gangs of whole nodes', async () => {
    const gang = (await call('reservations', 'create', lease({ gang: { size: 2 } }))) as Rsv;
    expect(gang.state).toBe('placed');
    expect((await allocationsOf(gang.id)).map((row) => row.node_id)).toEqual(
      expect.arrayContaining([
        'node_01jz00000000000000000000la',
        'node_01jz00000000000000000000lb',
      ]),
    );
  });

  it('refuses node bindings outside tenantRoot pools, without a profile, or as spot', async () => {
    for (const bad of [
      lease({ poolId }),
      lease({ node: undefined }),
      lease({ spot: true }),
      create({ node: { profileId: 'prf_x' } }),
      lease({ node: { profileId: 'prf_x', extra: 1 } }),
    ])
      await expect(call('reservations', 'create', bad)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
  });

  it('never leases a node dedicated to another tenant (dedicated=<tenant>)', async () => {
    await db.query(
      `UPDATE nodes SET no_schedule_reasons = ARRAY['taint:dedicated=beta'] WHERE id = 'node_01jz00000000000000000000la'`,
    );
    const first = (await call('reservations', 'create', lease({ idempotencyKey: 'd1' }))) as Rsv;
    expect(first.state).toBe('placed');
    expect((await allocationsOf(first.id)).map((row) => row.node_id)).toEqual([
      'node_01jz00000000000000000000lb',
    ]);
    // The only node left is beta's: acme's next lease waits.
    const second = (await call('reservations', 'create', lease({ idempotencyKey: 'd2' }))) as Rsv;
    expect(second.state).toBe('pending');
    // Dedicated to acme instead, it is acme's to lease.
    await db.query(
      `UPDATE nodes SET no_schedule_reasons = ARRAY['taint:dedicated=acme'] WHERE id = 'node_01jz00000000000000000000la'`,
    );
    const third = (await call('reservations', 'create', lease({ idempotencyKey: 'd3' }))) as Rsv;
    expect(third.state).toBe('placed');
  });

  it('runs scheduler admission hooks for node leases too', async () => {
    const seen: string[] = [];
    const policy = capacityModule({
      random: () => 0,
      topN: 1,
      plugins: [
        {
          id: 'lease-policy',
          extension: 'scheduler',
          async admit(request) {
            seen.push(request.reservationId!);
            if (request.devices[0]!.count > 4)
              throw new ComputeError('ACCESS_DENIED', 'Node leases above 4 GPUs are refused');
          },
        },
      ],
    });
    const policyApi = policy.api!(moduleContext(db)) as CapacityApi;
    const admission = {
      tenantId: 'acme',
      identityId: caller.identityId,
      identityKind: 'user' as const,
      sessionId: 'ses_1',
      sessionKind: 'user' as const,
      action: 'compute:reservations:create',
      resource: { type: 'reservation', id: 'draft' },
      decidedAt: T0,
    };
    await expect(
      call(
        'reservations',
        'create',
        lease({ devices: [{ class: 'gpu', count: 5 }], idempotencyKey: 'big' }),
        { api: policyApi, admission },
      ),
    ).rejects.toThrow(/above 4 GPUs/);
    const ok = (await call('reservations', 'create', lease(), {
      api: policyApi,
      admission,
    })) as Rsv;
    expect(ok.state).toBe('placed');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(ok.id);
  });
});

describe('the v0.4 pool-lease placer', () => {
  const batching = capacityModule({ random: () => 0, topN: 1, placer: 'pool-lease', maxBatch: 3 });
  const batchApi = batching.api!(moduleContext(db)) as CapacityApi;
  const queue = (key: string, gpus: number) =>
    call(
      'reservations',
      'create',
      create({ devices: [{ class: 'gpu', count: gpus }], idempotencyKey: key }),
      { api: batchApi },
    ) as Promise<Rsv>;
  async function runBatch(): Promise<string> {
    const reconciler = batching.reconcilers!.find((entry) => entry.name === 'capacity.placer')!;
    expect(reconciler.shardBy).toBe('pool');
    return reconciler.run({ ...moduleContext(db), signal: new AbortController().signal }, poolId);
  }
  const get = async (id: string) =>
    (await call('reservations', 'get', { tenantId: 'acme', reservationId: id })) as Rsv;

  beforeEach(async () => {
    await db.query(`UPDATE quota_usage SET max = 100`);
  });

  it('queues reservations at admission and places them in one batch', async () => {
    expect(capacityModule().reconcilers!.map((entry) => entry.name)).not.toContain(
      'capacity.placer',
    );
    const queued = [await queue('q1', 2), await queue('q2', 2), await queue('q3', 4)];
    for (const reservation of queued)
      expect(reservation).toMatchObject({
        state: 'pending',
        conditions: [expect.objectContaining({ type: 'Queued', reason: 'PoolPlacer' })],
      });
    expect(recorded.work).toContainEqual({ kind: 'capacity.placer', key: poolId });
    expect(recorded.events.map((event) => event.type)).toContain('reservation.queued');
    const { rows: none } = await db.query(`SELECT 1 FROM allocations`);
    expect(none).toEqual([]);

    expect(await runBatch()).toBe('DONE');
    for (const reservation of queued) {
      const placed = await get(reservation.id);
      expect(placed.state).toBe('placed');
      expect(placed.conditions.map((condition) => condition.type)).not.toContain('Queued');
    }
    // One in-memory index across the batch: 2 + 2 + 4 GPUs fill both 4-GPU nodes exactly.
    const { rows } = await db.query<{ node_id: string; n: string }>(
      `SELECT d.node_id, count(*)::text AS n FROM device_bookings b JOIN devices d ON d.id = b.device_id
        GROUP BY d.node_id ORDER BY d.node_id`,
    );
    expect(rows.map((row) => Number(row.n))).toEqual([4, 4]);
    expect(recorded.work).toContainEqual({
      kind: reservationWork,
      key: queued[0]!.id,
      notBefore: T0,
    });
  });

  it('places nothing in a pool archived after its reservations were queued', async () => {
    const queued = [await queue('a1', 2), await queue('a2', 2)];
    await db.query(`UPDATE pools SET archived_at = compute_now() WHERE id = $1`, [poolId]);
    await runBatch();
    for (const reservation of queued)
      expect(await get(reservation.id)).toMatchObject({
        state: 'pending',
        conditions: [
          expect.objectContaining({ type: 'Unschedulable', message: 'the pool is archived' }),
        ],
      });
    expect((await db.query(`SELECT 1 FROM allocations`)).rows).toEqual([]);
  });

  it('lets a waiting create follow its queued reservation to placed (poll, §9.1)', async () => {
    const create_ = batchApi.reservations.create as unknown as {
      poll: {
        done(output: Rsv): boolean;
        refresh(context: MethodContext, input: unknown, output: Rsv): Promise<Rsv>;
      };
    };
    const queued = await queue('wait-1', 2);
    expect(create_.poll.done(queued)).toBe(false); // running: the batch has not run
    const context = { ...moduleContext(db), caller, requestId: 'req' } as unknown as MethodContext;
    const input = { tenantId: 'acme' };
    expect(create_.poll.done(await create_.poll.refresh(context, input, queued))).toBe(false);
    await runBatch();
    const placed = await create_.poll.refresh(context, input, queued);
    expect(placed).toMatchObject({ state: 'placed', operation: { state: 'succeeded' } });
    expect(create_.poll.done(placed)).toBe(true);
  });

  it('reports one placement per reservation of a batch to onPlacement', async () => {
    const seen: { placer: string; outcome: string; conflicts: number }[] = [];
    const observed = capacityModule({
      random: () => 0,
      topN: 1,
      placer: 'pool-lease',
      onPlacement: ({ placer, outcome, conflicts }) => seen.push({ placer, outcome, conflicts }),
    });
    const observedApi = observed.api!(moduleContext(db)) as CapacityApi;
    for (const [key, gpus] of [
      ['o1', 4],
      ['o2', 4],
      ['o3', 4],
    ] as const)
      await call(
        'reservations',
        'create',
        create({ devices: [{ class: 'gpu', count: gpus }], idempotencyKey: key }),
        { api: observedApi },
      );
    await observed
      .reconcilers!.find((entry) => entry.name === 'capacity.placer')!
      .run({ ...moduleContext(db), signal: new AbortController().signal }, poolId);
    // Admission answered `queued` three times; the batch placed two and left one pending.
    expect(seen).toEqual([
      { placer: 'pool-lease', outcome: 'queued', conflicts: 0 },
      { placer: 'pool-lease', outcome: 'queued', conflicts: 0 },
      { placer: 'pool-lease', outcome: 'queued', conflicts: 0 },
      { placer: 'batch', outcome: 'placed', conflicts: 0 },
      { placer: 'batch', outcome: 'placed', conflicts: 0 },
      { placer: 'batch', outcome: 'pending', conflicts: 0 },
    ]);
  });

  it('leaves what does not fit Unschedulable, and batches at most maxBatch', async () => {
    const queued = [];
    for (const key of ['a', 'b', 'c', 'd']) queued.push(await queue(key, 4));
    // Four queued, a batch of three: two fit the two nodes, one is Unschedulable, one waits.
    const summary = async () =>
      (
        await Promise.all(
          queued.map(async (entry) => {
            const row = await get(entry.id);
            return row.state === 'placed' ? 'placed' : row.conditions.map((c) => c.type).join();
          }),
        )
      ).sort();
    expect(await runBatch()).toBe('SYNC_AGAIN');
    expect(await summary()).toEqual(['Queued', 'Unschedulable', 'placed', 'placed']);
    expect(await runBatch()).toBe('DONE');
    expect(await summary()).toEqual(['Unschedulable', 'Unschedulable', 'placed', 'placed']);
  });

  it('never double-books from a stale cached index: the guarded commit replans', async () => {
    // The worker caches the pool's index between batches (the sim clock never moves here).
    await queue('warm', 1);
    expect(await runBatch()).toBe('DONE');
    // Behind the cache's back, the inline placer fills three of the four remaining GPUs of
    // node A, and all of node B.
    await call(
      'reservations',
      'create',
      create({ devices: [{ class: 'gpu', count: 3 }], idempotencyKey: 'x1' }),
    );
    await call(
      'reservations',
      'create',
      create({ devices: [{ class: 'gpu', count: 4 }], idempotencyKey: 'x2' }),
    );
    const late = await queue('late', 2);
    await runBatch();
    // The stale index thought 2 GPUs were free somewhere; the commit found otherwise.
    const after = (await get(late.id)) as Rsv & {
      conditions: { type: string; message?: string }[];
    };
    expect(after.state).toBe('pending');
    expect(after.conditions.find((c) => c.type === 'Unschedulable')?.message).toMatch(
      /booked concurrently/,
    );
    const overlaps = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM device_bookings a JOIN device_bookings b
         ON a.device_id = b.device_id AND a.ctid < b.ctid AND a.during && b.during`,
    );
    expect(overlaps.rows[0]!.n).toBe('0');
  });

  it('places instances and gangs at once, and pending retries re-queue', async () => {
    const gang = (await call(
      'reservations',
      'create',
      create({ devices: [{ class: 'gpu', count: 1 }], gang: { size: 2 }, idempotencyKey: 'g' }),
      { api: batchApi },
    )) as Rsv;
    expect(gang.state).toBe('placed');
    const queued = await queue('later', 1);
    recorded.work = [];
    await db.transaction(async (tx) => {
      const reconciler = batching.reconcilers!.find((entry) => entry.name === reservationWork)!;
      await reconciler.run(
        { ...moduleContext(within(tx)), signal: new AbortController().signal },
        queued.id,
      );
    });
    expect(recorded.work).toContainEqual({ kind: 'capacity.placer', key: poolId });
  });
});

describe('attested bindings (v0.2, P14: a gateway-forged AllocationBound is rejected)', () => {
  // A stand-in for the server's pki-backed check: a "signature" is valid when kid is 'node-key' and
  // sig is the body's bytes reversed; the body is JSON {allocationId, cdiDevices}.
  const encoder = new TextEncoder();
  const sign = (body: object, kid = 'node-key') => {
    const bytes = encoder.encode(JSON.stringify(body));
    return { body: bytes, kid, sig: Uint8Array.from(bytes).reverse() };
  };
  const checked: { allocationId: string; nodeId: string }[] = [];
  const check: AllocationBindingCheck = async (_tx, { allocationId, nodeId, evidence }) => {
    checked.push({ allocationId, nodeId });
    const reversed = Uint8Array.from(evidence.body).reverse();
    if (evidence.kid !== 'node-key' || Buffer.compare(reversed, evidence.sig) !== 0)
      return { ok: false, reason: 'bad signature' };
    const body = JSON.parse(new TextDecoder().decode(evidence.body)) as {
      allocationId: string;
      cdiDevices: string[];
    };
    if (body.allocationId !== allocationId)
      return { ok: false, reason: 'report names another allocation' };
    return { ok: true, cdiDevices: body.cdiDevices, envFile: '' };
  };
  const attested = capacityModule({ random: () => 0, topN: 1, attestedBindings: check });
  const reconcileAttested = (key: string) =>
    attested
      .reconcilers!.find((entry) => entry.name === reservationWork)!
      .run({ ...moduleContext(db), signal: new AbortController().signal }, key);
  const get = async (id: string) =>
    (await call('reservations', 'get', { tenantId: 'acme', reservationId: id })) as Rsv;
  const allocationOf = async (id: string) =>
    (
      await db.query<{ id: string; node_id: string; bound: boolean; binding: unknown }>(
        `SELECT id, node_id, bound_at IS NOT NULL AS bound, binding FROM allocations
          WHERE owner_id = $1 AND released_at IS NULL`,
        [id],
      )
    ).rows[0]!;
  const bind = (
    allocationId: string,
    options: Parameters<typeof markAllocationBound>[4],
    cdiDevices = ['nvidia.com/gpu=claimed'],
  ) =>
    db.transaction((tx) =>
      markAllocationBound(tx, moduleContext(db).work, allocationId, { cdiDevices }, options),
    );

  it('counts a binding only once its node-signed report verifies', async () => {
    const created = (await call('reservations', 'create', create())) as Rsv;
    await reconcileAttested(created.id);
    expect((await get(created.id)).state).toBe('binding');
    const allocation = await allocationOf(created.id);

    // Another node's session cannot report it.
    expect(await bind(allocation.id, { nodeId: 'node_01jz00000000000000000000zz' })).toBe(false);
    expect((await allocationOf(created.id)).bound).toBe(false);

    // Unsigned (a gateway inventing the report): never counts, nothing billed.
    expect(await bind(allocation.id, { nodeId: allocation.node_id })).toBe(true);
    await reconcileAttested(created.id);
    expect((await get(created.id)).state).toBe('binding');
    expect(await allocationOf(created.id)).toMatchObject({
      bound: false,
      binding: { rejected: 'unsigned report' },
    });

    // Forged: signed with a key that is not the node's.
    await bind(allocation.id, {
      evidence: sign({ allocationId: allocation.id, cdiDevices: ['x'] }, 'gateway-key'),
    });
    await reconcileAttested(created.id);
    expect(await allocationOf(created.id)).toMatchObject({
      bound: false,
      binding: { rejected: 'bad signature' },
    });
    // Replayed: the node's valid report of another allocation.
    await bind(allocation.id, {
      evidence: sign({ allocationId: 'alloc_other', cdiDevices: ['x'] }),
    });
    await reconcileAttested(created.id);
    expect((await get(created.id)).state).toBe('binding');
    expect(
      recorded.events
        .filter((event) => event.type === 'reservation.binding-rejected')
        .map((event) => (event.data as { reason: string }).reason),
    ).toEqual(['unsigned report', 'bad signature', 'report names another allocation']);

    // The node's own signed report: active, with the devices it signed (not the gateway's claim).
    await bind(allocation.id, {
      nodeId: allocation.node_id,
      evidence: sign({ allocationId: allocation.id, cdiDevices: ['nvidia.com/gpu=0'] }),
    });
    await reconcileAttested(created.id);
    expect(await get(created.id)).toMatchObject({
      state: 'active',
      binding: { nodeId: allocation.node_id, cdiDevices: ['nvidia.com/gpu=0'] },
    });
    expect(checked.at(-1)).toEqual({ allocationId: allocation.id, nodeId: allocation.node_id });

    // Active: a forged re-report marks the binding lost (Degraded) instead of replacing it.
    await bind(allocation.id, { evidence: sign({ allocationId: allocation.id }, 'gateway-key') });
    await reconcileAttested(created.id);
    const degraded = await get(created.id);
    expect(degraded.state).toBe('active');
    expect(degraded.conditions).toMatchObject([{ type: 'Degraded', reason: 'BindingLost' }]);
    expect((await allocationOf(created.id)).bound).toBe(true); // billing keeps the real binding
  });

  it('judges a report stored while still placed at the start, not after the bind timeout', async () => {
    const created = (await call(
      'reservations',
      'create',
      create({ start: T0 + HOUR, idempotencyKey: 'early' }),
    )) as Rsv;
    const allocation = await allocationOf(created.id);
    await bind(allocation.id, { evidence: sign({ allocationId: allocation.id }, 'gateway-key') });
    await advance(HOUR);
    recorded.work = [];
    await reconcileAttested(created.id); // placed → binding, and straight back in
    expect((await get(created.id)).state).toBe('binding');
    expect(recorded.work).toEqual([
      { kind: reservationWork, key: created.id, notBefore: T0 + HOUR },
    ]);
    await reconcileAttested(created.id);
    expect(await allocationOf(created.id)).toMatchObject({
      bound: false,
      binding: { rejected: 'bad signature' },
    });
  });

  it('without the option, an unsigned report binds as before', async () => {
    const created = (await call('reservations', 'create', create())) as Rsv;
    await reconcile(created.id);
    const allocation = await allocationOf(created.id);
    await bind(allocation.id, {});
    await reconcile(created.id);
    expect((await get(created.id)).state).toBe('active');
  });
});

describe('host CPU and memory booked with the GPUs (§3.8)', () => {
  const NA = 'node_01jz00000000000000000000na';
  const NB = 'node_01jz00000000000000000000nb';

  // Both hosts run a bcd that enforces DeviceAssignment.limits and serves Kubernetes bindings (Hello
  // capabilities, stored as system labels); an older one gets neither (see the skew test below).
  beforeEach(async () => {
    for (const nodeId of [NA, NB])
      for (const key of [deviceLimitsCapabilityLabel, kubernetesBindingCapabilityLabel])
        await db.query(
          `INSERT INTO node_labels (node_id, key, value, source) VALUES ($1, $2, '1', 'system')`,
          [nodeId, key],
        );
  });

  it('books host resources and Kubernetes only on a bcd that enforces them (N−2 skew)', async () => {
    await hostRows({ [NA]: { vcpu: 64, memoryGiB: 512 }, [NB]: { vcpu: 64, memoryGiB: 512 } });
    // NA runs an older bcd: no capabilities. An operator label of the same name does not count.
    await db.query(`DELETE FROM node_labels WHERE node_id = $1`, [NA]);
    await db.query(
      `INSERT INTO node_labels (node_id, key, value, source) VALUES ($1, $2, '1', 'operator')`,
      [NA, deviceLimitsCapabilityLabel],
    );
    for (const key of ['skew-1', 'skew-2']) {
      const created = (await call(
        'reservations',
        'create',
        create({ idempotencyKey: key }),
      )) as Rsv;
      expect(created.state).toBe('placed');
      expect((await booked(created.id))[0]!.nodeId).toBe(NB);
    }
    // NB is full (4 GPUs); NA could take 2 GPUs but not their limits.
    const third = (await call('reservations', 'create', create({ idempotencyKey: 'skew-3' }))) as Rsv;
    expect(third.state).toBe('pending');
    // Without host resources (no rows, no share), an older bcd still takes plain GPU holds.
    await db.query(`DELETE FROM node_resources`);
    const plain = (await call('reservations', 'create', create({ idempotencyKey: 'skew-4' }))) as Rsv;
    expect(plain.state).toBe('placed');
    expect((await booked(plain.id))[0]!.nodeId).toBe(NA);
  });

  async function hostRows(rows: Record<string, Record<string, number>>): Promise<void> {
    for (const [nodeId, resources] of Object.entries(rows))
      for (const [resource, allocatable] of Object.entries(resources))
        await db.query(
          `INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated)
           VALUES ($1, $2, $3, 1, 0)`,
          [nodeId, resource, allocatable],
        );
  }

  async function booked(reservationId: string) {
    const { rows } = await db.query<{ node_id: string; resources: unknown }>(
      `SELECT node_id, resources FROM allocations WHERE owner_id = $1`,
      [reservationId],
    );
    return rows.map((row) => ({
      nodeId: row.node_id,
      resources: typeof row.resources === 'string' ? JSON.parse(row.resources) : row.resources,
    }));
  }

  async function allocated(nodeId: string) {
    const { rows } = await db.query<{ resource: string; allocated: string }>(
      `SELECT resource, allocated::text FROM node_resources WHERE node_id = $1 ORDER BY resource`,
      [nodeId],
    );
    return Object.fromEntries(rows.map((row) => [row.resource, Number(row.allocated)]));
  }

  async function storedRequest(reservationId: string) {
    const { rows } = await db.query<{ request: unknown }>(
      `SELECT request FROM reservations WHERE id = $1`,
      [reservationId],
    );
    const request = rows[0]!.request;
    return (typeof request === 'string' ? JSON.parse(request) : request) as {
      resources?: Record<string, number>;
      binding?: string;
    };
  }

  const offerQuota = (quota: Record<string, number>) =>
    call(
      'pools',
      'offer',
      { tenantId: 'root', poolId, toTenantId: 'acme', quota },
      { who: { ...caller, tenantId: 'root', identityId: 'usr_root' } },
    );
  const used = async () =>
    Object.fromEntries((await readQuotas(db, 'acme', poolId)).map((row) => [row.resource, row.used]));

  it('books what was asked on the chosen host, charges only the excess over the GPUs’ share, and frees it on release', async () => {
    // 4 GPUs per host: the share is 16 CPUs and 128 GiB per GPU.
    await hostRows({ [NA]: { vcpu: 64, memoryGiB: 512 }, [NB]: { vcpu: 64, memoryGiB: 512 } });
    await offerQuota({ gpu: 8, vcpu: 16 });
    const created = (await call(
      'reservations',
      'create',
      create({ resources: { vcpu: 40, memoryGiB: 100 } }),
    )) as Rsv;
    expect(created.state).toBe('placed');
    const [allocation] = await booked(created.id);
    // Memory is floored at the share (2 × 128 GiB); CPUs are what was asked.
    expect(allocation!.resources).toEqual({ vcpu: 40, memoryGiB: 256 });
    expect(await allocated(allocation!.nodeId)).toEqual({ memoryGiB: 256, vcpu: 40 });
    // The GPUs, plus the 8 CPUs above the 32 their share carries.
    expect(await used()).toEqual({ gpu: 2, vcpu: 8 });
    expect(recorded.authz.at(-1)?.attributes).toMatchObject({ vcpu: 40, memoryGiB: 256 });
    await call('reservations', 'release', { tenantId: 'acme', reservationId: created.id });
    expect(await allocated(allocation!.nodeId)).toEqual({ memoryGiB: 0, vcpu: 0 });
    expect(await used()).toEqual({ gpu: 0, vcpu: 0 });
  });

  it('floors resources at the share, and refuses excess beyond quota', async () => {
    await hostRows({ [NA]: { vcpu: 64, memoryGiB: 512 }, [NB]: { vcpu: 64, memoryGiB: 512 } });
    // `resources: {}` still books (and limits) the share: never GPUs without host limits.
    const empty = (await call(
      'reservations',
      'create',
      create({ resources: {}, idempotencyKey: 'empty' }),
    )) as Rsv;
    expect((await booked(empty.id))[0]!.resources).toEqual({ vcpu: 32, memoryGiB: 256 });
    // One GPU's quota never takes a host's CPUs: excess needs `vcpu` quota, and the offer has none.
    await expect(
      call('reservations', 'create', create({ resources: { vcpu: 64 }, idempotencyKey: 'greedy' })),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', details: { resource: 'vcpu' } });
  });

  it('defaults to the smallest per-GPU share among the pool’s hosts', async () => {
    // na: 16 CPUs and 128 GiB per GPU; nb: 8 CPUs and 160 GiB per GPU (4 GPUs each).
    await hostRows({ [NA]: { vcpu: 64, memoryGiB: 512 }, [NB]: { vcpu: 32, memoryGiB: 640 } });
    const created = (await call('reservations', 'create', create())) as Rsv;
    expect((await storedRequest(created.id)).resources).toEqual({ vcpu: 16, memoryGiB: 256 });
    expect((await booked(created.id))[0]!.resources).toEqual({ vcpu: 16, memoryGiB: 256 });
  });

  it('takes policy.perGpu over the derived share, per resource', async () => {
    await hostRows({ [NA]: { vcpu: 64, memoryGiB: 512 }, [NB]: { vcpu: 64, memoryGiB: 512 } });
    await db.query(`UPDATE pools SET policy = '{"perGpu":{"vcpu":6}}'::jsonb WHERE id = $1`, [poolId]);
    const created = (await call('reservations', 'create', create())) as Rsv;
    expect((await storedRequest(created.id)).resources).toEqual({ vcpu: 12, memoryGiB: 256 });
  });

  it('books nothing extra where hosts have no rows, and for slices only', async () => {
    const created = (await call('reservations', 'create', create())) as Rsv;
    expect(created.state).toBe('placed');
    expect((await storedRequest(created.id)).resources).toBeUndefined();
    expect((await booked(created.id))[0]!.resources).toEqual({});
  });

  it('previews with the same host resources create would book', async () => {
    await hostRows({ [NA]: { vcpu: 64, memoryGiB: 512 }, [NB]: { vcpu: 8, memoryGiB: 512 } });
    const fits = (await call('capacity', 'preview', create({ resources: { vcpu: 40 } }))) as {
      fits: boolean;
      candidates: { nodeId: string }[];
    };
    expect(fits.fits).toBe(true);
    expect(fits.candidates.map((candidate) => candidate.nodeId)).toEqual([NA]);
    const none = (await call('capacity', 'preview', create({ resources: { vcpu: 65 } }))) as {
      fits: boolean;
      reason?: string;
    };
    expect(none).toMatchObject({ fits: false, reason: expect.stringContaining('vcpu') });
    // Without resources, the default share (2 CPUs per GPU from nb) fits both hosts.
    const share = (await call('capacity', 'preview', create())) as { candidates: unknown[] };
    expect(share.candidates).toHaveLength(2);
  });

  it('leaves a request that fits no host pending', async () => {
    await hostRows({ [NA]: { vcpu: 64, memoryGiB: 512 }, [NB]: { vcpu: 64, memoryGiB: 512 } });
    await offerQuota({ gpu: 8, vcpu: 100 });
    const created = (await call(
      'reservations',
      'create',
      create({ resources: { vcpu: 65 } }),
    )) as Rsv;
    expect(created.state).toBe('pending');
    expect(created.conditions.map((condition) => condition.type)).toContain('Unschedulable');
  });

  it('hands bcd the booked resources as limits, on the devices’ NUMA node', async () => {
    await hostRows({ [NA]: { vcpu: 64, memoryGiB: 512, hugepages1Gi: 16 } });
    for (let index = 0; index < 4; index++)
      await db.query(
        `UPDATE devices SET attributes = attributes || jsonb_build_object('numaNode', $2::int) WHERE id = $1`,
        [`GPU-na-${index}`, index < 2 ? 0 : 1],
      );
    await db.query(`DELETE FROM node_inventory`);
    await db.query(`DELETE FROM inventory_snapshots`);
    const sections = {
      cpu: {
        threads: 64,
        // NUMA node 0 has no `id`: proto3 JSON leaves zeros out.
        numaNodes: [
          { cpus: '0-15,32-47', memoryBytes: String(256 * 2 ** 30) },
          { id: 1, cpus: '16-31,48-63', memoryBytes: String(256 * 2 ** 30) },
        ],
      },
    };
    await db.query(
      `INSERT INTO inventory_snapshots (id, node_id, sha256, section_hashes, sections, collected_at)
       VALUES ('inv_limits', $1, '\\x00', '{}', $2::jsonb, compute_now())`,
      [NA, JSON.stringify(sections)],
    );
    await db.query(`INSERT INTO node_inventory (node_id, applied_snapshot_id) VALUES ($1, 'inv_limits')`, [NA]);
    // The share is 8 CPUs and 64 GiB per GPU; the hugepages above it are charged as memory.
    await db.query(
      `UPDATE pools SET policy = '{"perGpu":{"vcpu":8,"memoryGiB":64}}'::jsonb WHERE id = $1`,
      [poolId],
    );
    await offerQuota({ gpu: 8, memoryGiB: 4 });
    const created = (await call(
      'reservations',
      'create',
      create({ resources: { vcpu: 16, memoryGiB: 128, hugepages1Gi: 4 } }),
    )) as Rsv;
    expect(await used()).toEqual({ gpu: 2, memoryGiB: 4 });
    await reconcile(created.id); // → binding
    const [assignment] = await deviceAssignments(db, NA);
    const nodes = new Set(assignment!.deviceIds.map((id) => (Number(id.slice(-1)) < 2 ? 0 : 1)));
    expect(assignment!.limits).toEqual({
      cpuMillis: 16_000,
      memoryBytes: 128 * 2 ** 30,
      hugepages1Gi: 4,
      // CPUs 0 and 1 are the host's own (policy.hostReserve.vcpu, default 2).
      cpus: nodes.size === 2 ? '2-63' : nodes.has(0) ? '2-15,32-47' : '16-31,48-63',
      mems: [...nodes].sort().join(','),
    });
    // The spec carries them to the node.
    const spec = await module.nodeSpec!(moduleContext(db), { id: NA } as never);
    expect(spec.devices!.assignments).toEqual([assignment]);
    // bcd's AllocationBound names the slice; the reservation shows where the workload must run.
    await db.transaction((tx) =>
      markAllocationBound(tx, moduleContext(db).work, assignment!.allocationId, {
        cdiDevices: ['bcd.dev/gpu=GPU-na-0'],
        cgroupParent: `bcd-alloc-${assignment!.allocationId}.slice`,
      }),
    );
    await reconcile(created.id);
    const active = (await call('reservations', 'get', {
      tenantId: 'acme',
      reservationId: created.id,
    })) as Rsv;
    expect(active.binding).toMatchObject({ cgroupParent: `bcd-alloc-${assignment!.allocationId}.slice` });
    await db.query(`DELETE FROM node_inventory`);
    await db.query(`DELETE FROM inventory_snapshots`);
  });

  it('keeps the cpuset or memory binding off when the NUMA nodes are too small or unknown', () => {
    const topology = {
      numa: new Map([
        [0, { cpus: [0, 1, 2, 3], memoryBytes: 8 * 2 ** 30 }],
        [1, { cpus: [4, 5, 6, 7], memoryBytes: 64 * 2 ** 30 }],
      ]),
      deviceNuma: new Map([
        ['g0', 0],
        ['g1', 1],
      ]),
    };
    expect(assignmentLimits({}, ['g0'], topology)).toBeUndefined();
    // 8 CPUs do not fit node 0's 4; 16 GiB do not fit its 8.
    expect(assignmentLimits({ vcpu: 8, memoryGiB: 16 }, ['g0'], topology)).toEqual({
      cpuMillis: 8000,
      memoryBytes: 16 * 2 ** 30,
    });
    expect(assignmentLimits({ vcpu: 8, memoryGiB: 16 }, ['g0', 'g1'], topology)).toEqual({
      cpuMillis: 8000,
      memoryBytes: 16 * 2 ** 30,
      cpus: '0-7',
      mems: '0,1',
    });
    // A device without a known NUMA node: no cpuset at all.
    expect(assignmentLimits({ vcpu: 2 }, ['g1', 'gx'], topology)).toEqual({ cpuMillis: 2000 });
    // The host's reserved CPUs are left out, and count against the fit.
    const reserved = { ...topology, reserved: new Set([4, 5]) };
    expect(assignmentLimits({ vcpu: 2 }, ['g1'], reserved)).toMatchObject({ cpus: '6-7' });
    expect(assignmentLimits({ vcpu: 3 }, ['g1'], reserved)).not.toHaveProperty('cpus');
    expect(parseCpuList('0-3, 8,10-9,x')).toEqual([0, 1, 2, 3, 8]);
    expect(formatCpuList([8, 3, 2, 1, 0, 10, 11])).toBe('0-3,8,10-11');
  });

  it('validates resources and the kubernetes binding', async () => {
    for (const bad of [
      create({ resources: { cpu: 4 } }),
      create({ resources: { vcpu: -1 } }),
      create({ resources: { vcpu: 1.5 } }),
      create({ resources: { vcpu: 4097 } }),
    ])
      await expect(call('reservations', 'create', bad)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    await expect(
      call('reservations', 'create', create({ binding: 'kubernetes' })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('policy.kubernetes') });
    await db.query(
      `UPDATE pools SET policy = '{"kubernetes":{"apiServer":"https://k8s.example:6443","caCertSha256":"00","joinTokenRef":"secret://k8s/join"}}'::jsonb
        WHERE id = $1`,
      [poolId],
    );
    // A tenant the pool is only offered to cannot book into its owner's cluster (review 2, M5).
    await expect(
      call('reservations', 'create', create({ binding: 'kubernetes', idempotencyKey: 'key-k8s' })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('owner') });
    const created = (await call(
      'reservations',
      'create',
      create({ tenantId: 'root', binding: 'kubernetes', idempotencyKey: 'key-k8s' }),
      { who: { ...caller, tenantId: 'root', identityId: 'usr_root' } },
    )) as Rsv;
    expect(created.state).toBe('placed');
    expect((await storedRequest(created.id)).binding).toBe('kubernetes');
    expect(recorded.authz.at(-1)?.attributes).toMatchObject({ binding: 'kubernetes' });
  });

  it('keeps a released Kubernetes binding booked until its node reports AllocationReleased', async () => {
    // The 1k sim's race: pods keep the GPUs after the kubelet loses them, so the placer must not
    // re-book them (nor the host share) before bcd says no pod holds them any more.
    await hostRows({ [NA]: { vcpu: 64, memoryGiB: 512 }, [NB]: { vcpu: 64, memoryGiB: 512 } });
    await db.query(
      `UPDATE pools SET policy = '{"kubernetes":{"apiServer":"https://k8s.example:6443","caCertSha256":"00","joinTokenRef":"secret://k8s/join"}}'::jsonb
        WHERE id = $1`,
      [poolId],
    );
    const root = { who: { ...caller, tenantId: 'root', identityId: 'usr_root' } };
    const work = moduleContext(db).work;
    const start = async (key: string) => {
      const created = (await call(
        'reservations',
        'create',
        create({ tenantId: 'root', binding: 'kubernetes', idempotencyKey: key }),
        root,
      )) as Rsv;
      await reconcile(created.id); // → binding
      const [allocation] = await booked(created.id);
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM allocations WHERE owner_id = $1`,
        [created.id],
      );
      await db.transaction((tx) =>
        markAllocationBound(tx, work, rows[0]!.id, { cdiDevices: ['bcd.dev/gpu=0'] }),
      );
      await reconcile(created.id); // → active
      return { id: created.id, allocationId: rows[0]!.id, nodeId: allocation!.nodeId };
    };
    const state = async (allocationId: string) => {
      const { rows } = await db.query<{ released: boolean; releasing: boolean; open: number }>(
        `SELECT a.released_at IS NOT NULL AS released, COALESCE(a.binding ? 'releasing', false) AS releasing,
                (SELECT count(*)::int FROM device_bookings b
                  WHERE b.allocation_id = a.id AND b.during @> compute_now()) AS open
           FROM allocations a WHERE a.id = $1`,
        [allocationId],
      );
      return rows[0]!;
    };

    const first = await start('k8s-deferred');
    expect(await allocated(first.nodeId)).toEqual({ memoryGiB: 256, vcpu: 32 });
    await call('reservations', 'release', { tenantId: 'root', reservationId: first.id }, root);
    // Released for the tenant and withdrawn from the node's spec, but still booked (and shown so).
    const get = async (id: string) =>
      (await call('reservations', 'get', { tenantId: 'root', reservationId: id }, root)) as Rsv;
    expect(await get(first.id)).toMatchObject({
      state: 'released',
      conditions: [{ type: 'DevicesHeld', status: 'true', reason: 'PodsHoldDevices', since: T0 }],
    });
    expect(await deviceAssignments(db, first.nodeId)).toEqual([]);
    expect(await state(first.allocationId)).toEqual({ released: false, releasing: true, open: 2 });
    expect(await allocated(first.nodeId)).toEqual({ memoryGiB: 256, vcpu: 32 });
    // bcd reports once the pods let go: the bookings end, the share comes back.
    expect(
      await db.transaction((tx) => markAllocationReleased(tx, work, first.allocationId)),
    ).toBe(true);
    expect(await state(first.allocationId)).toEqual({ released: true, releasing: true, open: 0 });
    expect(await allocated(first.nodeId)).toEqual({ memoryGiB: 0, vcpu: 0 });
    expect((await get(first.id)).conditions.map((entry) => entry.type)).not.toContain('DevicesHeld');
    expect(
      await db.transaction((tx) => markAllocationReleased(tx, work, first.allocationId)),
    ).toBe(false);

    // A node that will never report (lost) is closed by the hosts pass instead.
    const second = await start('k8s-lost');
    await call('reservations', 'release', { tenantId: 'root', reservationId: second.id }, root);
    expect(await db.transaction((tx) => finishStaleReleases(tx, work))).toBe(0);
    await db.query(`UPDATE nodes SET connectivity = 'lost' WHERE id = $1`, [second.nodeId]);
    expect(await db.transaction((tx) => finishStaleReleases(tx, work))).toBe(1);
    expect(await state(second.allocationId)).toMatchObject({ released: true, open: 0 });
    expect(await allocated(second.nodeId)).toEqual({ memoryGiB: 0, vcpu: 0 });
    await db.query(`UPDATE nodes SET connectivity = 'connected' WHERE id = $1`, [second.nodeId]);

    // Not bound yet: nothing holds the devices, so the release is immediate.
    const third = (await call(
      'reservations',
      'create',
      create({ tenantId: 'root', binding: 'kubernetes', idempotencyKey: 'k8s-unbound' }),
      root,
    )) as Rsv;
    await call('reservations', 'release', { tenantId: 'root', reservationId: third.id }, root);
    const [unbound] = await booked(third.id);
    expect(await allocated(unbound!.nodeId)).toEqual({ memoryGiB: 0, vcpu: 0 });

    // Pods still holding the GPUs at the booking's end (bcd: KubernetesReleaseStuck): the booking
    // is carried on a step at a time, so the GPUs are never offered while pods use them.
    const fourth = await start('k8s-stuck');
    await call('reservations', 'release', { tenantId: 'root', reservationId: fourth.id }, root);
    const bookedUntil = async () =>
      Number(
        (
          await db.query<{ end_ms: number }>(
            `SELECT max(extract(epoch FROM upper(during)) * 1000)::float8 AS end_ms
               FROM device_bookings WHERE allocation_id = $1`,
            [fourth.allocationId],
          )
        ).rows[0]!.end_ms,
      );
    expect(await bookedUntil()).toBe(T0 + 2 * HOUR);
    await advance(2 * HOUR - 60_000);
    expect(await db.transaction((tx) => finishStaleReleases(tx, work))).toBe(0);
    expect(await bookedUntil()).toBe(clock.now() + stuckReleaseStepMs);
    await advance(stuckReleaseStepMs - 60_000);
    expect(await db.transaction((tx) => finishStaleReleases(tx, work))).toBe(0);
    expect(await bookedUntil()).toBe(clock.now() + stuckReleaseStepMs);
    expect(await state(fourth.allocationId)).toEqual({ released: false, releasing: true, open: 2 });
    // A bound report meanwhile (a restarted bcd, or a node trying it) keeps the release pending
    // (review 3, MED): the report that ends it still returns the host share.
    await db.transaction((tx) =>
      markAllocationBound(tx, work, fourth.allocationId, { cdiDevices: ['bcd.dev/gpu=0'] }),
    );
    expect(await state(fourth.allocationId)).toMatchObject({ released: false, releasing: true });
    expect(
      await db.transaction((tx) => markAllocationReleased(tx, work, fourth.allocationId)),
    ).toBe(true);
    expect(await state(fourth.allocationId)).toMatchObject({ released: true, open: 0 });
    expect(await allocated(fourth.nodeId)).toEqual({ memoryGiB: 0, vcpu: 0 });

    // Carried at most maxStuckCarryMs past the booking's own end (unbilled), then closed.
    const fifth = await start('k8s-cap');
    await call('reservations', 'release', { tenantId: 'root', reservationId: fifth.id }, root);
    await advance(2 * HOUR + maxStuckCarryMs + 60_000);
    expect(await db.transaction((tx) => finishStaleReleases(tx, work))).toBe(1);
    expect(await state(fifth.allocationId)).toMatchObject({ released: true, open: 0 });
  });
});
