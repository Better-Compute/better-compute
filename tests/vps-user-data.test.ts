import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ComputeError,
  manualClock,
  type Caller,
  type ManualClock,
  type MethodContext,
  type ModuleContext,
  type SecretBroker,
  type SecretRef,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, capacityModule, createCapacityPort } from '@better-compute/capacity';
import {
  instanceSpecs,
  instanceWork,
  parseCreateInstance,
  reportInstances,
  vps,
  vpsMigrations,
  type VpsApi,
} from '@better-compute/vps';

// Hosted instances' user data (§6 "Secrets", §13): the spec carries only a secret:// ref the host
// fetches through the broker; vps seals the rendered cloud-config at admission and deletes it with
// the instance; a tenant may bring a ref, but only one of its own.

const T0 = Date.UTC(2026, 8, 24, 12);
const SITE = 'site_01jz0000000000000000000w01';
const NODE = 'node_01jz0000000000000000000w01';
let db: SqlExecutor;
let clock: ManualClock;
let poolId: string;

const alice: Caller = {
  identityId: 'usr_alice',
  identityKind: 'user',
  tenantId: 'acme',
  sessionId: 's',
  sessionKind: 'user',
  mfa: false,
};
const root: Caller = { ...alice, identityId: 'usr_root', tenantId: 'root' };

/** An in-memory SecretBroker, as `ModuleContext.secrets` is in a host. */
const sealed = new Map<string, string>();
let sealedCount = 0;
const broker: SecretBroker = {
  async put(tenantId, value) {
    const ref = `secret://${tenantId}/s${++sealedCount}` as SecretRef;
    sealed.set(ref, value);
    return ref;
  },
  async resolve(ref) {
    const value = sealed.get(ref);
    if (value === undefined) throw new ComputeError('NOT_FOUND', `no ${ref}`);
    return value;
  },
  async delete(ref) {
    sealed.delete(ref);
  },
};

const queue = new Set<string>();
function moduleContext(sql: SqlExecutor): ModuleContext {
  return {
    sql,
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: broker,
    capacity: createCapacityPort({ clock }, { topN: 3 }),
    authz: { async upsert() {}, async remove() {}, async setPending() {} },
    events: { async publish() {} },
    work: {
      async enqueue(_tx: SqlTx, kind: string, key: string) {
        if (kind === instanceWork) queue.add(key);
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
const call = (group: keyof VpsApi, method: string, raw: unknown, who: Caller = alice) =>
  run((api[group] as unknown as Record<string, Definition>)[method]!, raw, who);

async function stored(instanceId: string) {
  const { rows } = await db.query<{ user_data: string | null; user_data_sealed: boolean }>(
    `SELECT user_data, user_data_sealed FROM instances WHERE id = $1`,
    [instanceId],
  );
  return rows[0]!;
}

/** Runs the instance reconciler until its queue drains. */
async function settle(): Promise<void> {
  const reconciler = module.reconcilers!.find((entry) => entry.name === instanceWork)!;
  for (let round = 0; round < 10 && queue.size; round++)
    for (const key of [...queue]) {
      queue.delete(key);
      await reconciler.run({ ...moduleContext(db), signal: new AbortController().signal }, key);
    }
}

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations, ...vpsMigrations]);
  clock = manualClock(T0);
  await useSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, 'root', 'shared', 'eu', 1)`,
    [SITE],
  );
  const pool = (await run(
    capacityApi.pools!.create!,
    { tenantId: 'root', siteId: SITE, class: 'vps-host' },
    root,
  )) as { id: string };
  poolId = pool.id;
  await run(
    capacityApi.pools!.offer!,
    {
      tenantId: 'root',
      poolId,
      toTenantId: 'acme',
      quota: { vcpu: 64, memoryGiB: 256, diskGiB: 4000 },
    },
    root,
  );
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
                        trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, $2, $3, 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
    [NODE, SITE, poolId],
  );
  for (const [resource, allocatable] of [
    ['vcpu', 64],
    ['memoryGiB', 256],
    ['diskGiB', 4000],
  ] as const)
    await db.query(
      `INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated) VALUES ($1, $2, $3, 1, 0)`,
      [NODE, resource, allocatable],
    );
  await call(
    'flavors',
    'create',
    { tenantId: 'root', poolId, name: 's', vcpu: 2, memoryGiB: 4, diskGiB: 40 },
    root,
  );
});
afterAll(async () => {
  await db.close();
});

describe('hosted user data (§6 Secrets)', () => {
  it("refuses a reference that is not one of the tenant's own secrets", () => {
    const base = { tenantId: 'acme', poolId, flavor: 's', imageId: 'base', idempotencyKey: 'k' };
    for (const userData of ['secret://victim/s1', 'vault://kv/data/acme', 'env://DATABASE_URL'])
      expect(() => parseCreateInstance({ ...base, userData }), userData).toThrow(
        /secret:\/\/acme\/<id>, a secret of this tenant/,
      );
    expect(parseCreateInstance({ ...base, userData: 'secret://acme/s9' }).userData).toBe(
      'secret://acme/s9',
    );
    // Content that merely mentions a URL later on is content.
    expect(
      parseCreateInstance({ ...base, userData: '#cloud-config\nruncmd: [curl https://x]' })
        .userData,
    ).toMatch(/^#cloud-config/);
  });

  it('seals the rendered cloud-config and sends the host only its ref', async () => {
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx alice@laptop';
    const instance = (await call('instances', 'create', {
      tenantId: 'acme',
      poolId,
      flavor: 's',
      imageId: 'base',
      sshKeys: [key],
      idempotencyKey: 'sealed-1',
    })) as { id: string; nodeId?: string };
    expect(instance.nodeId).toBe(NODE);
    const row = await stored(instance.id);
    expect(row.user_data_sealed).toBe(true);
    expect(row.user_data).toMatch(/^secret:\/\/acme\/s\d+$/);
    const value = sealed.get(row.user_data!)!;
    expect(value).toContain(key);
    expect(value).toMatch(/^#cloud-config\n/);
    // No tenant VM runs bcd: its user data never carries a join token or the daemon.
    expect(value).not.toMatch(/bcjt_|biam_|\bbcd\b|join-encryption|install-script/);
    await settle();
    const specs = await db.transaction((tx) => instanceSpecs(tx, NODE));
    expect(specs.find((spec) => spec.id === instance.id)?.userData).toBe(row.user_data);
  });

  it("keeps a tenant's own ref and never deletes it", async () => {
    const own = await broker.put('acme', '#cloud-config\nhostname: mine\n');
    const instance = (await call('instances', 'create', {
      tenantId: 'acme',
      poolId,
      flavor: 's',
      imageId: 'base',
      userData: own,
      idempotencyKey: 'own-1',
    })) as { id: string };
    expect(await stored(instance.id)).toEqual({ user_data: own, user_data_sealed: false });
    await call('instances', 'delete', { tenantId: 'acme', instanceId: instance.id });
    await settle();
    await db.transaction((tx) =>
      reportInstances(tx, moduleContext(db).work, NODE, [], { complete: true }),
    );
    await settle();
    const { rows } = await db.query<{ state: string }>(
      `SELECT state FROM instances WHERE id = $1`,
      [instance.id],
    );
    expect(rows[0]!.state).toBe('deleted');
    expect(sealed.has(own)).toBe(true);
  });

  it('deletes the sealed user data with the instance', async () => {
    const instance = (await call('instances', 'create', {
      tenantId: 'acme',
      poolId,
      flavor: 's',
      imageId: 'base',
      idempotencyKey: 'sealed-2',
    })) as { id: string };
    const { user_data: ref } = await stored(instance.id);
    expect(sealed.has(ref!)).toBe(true);
    await call('instances', 'delete', { tenantId: 'acme', instanceId: instance.id });
    await settle();
    await db.transaction((tx) =>
      reportInstances(tx, moduleContext(db).work, NODE, [], { complete: true }),
    );
    await settle();
    const { rows } = await db.query<{ state: string }>(
      `SELECT state FROM instances WHERE id = $1`,
      [instance.id],
    );
    expect(rows[0]!.state).toBe('deleted');
    expect(sealed.has(ref!)).toBe(false);
  });
});
