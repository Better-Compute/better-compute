import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apiMethod,
  ComputeError,
  draftId,
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
  markAllocationBound,
  markAllocationFailed,
  markAllocationReleased,
  readQuotas,
  reservationWork,
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
  } as unknown as ModuleContext;
}

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
  options: { deny?: boolean | ComputeError; who?: Caller } = {},
): Promise<unknown> {
  const definition = (api[group] as Record<string, CapacityApi[G][M]>)[
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
    };
  };
  const input = definition.validate(raw);
  const who = options.who ?? caller;
  const context = (tx: SqlTx) =>
    ({ ...moduleContext(within(tx)), caller: who, requestId: 'req_1' }) as MethodContext;
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
  'capacity_device_links',
  'pool_capacity_rollup',
  'device_bookings',
  'allocations',
  'reservations',
  'node_resources',
  'devices',
  'quota_usage',
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

  it('declares its migration, reconcilers and a devices node spec', () => {
    expect(module.name).toBe('capacity');
    expect(module.migrations!.map((migration) => migration.name)).toEqual([
      'capacity/0001_device_links',
    ]);
    expect(module.reconcilers!.map((reconciler) => reconciler.name)).toEqual([
      reservationWork,
      'capacity.rollup',
      'capacity.usage',
    ]);
    expect(module.reconcilers![1]!.periodic).toEqual([{ key: 'all', every: '5m' }]);
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
    await expect(call('reservations', 'create', create({ spot: true }))).rejects.toMatchObject({
      code: 'UNSUPPORTED',
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
    expect(recorded.work.at(-1)).toMatchObject({ notBefore: T0 + HOUR });

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
