import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ComputeError,
  manifest,
  manualClock,
  type Caller,
  type ExternalMachine,
  type ExternalReservation,
  type ManualClock,
  type MethodContext,
  type ModuleContext,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, capacityModule, createCapacityPort } from '@better-compute/capacity';
import {
  defineProvider,
  instanceWork,
  reservationsWork,
  vps,
  vpsMigrations,
  type ProviderReservationView,
  type VpsApi,
} from '@better-compute/vps';

// Provider capacity reservations: the vps.reservations worker reads what an account's provider
// reports into provider_reservations (events, gone marking), providerAccounts.reservations /
// bindReservation / unbindReservation expose and bind them, and instances.create on a
// reservation-backed flavor is admitted by the database so it never over-commits the reservation.
// A fake provider with a mutable reservation list stands in for GCP.

const T0 = Date.UTC(2026, 8, 24, 12);
const SITE = 'site_01jz00000000000000000000aa';
const MINUTE = 60_000;
let db: SqlExecutor;
let clock: ManualClock;

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq3w8xQy9eYyB7y0YyB alice@laptop';

// --- The fake provider --------------------------------------------------------------------------

interface FakeCloud {
  reservations: ExternalReservation[];
  machines: Map<string, ExternalMachine>;
  /** The offer ids create() received, in order. */
  created: string[];
  listCalls: number;
  failList?: Error;
  /** Thrown by every `get` (an insert the provider failed after accepting it). */
  getError?: Error;
}
const cloud: FakeCloud = { reservations: [], machines: new Map(), created: [], listCalls: 0 };

function reservation(
  name: string,
  extra: Partial<ExternalReservation> = {},
  zone = 'us-central1-a',
): ExternalReservation {
  const machineType = extra.machineType ?? 'a3-highgpu-8g';
  return {
    id: `${zone}/${name}`,
    name,
    zone,
    region: zone.replace(/-[a-z]$/, ''),
    state: 'ready',
    machineType,
    vcpu: 208,
    memoryGiB: 1872,
    gpus: { model: 'nvidia-h100-80gb', count: 8 },
    total: 2,
    inUse: 0,
    specificOnly: true,
    shared: false,
    offerId: `${zone}/${machineType}@${name}`,
    ...extra,
  };
}

const fakeGcp = defineProvider({
  id: 'fake-gcp',
  version: '1.0.0',
  provides: ['vps'],
  config: manifest({}) as never,
  create: () => ({
    async listOffers() {
      return [];
    },
    async create(request, call) {
      cloud.created.push(request.offerId);
      const existing = [...cloud.machines.values()].find(
        (machine) => machine.name === call.idempotencyKey,
      );
      if (existing) return existing;
      const machine: ExternalMachine = {
        id: `vm-${cloud.machines.size + 1}`,
        name: call.idempotencyKey,
        state: 'pending',
        offerId: request.offerId,
        addresses: [],
      };
      cloud.machines.set(machine.id, machine);
      return machine;
    },
    async get(id) {
      if (cloud.getError) throw cloud.getError;
      return cloud.machines.get(id);
    },
    async delete(id) {
      cloud.machines.delete(id);
    },
    async listReservations() {
      cloud.listCalls++;
      if (cloud.failList) throw cloud.failList;
      return structuredClone(cloud.reservations);
    },
  }),
});
const plainCloud = defineProvider({
  id: 'fake-plain',
  version: '1.0.0',
  provides: ['vps'],
  config: manifest({}) as never,
  create: () => ({
    async listOffers() {
      return [];
    },
    async create() {
      throw new Error('unused');
    },
    async get() {
      return undefined;
    },
    async delete() {},
  }),
});

// --- Harness ------------------------------------------------------------------------------------

const alice: Caller = {
  identityId: 'usr_alice',
  identityKind: 'user',
  tenantId: 'acme',
  sessionId: 's',
  sessionKind: 'user',
  mfa: false,
};
const root: Caller = { ...alice, identityId: 'usr_root', tenantId: 'root' };

const images = {
  async resolve() {
    return undefined;
  },
};

interface Published {
  type: string;
  subject: string;
  tenantId: string;
  data: Record<string, unknown>;
}
let published: Published[];
let queue: Map<string, number>;

function moduleContext(sql: SqlExecutor): ModuleContext {
  return {
    sql,
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { resolve: async (ref: string) => `resolved:${ref}` },
    capacity: createCapacityPort({ clock }, { random: () => 0, topN: 1 }),
    authz: { async upsert() {}, async remove() {}, async setPending() {} },
    events: {
      async publish(_tx: SqlTx, event: Published) {
        published.push({
          type: event.type,
          subject: event.subject,
          tenantId: event.tenantId,
          data: event.data,
        });
      },
    },
    work: {
      async enqueue(_tx: SqlTx, kind: string, key: string, options?: { notBefore?: number }) {
        if (kind === reservationsWork) queue.set(key, options?.notBefore ?? clock.now());
      },
    },
    desired: { async invalidate() {} },
  } as unknown as ModuleContext;
}

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

const module = vps({ providers: [fakeGcp, plainCloud], images, reservations: { every: '5m' } });
const api = module.api!({} as ModuleContext) as VpsApi;
const capacityApi = capacityModule({ random: () => 0, topN: 1 }).api!(
  {} as ModuleContext,
) as unknown as Record<string, Record<string, unknown>>;

type Definition = {
  validate(raw: unknown): unknown;
  handler(context: MethodContext, input: unknown): Promise<unknown>;
  admission?: {
    prepare(
      context: MethodContext,
      input: unknown,
      tx: SqlTx,
    ): Promise<{ status: string; result?: unknown }>;
  };
};

async function run(definition: Definition, raw: unknown, who: Caller): Promise<unknown> {
  const input = definition.validate(raw);
  const context = (tx: SqlTx) =>
    ({ ...moduleContext(within(tx)), caller: who, requestId: 'req' }) as MethodContext;
  if (definition.admission) {
    const plan = await db.transaction((tx) =>
      definition.admission!.prepare(context(tx), input, tx),
    );
    if (plan.status === 'replay') return plan.result;
  }
  return db.transaction((tx) => definition.handler(context(tx), input));
}
const call = (group: keyof VpsApi, method: string, raw: unknown, who: Caller = root) =>
  run((api[group] as unknown as Record<string, Definition>)[method]!, raw, who);
const callCapacity = (method: string, raw: unknown) =>
  run(capacityApi.pools![method] as Definition, raw, root);

const reconciler = (name: string) => module.reconcilers!.find((entry) => entry.name === name)!;
const runnable = () => ({ ...moduleContext(db), signal: new AbortController().signal });

/** The periodic `all` pass, then every account it (or a rate limit) queued that is due. */
async function pass(): Promise<void> {
  await reconciler(reservationsWork).run(runnable(), 'all');
  for (const [key, at] of [...queue]) {
    if (at > clock.now()) continue;
    queue.delete(key);
    await reconciler(reservationsWork).run(runnable(), key);
  }
}
async function advance(ms: number): Promise<void> {
  clock.advance(ms);
  await useSimClock(db, clock.now());
}
const reconcileInstance = async (instanceId: string) =>
  reconciler(instanceWork).run(runnable(), instanceId);

const eventsOf = (type: string) => published.filter((event) => event.type === type);

type View = { id: string; state: string; externalId?: string };
let accountId: string;
let providerPool: string;
let rsvFlavor: string;

const tables = [
  'provider_reservation_scans',
  'provider_reservations',
  'usage_windows',
  'instances',
  'flavors',
  'quota_usage',
  'pool_capacity_rollup',
  'pool_offers',
  'pools',
  'provider_accounts',
  'sites',
];

async function newAccount(provider = 'fake-gcp', accountName = 'main'): Promise<string> {
  return (
    (await call('providerAccounts', 'create', {
      tenantId: 'root',
      provider,
      name: accountName,
      config: {},
    })) as { id: string }
  ).id;
}
async function newPool(account: string): Promise<string> {
  const pool = (await callCapacity('create', {
    tenantId: 'root',
    siteId: SITE,
    class: 'provider',
    providerAccountId: account,
  })) as { id: string };
  await callCapacity('offer', {
    tenantId: 'root',
    poolId: pool.id,
    toTenantId: 'acme',
    quota: { vcpu: 4000, memoryGiB: 40_000, diskGiB: 40_000, gpu: 100 },
  });
  return pool.id;
}

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations, ...vpsMigrations]);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  for (const table of tables) await db.query(`DELETE FROM ${table}`);
  clock = manualClock(T0);
  await useSimClock(db, T0);
  published = [];
  queue = new Map();
  cloud.reservations = [];
  cloud.machines.clear();
  cloud.created = [];
  cloud.listCalls = 0;
  delete cloud.failList;
  delete cloud.getError;
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, 'root', 'shared', 'eu', 1)`,
    [SITE],
  );
  accountId = await newAccount();
  providerPool = await newPool(accountId);
  published = [];
});

const listed = async (includeGone = false) =>
  (
    (await call('providerAccounts', 'reservations', {
      tenantId: 'root',
      accountId,
      ...(includeGone ? { includeGone } : {}),
    })) as { items: ProviderReservationView[] }
  ).items;
const rows = async () =>
  (
    await db.query<{ reservation_id: string; gone_at: Date | null; total: number; in_use: number }>(
      `SELECT reservation_id, gone_at, total, in_use FROM provider_reservations
        WHERE account_id = $1 ORDER BY reservation_id`,
      [accountId],
    )
  ).rows;

describe('the vps.reservations worker', () => {
  it('detects reservations and publishes detected', async () => {
    cloud.reservations = [
      reservation('rsv-a'),
      reservation('rsv-b', { total: 1, machineType: 'a3-megagpu-8g' }),
    ];
    await pass();
    expect((await rows()).map((row) => row.reservation_id)).toEqual([
      'us-central1-a/rsv-a',
      'us-central1-a/rsv-b',
    ]);
    const detected = eventsOf('provider.reservation.detected');
    expect(detected).toHaveLength(2);
    expect(detected[0]).toMatchObject({
      subject: `provider-account/${accountId}`,
      tenantId: 'root',
      data: {
        accountId,
        reservationId: 'us-central1-a/rsv-a',
        machineType: 'a3-highgpu-8g',
        gpus: { model: 'nvidia-h100-80gb', count: 8 },
        total: 2,
        state: 'ready',
      },
    });
    expect(published.map((event) => event.type)).toEqual([
      'provider.reservation.detected',
      'provider.reservation.detected',
    ]);
    expect((await listed()).map((item) => [item.name, item.free, item.pending])).toEqual([
      ['rsv-a', 2, 0],
      ['rsv-b', 1, 0],
    ]);
  });

  it('does not rescan an account before its next pass is due', async () => {
    cloud.reservations = [reservation('rsv-a')];
    await pass();
    await advance(MINUTE);
    await pass();
    expect(cloud.listCalls).toBe(1);
    await advance(5 * MINUTE);
    await pass();
    expect(cloud.listCalls).toBe(2);
    expect(eventsOf('provider.reservation.detected')).toHaveLength(1);
  });

  it('publishes changed with free when inUse changes', async () => {
    cloud.reservations = [reservation('rsv-a', { total: 3 })];
    await pass();
    published = [];
    cloud.reservations = [reservation('rsv-a', { total: 3, inUse: 1 })];
    await advance(6 * MINUTE);
    await pass();
    expect(published.map((event) => event.type)).toEqual(['provider.reservation.changed']);
    expect(published[0]!.data).toMatchObject({
      reservationId: 'us-central1-a/rsv-a',
      total: 3,
      inUse: 1,
      free: 2,
      changes: ['inUse'],
    });
    expect((await rows())[0]).toMatchObject({ total: 3, in_use: 1 });
    // Nothing changed: nothing published.
    published = [];
    await advance(6 * MINUTE);
    await pass();
    expect(published).toEqual([]);
  });

  it('a creating reservation becoming ready publishes ready', async () => {
    cloud.reservations = [reservation('rsv-a', { state: 'creating' })];
    await pass();
    cloud.reservations = [reservation('rsv-a', { state: 'ready' })];
    await advance(6 * MINUTE);
    await pass();
    expect(published.map((event) => event.type)).toEqual([
      'provider.reservation.detected',
      'provider.reservation.changed',
      'provider.reservation.ready',
    ]);
    expect(eventsOf('provider.reservation.ready')[0]!.data).toMatchObject({
      reservationId: 'us-central1-a/rsv-a',
      state: 'ready',
    });
  });

  it('a future reservation becoming fulfilled publishes ready for the on-demand reservation', async () => {
    const startsAt = T0 + 3 * 24 * 60 * MINUTE;
    cloud.reservations = [reservation('rsv-future', { state: 'scheduled', startsAt, total: 4 })];
    await pass();
    expect(eventsOf('provider.reservation.detected')[0]!.data).toMatchObject({
      state: 'scheduled',
      startsAt,
    });
    // GCP fulfils it: the future reservation is done and an on-demand reservation of the same name
    // (here under another id, as a shared-in or renamed one would be) is ready.
    cloud.reservations = [
      reservation('rsv-future', {
        id: 'us-central1-b/rsv-future',
        zone: 'us-central1-b',
        total: 4,
      }),
    ];
    await advance(6 * MINUTE);
    published = [];
    await pass();
    expect(eventsOf('provider.reservation.ready').map((event) => event.data.reservationId)).toEqual(
      ['us-central1-b/rsv-future'],
    );
    // The old scheduled one is not reported any more.
    expect(eventsOf('provider.reservation.gone').map((event) => event.data.reservationId)).toEqual([
      'us-central1-a/rsv-future',
    ]);
  });

  it('a scheduled reservation that turns ready in place publishes ready', async () => {
    cloud.reservations = [reservation('rsv-future', { state: 'scheduled', startsAt: T0 + 1000 })];
    await pass();
    cloud.reservations = [reservation('rsv-future', { state: 'ready' })];
    await advance(6 * MINUTE);
    await pass();
    expect(eventsOf('provider.reservation.ready')).toHaveLength(1);
  });

  it('gone reservations are marked', async () => {
    cloud.reservations = [reservation('rsv-a'), reservation('rsv-b')];
    await pass();
    cloud.reservations = [reservation('rsv-a')];
    await advance(6 * MINUTE);
    published = [];
    await pass();
    expect(published.map((event) => [event.type, event.data.reservationId])).toEqual([
      ['provider.reservation.gone', 'us-central1-a/rsv-b'],
    ]);
    const stored = await rows();
    expect(stored.find((row) => row.reservation_id.endsWith('rsv-b'))!.gone_at).not.toBeNull();
    expect(stored.find((row) => row.reservation_id.endsWith('rsv-a'))!.gone_at).toBeNull();
    expect((await listed()).map((item) => item.name)).toEqual(['rsv-a']);
    const withGone = await listed(true);
    expect(withGone.map((item) => [item.name, item.goneAt !== undefined])).toEqual([
      ['rsv-a', false],
      ['rsv-b', true],
    ]);
    // It comes back: no longer gone.
    cloud.reservations = [reservation('rsv-a'), reservation('rsv-b')];
    await advance(6 * MINUTE);
    await pass();
    expect((await rows()).every((row) => row.gone_at === null)).toBe(true);
  });

  it('skips providers without listReservations', async () => {
    const plain = await newAccount('fake-plain', 'plain');
    cloud.reservations = [reservation('rsv-a')];
    await pass();
    const scans = await db.query<{ account_id: string }>(
      `SELECT account_id FROM provider_reservation_scans`,
    );
    expect(scans.rows).toEqual([{ account_id: accountId }]);
    expect(scans.rows.some((row) => row.account_id === plain)).toBe(false);
    await reconciler(reservationsWork).run(runnable(), plain);
    expect(
      (await db.query(`SELECT 1 FROM provider_reservations WHERE account_id = $1`, [plain])).rows,
    ).toEqual([]);
    expect(published.map((event) => event.subject)).toEqual([`provider-account/${accountId}`]);
  });

  it('a failing provider keeps what is known; a rate limit defers the account, not the worker', async () => {
    cloud.reservations = [reservation('rsv-a')];
    await pass();
    published = [];
    cloud.failList = new ComputeError('RATE_LIMITED', 'slow down', undefined, {
      retryAfterMs: 30_000,
    });
    await advance(6 * MINUTE);
    await pass();
    expect(queue.get(accountId)).toBe(clock.now() + 30_000);
    expect(published).toEqual([]);
    expect((await rows()).every((row) => row.gone_at === null)).toBe(true);
    const scan = await db.query<{ last_error: string | null }>(
      `SELECT last_error FROM provider_reservation_scans WHERE account_id = $1`,
      [accountId],
    );
    expect(scan.rows[0]!.last_error).toMatch(/RATE_LIMITED/);
    // Another error is recorded too, and the next periodic pass retries.
    cloud.failList = new ComputeError('PROVIDER_ERROR', 'boom');
    await advance(MINUTE);
    queue.clear();
    await pass();
    expect((await rows()).every((row) => row.gone_at === null)).toBe(true);
    delete cloud.failList;
    await advance(6 * MINUTE);
    await pass();
    const healed = await db.query<{ last_error: string | null }>(
      `SELECT last_error FROM provider_reservation_scans WHERE account_id = $1`,
      [accountId],
    );
    expect(healed.rows[0]!.last_error).toBeNull();
  });
});

describe('api & admission', () => {
  const bind = (extra: Record<string, unknown> = {}) =>
    call('providerAccounts', 'bindReservation', {
      tenantId: 'root',
      accountId,
      reservationId: 'us-central1-a/rsv-a',
      poolId: providerPool,
      idempotencyKey: 'bind-1',
      ...extra,
    }) as Promise<{ poolId: string; flavorId: string }>;
  const create = (key: string, flavor = 'rsv-rsv-a') =>
    call(
      'instances',
      'create',
      {
        tenantId: 'acme',
        poolId: providerPool,
        flavor,
        imageId: 'ubuntu-24.04',
        sshKeys: [KEY],
        idempotencyKey: key,
      },
      alice,
    ) as Promise<View>;
  const flavorsOf = async (poolId = providerPool) =>
    (
      (await call('flavors', 'list', { tenantId: 'root', poolId })) as {
        items: {
          id: string;
          name: string;
          offerId?: string;
          vcpu: number;
          gpus: number;
          diskGiB: number;
        }[];
      }
    ).items;

  beforeEach(async () => {
    cloud.reservations = [reservation('rsv-a', { total: 2, inUse: 1 })];
    await pass();
    rsvFlavor = 'rsv-rsv-a';
  });

  it('reservations lists free and pending', async () => {
    await bind();
    expect(await listed()).toMatchObject([
      { id: 'us-central1-a/rsv-a', total: 2, inUse: 1, free: 1, pending: 0 },
    ]);
    await create('vm-1');
    expect(await listed()).toMatchObject([
      { total: 2, inUse: 1, free: 0, pending: 1, poolId: providerPool },
    ]);
  });

  it('bindReservation creates a flavor with the reservation offer', async () => {
    const bound = await bind();
    expect(bound.poolId).toBe(providerPool);
    const flavor = (await flavorsOf()).find((item) => item.name === rsvFlavor);
    expect(flavor).toMatchObject({
      id: bound.flavorId,
      offerId: 'us-central1-a/a3-highgpu-8g@rsv-a',
      vcpu: 208,
      gpus: 8,
      diskGiB: 100,
    });
    expect((await listed())[0]).toMatchObject({ poolId: providerPool, flavorId: bound.flavorId });
    // Repeating it is a replay; a custom flavor name is honoured elsewhere.
    expect(await bind()).toEqual(bound);
    expect((await flavorsOf()).filter((item) => item.name === rsvFlavor)).toHaveLength(1);
  });

  it('binding the same reservation to another pool is a CONFLICT', async () => {
    await bind();
    const other = await newPool(accountId);
    await expect(bind({ poolId: other })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await flavorsOf(other)).toEqual([]);
  });

  it('refuses binding to a pool backed by another account', async () => {
    const otherAccount = await newAccount('fake-gcp', 'other');
    const otherPool = await newPool(otherAccount);
    await expect(bind({ poolId: otherPool })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(bind({ poolId: 'pool_01jz0000000000000000000zzz' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(bind({ reservationId: 'us-central1-a/nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await flavorsOf(otherPool)).toEqual([]);
  });

  it('instances.create on a bound flavor consumes the reservation in the provider', async () => {
    await bind();
    const created = await create('vm-1');
    await reconcileInstance(created.id);
    expect(cloud.created).toEqual(['us-central1-a/a3-highgpu-8g@rsv-a']);
    const stored = await db.query<{ provider_reservation: string | null }>(
      `SELECT provider_reservation FROM instances WHERE id = $1`,
      [created.id],
    );
    expect(stored.rows[0]!.provider_reservation).toBe('us-central1-a/rsv-a');
  });

  it('a flavor that is not a reservation is admitted as before', async () => {
    await call('flavors', 'create', {
      tenantId: 'root',
      poolId: providerPool,
      name: 'plain',
      vcpu: 2,
      memoryGiB: 4,
      diskGiB: 40,
      offerId: 'n2-standard-2',
    });
    const created = await create('vm-plain', 'plain');
    await reconcileInstance(created.id);
    expect(cloud.created).toEqual(['n2-standard-2']);
    const stored = await db.query(`SELECT 1 FROM instances WHERE provider_reservation IS NOT NULL`);
    expect(stored.rows).toEqual([]);
  });

  it('admits only the free slots between polls', async () => {
    await bind();
    // total 2, inUse 1: one slot, two creates at once.
    const outcomes = await Promise.allSettled([create('race-1'), create('race-2')]);
    const admitted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { reservationId: 'us-central1-a/rsv-a', total: 2, inUse: 1, pending: 1 },
    });
    // The refusal leaves nothing admitted: one instance holds the slot.
    const holding = await db.query(
      `SELECT 1 FROM instances WHERE provider_reservation = 'us-central1-a/rsv-a' AND NOT draft`,
    );
    expect(holding.rows).toHaveLength(1);
    // Later attempts are refused too, until a poll shows it freed.
    await expect(create('later')).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE' });
  });

  it('a created VM counts once observed', async () => {
    await bind();
    await advance(MINUTE);
    const created = await create('vm-1');
    await reconcileInstance(created.id);
    expect((await listed())[0]).toMatchObject({ pending: 1, free: 0 });
    // The provider now counts the VM; the next pass was observed after the instance's machine existed.
    cloud.reservations = [reservation('rsv-a', { total: 2, inUse: 2 })];
    await advance(6 * MINUTE);
    await pass();
    expect((await listed())[0]).toMatchObject({ inUse: 2, pending: 0, free: 0 });
  });

  it('a VM created after a scan began stays pending until a later scan', async () => {
    await bind();
    await advance(MINUTE);
    const created = await create('vm-1');
    // A scan runs before the machine exists (the provider shows inUse 1) ...
    await advance(5 * MINUTE);
    await pass();
    expect((await listed())[0]).toMatchObject({ inUse: 1, pending: 1, free: 0 });
    // ... and the machine is created after it: that scan cannot have counted it.
    await advance(MINUTE);
    await reconcileInstance(created.id);
    expect((await listed())[0]).toMatchObject({ pending: 1, free: 0 });
    await expect(create('vm-2')).rejects.toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { pending: 1 },
    });
    cloud.reservations = [reservation('rsv-a', { total: 2, inUse: 2 })];
    await advance(6 * MINUTE);
    await pass();
    expect((await listed())[0]).toMatchObject({ inUse: 2, pending: 0, free: 0 });
  });

  it('a deleted instance gives its slot back at once', async () => {
    await bind();
    const created = await create('vm-1');
    await expect(create('vm-2')).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE' });
    await call('instances', 'delete', { tenantId: 'acme', instanceId: created.id }, alice);
    await reconcileInstance(created.id);
    expect((await listed())[0]).toMatchObject({ pending: 0, free: 1 });
    await create('vm-3');
  });

  it('a create the provider failed (ProvisionFailed) gives its slot back at once', async () => {
    await bind();
    await advance(MINUTE);
    const created = await create('vm-1');
    await reconcileInstance(created.id);
    expect((await listed())[0]).toMatchObject({ pending: 1, free: 0 });
    // GCP accepted the insert, then failed it: the instance never holds a reserved VM.
    cloud.getError = new ComputeError('CAPACITY_UNAVAILABLE', 'ZONE_RESOURCE_POOL_EXHAUSTED');
    await reconcileInstance(created.id);
    const failed = await db.query<{ state: string }>(`SELECT state FROM instances WHERE id = $1`, [
      created.id,
    ]);
    expect(failed.rows[0]!.state).toBe('error');
    expect((await listed())[0]).toMatchObject({ pending: 0, free: 1 });
    delete cloud.getError;
    await create('vm-2');
  });

  it('a scheduled future reservation is listed but refuses bind until ready', async () => {
    cloud.reservations = [
      reservation('rsv-a', { total: 2, inUse: 1 }),
      reservation('rsv-future', { state: 'scheduled', startsAt: T0 + 86_400_000, total: 4 }),
    ];
    await advance(6 * MINUTE);
    await pass();
    expect(await listed()).toMatchObject([
      { name: 'rsv-a' },
      { name: 'rsv-future', state: 'scheduled' },
    ]);
    const future = { reservationId: 'us-central1-a/rsv-future', flavorName: 'future' };
    await expect(bind(future)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: expect.stringMatching(/once it is ready/),
      details: { reservationId: 'us-central1-a/rsv-future', state: 'scheduled' },
    });
    expect((await flavorsOf()).map((item) => item.name)).toEqual([]);
    cloud.reservations = [
      reservation('rsv-a', { total: 2, inUse: 1 }),
      reservation('rsv-future', { total: 4 }),
    ];
    await advance(6 * MINUTE);
    await pass();
    const bound = await bind(future);
    expect(bound.flavorId).toMatch(/^flv_/);
    await create('ready', 'future');
  });

  it('a bound reservation that stops being ready is not admissible', async () => {
    await bind();
    cloud.reservations = [reservation('rsv-a', { total: 2, inUse: 1, state: 'updating' })];
    await advance(6 * MINUTE);
    await pass();
    await expect(create('vm-1')).rejects.toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { reservationId: 'us-central1-a/rsv-a', state: 'updating' },
    });
  });

  it('refuses binding a reservation that is not ready, or is gone', async () => {
    cloud.reservations = [reservation('rsv-a'), reservation('rsv-bad', { state: 'error' })];
    await advance(6 * MINUTE);
    await pass();
    await expect(bind({ reservationId: 'us-central1-a/rsv-bad' })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    cloud.reservations = [reservation('rsv-bad', { state: 'error' })];
    await advance(6 * MINUTE);
    await pass();
    await expect(bind()).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('unbind removes the unused flavor', async () => {
    await bind();
    expect(
      await call('providerAccounts', 'unbindReservation', {
        tenantId: 'root',
        accountId,
        reservationId: 'us-central1-a/rsv-a',
      }),
    ).toEqual({ reservationId: 'us-central1-a/rsv-a' });
    expect((await flavorsOf()).map((item) => item.name)).toEqual([]);
    expect((await listed())[0]!.poolId).toBeUndefined();
    expect((await listed())[0]!.flavorId).toBeUndefined();
    // Unbinding again is fine, and the reservation can be bound again.
    await call('providerAccounts', 'unbindReservation', {
      tenantId: 'root',
      accountId,
      reservationId: 'us-central1-a/rsv-a',
    });
    await bind();
  });

  it('unbind archives a flavor instances still use', async () => {
    await bind();
    const created = await create('vm-1');
    await call('providerAccounts', 'unbindReservation', {
      tenantId: 'root',
      accountId,
      reservationId: 'us-central1-a/rsv-a',
    });
    const flavor = await db.query<{ archived: boolean }>(
      `SELECT archived FROM flavors WHERE name = $1`,
      [rsvFlavor],
    );
    expect(flavor.rows).toEqual([{ archived: true }]);
    expect(await flavorsOf()).toEqual([]);
    await expect(create('vm-2')).rejects.toMatchObject({
      code: expect.stringMatching(/NOT_FOUND|INVALID/),
    });
    expect(created.id).toMatch(/^inst_/);
  });

  it('a bound reservation that goes gone drops its flavor', async () => {
    const bound = await bind();
    cloud.reservations = [];
    await advance(6 * MINUTE);
    published = [];
    await pass();
    expect(eventsOf('provider.reservation.gone')).toMatchObject([
      {
        data: {
          accountId,
          reservationId: 'us-central1-a/rsv-a',
          poolId: providerPool,
          flavorId: bound.flavorId,
        },
      },
    ]);
    expect((await flavorsOf()).map((item) => item.name)).toEqual([]);
    const [row] = await listed(true);
    expect(row).toMatchObject({ id: 'us-central1-a/rsv-a' });
    expect(row!.poolId).toBeUndefined();
  });

  it('listing and binding are scoped to the tenant that owns the account', async () => {
    await expect(
      call('providerAccounts', 'reservations', { tenantId: 'acme', accountId }, alice),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      call(
        'providerAccounts',
        'bindReservation',
        {
          tenantId: 'acme',
          accountId,
          reservationId: 'us-central1-a/rsv-a',
          poolId: providerPool,
          idempotencyKey: 'x',
        },
        alice,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
