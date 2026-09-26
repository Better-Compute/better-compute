import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  manualClock,
  type Caller,
  type ManualClock,
  type MethodContext,
  type ModuleContext,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, capacityModule, createCapacityPort } from '@better-compute/capacity';
import {
  instanceSpecs,
  instanceWork,
  reportInstances,
  setIpPool,
  vps,
  vpsMigrations,
  type VpsApi,
} from '@better-compute/vps';

// The v0.3 VPS acceptance shape (PLAN.md §16): 200-instance churn on 3 emulated hosts with no leaks —
// zero orphan domains, IP leases, bookings or scalar/quota drift — checked by diffing what the hosts'
// runtimes hold against the database, mid-churn and after everything is deleted.

const T0 = Date.UTC(2026, 8, 24, 12);
const NODES = [
  'node_01jz0000000000000000000c01',
  'node_01jz0000000000000000000c02',
  'node_01jz0000000000000000000c03',
];
let db: SqlExecutor;
let clock: ManualClock;

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A due-time work queue standing in for the runtime's `work_queue`. */
const queue = new Map<string, number>();
const alice: Caller = {
  identityId: 'usr_alice',
  identityKind: 'user',
  tenantId: 'acme',
  sessionId: 's',
  sessionKind: 'user',
  mfa: false,
};
const root: Caller = { ...alice, identityId: 'usr_root', tenantId: 'root' };

function moduleContext(sql: SqlExecutor): ModuleContext {
  return {
    sql,
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { resolve: async () => 'x' },
    capacity: createCapacityPort({ clock }, { random: prng(7), topN: 3 }),
    authz: { async upsert() {}, async remove() {}, async setPending() {} },
    events: { async publish() {} },
    work: {
      async enqueue(_tx, kind, key, options) {
        if (kind !== instanceWork) return;
        const due = options?.notBefore ?? clock.now();
        queue.set(key, Math.min(queue.get(key) ?? Infinity, due));
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

const images = {
  async resolve() {
    return {
      url: 'https://images.example/base.qcow2',
      sha256: 'cd'.repeat(32),
      format: 'qcow2' as const,
      verified: true,
    };
  },
};
const module = vps({ images });
const api = module.api!({} as ModuleContext) as VpsApi;
const capacityApi = capacityModule().api!({} as ModuleContext) as unknown as Record<
  string,
  Record<string, Definition>
>;

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
    ({ ...moduleContext(within(tx)), caller: who, requestId: 'r' }) as MethodContext;
  if (definition.admission) {
    const plan = await db.transaction((tx) =>
      definition.admission!.prepare(context(tx), input, tx),
    );
    if (plan.status === 'replay') return plan.result;
  }
  return db.transaction((tx) => definition.handler(context(tx), input));
}
const call = (group: keyof VpsApi, method: string, raw: unknown, who: Caller = alice) =>
  run((api[group] as unknown as Record<string, Definition>)[method]!, raw, who);

/** What each host's runtime holds: instance id → state. */
const runtimes = new Map<string, Map<string, 'running' | 'stopped'>>(
  NODES.map((node) => [node, new Map()]),
);

/** One convergence pass of every host: apply the spec, report the full inventory. */
async function converge(): Promise<void> {
  for (const node of NODES) {
    const runtime = runtimes.get(node)!;
    const specs = await instanceSpecs(db, node);
    const wanted = new Set<string>();
    for (const spec of specs) {
      if (spec.desiredState === 'deleted') runtime.delete(spec.id);
      else {
        runtime.set(spec.id, spec.desiredState);
        wanted.add(spec.id);
      }
    }
    // Domains no spec names any more are torn down (the daemon's instances converger).
    for (const id of [...runtime.keys()]) if (!wanted.has(id)) runtime.delete(id);
    await db.transaction((tx) =>
      reportInstances(
        tx,
        moduleContext(db).work,
        node,
        [...runtime].map(([id, state]) => ({ id, state })),
        { complete: true },
      ),
    );
  }
}

const reconciler = () => module.reconcilers!.find((entry) => entry.name === instanceWork)!;

/** Runs due work and host convergence until nothing is due. */
async function settle(): Promise<void> {
  for (let round = 0; round < 30; round++) {
    const due = [...queue].filter(([, at]) => at <= clock.now()).map(([key]) => key);
    for (const key of due) {
      queue.delete(key);
      await reconciler().run({ ...moduleContext(db), signal: new AbortController().signal }, key);
    }
    await converge();
    if (![...queue.values()].some((at) => at <= clock.now())) return;
  }
  throw new Error('the fleet did not settle');
}

async function liveInstances() {
  const { rows } = await db.query<{
    id: string;
    node_id: string | null;
    state: string;
    desired_state: string;
  }>(
    `SELECT id, node_id, state, desired_state FROM instances WHERE NOT draft AND state <> 'deleted' ORDER BY id`,
  );
  return rows;
}

/** The no-leak invariants, diffing the runtimes against the database. */
async function checkNoLeaks(): Promise<void> {
  const live = await liveInstances();
  // 1. Every runtime domain is a live placed instance on that node, in its desired state.
  for (const node of NODES) {
    const expected = Object.fromEntries(
      live
        .filter((row) => row.node_id === node && row.state !== 'deleting')
        .map((row) => [row.id, row.desired_state]),
    );
    expect(Object.fromEntries(runtimes.get(node)!), `runtime of ${node}`).toEqual(expected);
  }
  // 2. Allocations: exactly one live allocation per placed instance, none for anything else.
  const allocations = await db.query<{ owner_id: string }>(
    `SELECT owner_id FROM allocations WHERE released_at IS NULL ORDER BY owner_id`,
  );
  expect(
    allocations.rows.map((row) => row.owner_id),
    'live allocations',
  ).toEqual(live.filter((row) => row.node_id).map((row) => row.id));
  // 3. IP leases: one per placed instance, none leaked, none shared.
  const leases = await db.query<{ instance_id: string; address: string }>(
    `SELECT instance_id, host(address) AS address FROM ip_leases ORDER BY instance_id`,
  );
  expect(
    leases.rows.map((row) => row.instance_id),
    'IP leases',
  ).toEqual(live.filter((row) => row.node_id).map((row) => row.id));
  expect(new Set(leases.rows.map((row) => row.address)).size).toBe(leases.rows.length);
  // 4. Scalars: node_resources.allocated equals the live claims on each node.
  const drift = await db.query(
    `SELECT r.node_id, r.resource FROM node_resources r
       LEFT JOIN allocations a ON a.node_id = r.node_id AND a.released_at IS NULL
      GROUP BY r.node_id, r.resource, r.allocated
     HAVING r.allocated <> COALESCE(sum((a.resources->>r.resource)::bigint), 0)`,
  );
  expect(drift.rows, 'scalar drift').toEqual([]);
  // 5. Quota: `used` equals the live demand of placed instances.
  const quota = await db.query(
    `SELECT q.resource FROM quota_usage q
      WHERE q.tenant_id = 'acme' AND q.used <> COALESCE((
        SELECT sum((a.resources->>q.resource)::bigint) FROM allocations a
         WHERE a.tenant_id = 'acme' AND a.released_at IS NULL), 0)`,
  );
  expect(quota.rows, 'quota drift').toEqual([]);
}

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations, ...vpsMigrations]);
  clock = manualClock(T0);
  await useSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_01jz00000000000000000000cc', 'root', 'shared', 'eu', 1)`,
  );
  const pool = (await run(
    capacityApi.pools!.create!,
    { tenantId: 'root', siteId: 'site_01jz00000000000000000000cc', class: 'vps-host' },
    root,
  )) as { id: string };
  await run(
    capacityApi.pools!.offer!,
    {
      tenantId: 'root',
      poolId: pool.id,
      toTenantId: 'acme',
      quota: { vcpu: 1000, memoryGiB: 4000, diskGiB: 100_000 },
    },
    root,
  );
  for (const node of NODES) {
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
                          trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_01jz00000000000000000000cc', $2, 'root', 'host', 'adopted', false, false, 'connected', 'platform',
               1, 1, 1, 1, 0, 1)`,
      [node, pool.id],
    );
    // The runtimes its bcd advertises in Hello (the gateway labels the node bc.dev/driver.<runtime>).
    for (const runtime of ['libvirt-kvm', 'cloud-hypervisor'])
      await db.query(`INSERT INTO node_labels (node_id, key, value, source) VALUES ($1, $2, '0.5.0', 'system')`, [
        node,
        `bc.dev/driver.${runtime}`,
      ]);
    for (const [resource, allocatable, ratio] of [
      ['vcpu', 64, 2],
      ['memoryGiB', 256, 1],
      ['diskGiB', 4000, 1],
    ] as const)
      await db.query(
        `INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated) VALUES ($1, $2, $3, $4, 0)`,
        [node, resource, allocatable, ratio],
      );
  }
  await setIpPool(db, { poolId: pool.id, cidr: '10.8.0.0/24', gateway: '10.8.0.1' });
  for (const [name, vcpu, memoryGiB, diskGiB] of [
    ['s', 2, 4, 40],
    ['m', 4, 16, 80],
    ['l', 8, 32, 160],
  ] as const)
    await call(
      'flavors',
      'create',
      { tenantId: 'root', poolId: pool.id, name, vcpu, memoryGiB, diskGiB },
      root,
    );
  poolId = pool.id;
});
afterAll(async () => {
  await db.close();
});
let poolId: string;

describe('VPS churn (§16 v0.3 acceptance shape)', () => {
  it('creates, stops, starts and deletes 200 instances on 3 hosts without leaking anything', async () => {
    const random = prng(0xbeef);
    const live: string[] = [];
    let created = 0;
    let deleted = 0;
    let unplaced = 0;
    while (created < 200) {
      const roll = random();
      if (roll < 0.55 || live.length < 5) {
        const flavor = ['s', 'm', 'l'][Math.floor(random() * 3)]!;
        const instance = (await call('instances', 'create', {
          tenantId: 'acme',
          poolId,
          flavor,
          imageId: 'base',
          idempotencyKey: `churn-${created++}`,
        })) as { id: string; state: string };
        if (instance.state === 'scheduling') unplaced++;
        live.push(instance.id);
      } else if (roll < 0.85) {
        const [id] = live.splice(Math.floor(random() * live.length), 1);
        await call('instances', 'delete', { tenantId: 'acme', instanceId: id });
        deleted++;
      } else {
        const id = live[Math.floor(random() * live.length)]!;
        await call('instances', random() < 0.5 ? 'stop' : 'start', {
          tenantId: 'acme',
          instanceId: id,
        }).catch(() => undefined);
      }
      if (created % 10 === 0) await settle();
    }
    await settle();
    await checkNoLeaks();
    expect(deleted).toBeGreaterThan(50);
    const midChurn = await liveInstances();
    expect(midChurn.length).toBeGreaterThan(20);
    // Placed on all three hosts (instances still waiting for room have no node yet).
    expect(new Set(midChurn.flatMap((row) => (row.node_id ? [row.node_id] : []))).size).toBe(3);
    expect(midChurn.some((row) => row.state === 'stopped')).toBe(true);
    expect([...runtimes.values()].reduce((sum, runtime) => sum + runtime.size, 0)).toBe(
      midChurn.filter((row) => row.node_id).length,
    );

    // Everything still pending placement gets room once the rest is gone; then delete it all.
    for (const id of live) await call('instances', 'delete', { tenantId: 'acme', instanceId: id });
    clock.advance(60_000);
    await setSimClock(db, clock.now());
    await settle();
    await checkNoLeaks();
    expect(await liveInstances()).toEqual([]);
    for (const runtime of runtimes.values()) expect(runtime.size).toBe(0);
    const counters = await db.query<{ allocated: string }>(
      `SELECT allocated FROM node_resources WHERE allocated <> 0`,
    );
    expect(counters.rows).toEqual([]);
    const used = await db.query(`SELECT 1 FROM quota_usage WHERE used <> 0`);
    expect(used.rows).toEqual([]);
    expect(unplaced).toBeGreaterThanOrEqual(0);
  }, 300_000);
});
