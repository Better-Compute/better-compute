import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ComputeError,
  manualClock,
  type Caller,
  type ManualClock,
  type MethodContext,
  type ModuleContext,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, capacityModule, createCapacityPort } from '@better-compute/capacity';
import { builtinRuntimeTraits, vps, vpsMigrations, type VpsApi } from '@better-compute/vps';

// Runtimes per pool (§11.3) and single-tenant containers (§13, v0.3 exit "multi-tenant container
// offers are rejected"): a pool picks its runtime with policy.runtime; a container runtime needs
// policy.singleTenant and serves one tenant only.

const T0 = Date.UTC(2026, 8, 24, 12);
const SITE = 'site_01jz0000000000000000000r01';
let db: SqlExecutor;
let clock: ManualClock;

const caller = (tenantId: string, identityId = `usr_${tenantId}`): Caller => ({
  identityId,
  identityKind: 'user',
  tenantId,
  sessionId: 's',
  sessionKind: 'user',
  mfa: false,
});
const root = caller('root');
const acme = caller('acme');
const beta = caller('beta');

function moduleContext(sql: SqlExecutor): ModuleContext {
  return {
    sql,
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { resolve: async () => 'x' },
    capacity: createCapacityPort({ clock }, { topN: 3 }),
    authz: { async upsert() {}, async remove() {}, async setPending() {} },
    events: { async publish() {} },
    work: { async enqueue() {} },
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

const formats: Record<string, 'qcow2' | 'raw'> = { base: 'qcow2', rootfs: 'raw' };
const images = {
  async resolve(_tx: SqlTx, _tenant: string, imageId: string) {
    const format = formats[imageId];
    if (!format) return undefined;
    return {
      url: `https://images.example/${imageId}`,
      sha256: 'cd'.repeat(32),
      format,
      verified: true,
    };
  },
};
const module = vps({ images, runtimes: ['libvirt-kvm', 'containerd', 'firecracker'] });
const api = module.api!({} as ModuleContext) as VpsApi;
const capacityApi = capacityModule().api!({} as ModuleContext) as unknown as Record<
  string,
  Record<string, Definition>
>;
const call = (group: keyof VpsApi, method: string, raw: unknown, who: Caller) =>
  run((api[group] as unknown as Record<string, Definition>)[method]!, raw, who);

let keys = 0;
async function create(poolId: string, who: Caller, flavor = 's', imageId = 'base') {
  return (await call(
    'instances',
    'create',
    { tenantId: who.tenantId, poolId, flavor, imageId, idempotencyKey: `k-${++keys}` },
    who,
  )) as { id: string; state: string };
}
async function runtimeOf(instanceId: string): Promise<string> {
  const { rows } = await db.query<{ runtime: string }>(
    `SELECT runtime FROM instances WHERE id = $1`,
    [instanceId],
  );
  return rows[0]!.runtime;
}
async function rejection(promise: Promise<unknown>): Promise<ComputeError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ComputeError);
  return error as ComputeError;
}

/** A vps-host pool of root's with one host, offered as asked, with flavors s (CPU) and g (1 GPU). */
async function hostPool(key: string, policy: Record<string, unknown>, offers: string[] = []) {
  const pool = (await run(
    capacityApi.pools!.create!,
    {
      tenantId: 'root',
      siteId: SITE,
      class: 'vps-host',
      policy,
      ownerQuota: { gpu: 8, vcpu: 64, memoryGiB: 256, diskGiB: 4000 },
      idempotencyKey: key,
    },
    root,
  )) as { id: string };
  for (const tenant of offers)
    await run(
      capacityApi.pools!.offer!,
      {
        tenantId: 'root',
        poolId: pool.id,
        toTenantId: tenant,
        quota: { vcpu: 64, memoryGiB: 256, diskGiB: 4000 },
      },
      root,
    );
  for (const [name, gpus] of [
    ['s', 0],
    ['g', 1],
  ] as const)
    await call(
      'flavors',
      'create',
      { tenantId: 'root', poolId: pool.id, name, vcpu: 2, memoryGiB: 4, diskGiB: 40, gpus },
      root,
    );
  return pool.id;
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
});
afterAll(async () => {
  await db.close();
});

describe('vps runtimes (§11.3)', () => {
  it('knows the built-in runtimes and asks for the traits of any other', () => {
    expect(builtinRuntimeTraits.containerd).toMatchObject({
      isolation: 'container',
      multiTenant: false,
    });
    expect(builtinRuntimeTraits['libvirt-kvm']).toMatchObject({
      isolation: 'vm',
      multiTenant: true,
    });
    expect(() => vps({ runtimes: ['kata'] })).toThrow(/runtimeTraits/);
    expect(() =>
      vps({
        runtimes: ['kata'],
        runtimeTraits: {
          kata: {
            isolation: 'microvm',
            multiTenant: true,
            gpuPassthrough: false,
            imageFormats: ['raw'],
          },
        },
      }),
    ).not.toThrow();
  });

  it('runs the default runtime unless the pool names another', async () => {
    const plain = await hostPool('plain', {}, ['acme']);
    expect(await runtimeOf((await create(plain, acme)).id)).toBe('libvirt-kvm');
    const micro = await hostPool('micro', { runtime: 'firecracker' }, ['acme']);
    expect(await runtimeOf((await create(micro, acme, 's', 'rootfs')).id)).toBe('firecracker');
  });

  it('places a plugin runtime only on hosts whose bcd advertised it (walkthrough 4)', async () => {
    const pool = await hostPool('micro-hosts', { runtime: 'firecracker' }, ['acme']);
    const host = async (id: string, labels: Record<string, string>) => {
      await db.query(
        `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
                            cordoned, connectivity, trust, generation, observed_generation, next_cmd_seq,
                            identity_gen, shard, version)
         VALUES ($1, $2, $3, 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
        [id, SITE, pool],
      );
      for (const [resource, allocatable] of [
        ['vcpu', 64],
        ['memoryGiB', 256],
        ['diskGiB', 4000],
      ] as const)
        await db.query(
          `INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated) VALUES ($1, $2, $3, 1, 0)`,
          [id, resource, allocatable],
        );
      for (const [key, value] of Object.entries(labels))
        await db.query(
          `INSERT INTO node_labels (node_id, key, value, source) VALUES ($1, $2, $3, 'system')`,
          [id, key, value],
        );
    };
    await host('node_01jz0000000000000000000ra1', {});
    await host('node_01jz0000000000000000000ra2', { 'bc.dev/driver.firecracker': '1.12.0' });
    for (let i = 0; i < 3; i++) {
      const instance = await create(pool, acme, 's', 'rootfs');
      const { rows } = await db.query<{ node_id: string | null }>(
        `SELECT node_id FROM instances WHERE id = $1`,
        [instance.id],
      );
      expect(rows[0]!.node_id).toBe('node_01jz0000000000000000000ra2');
    }
  });

  it('refuses a runtime the deployment does not run, an image it cannot boot and GPUs it cannot pass', async () => {
    const unknown = await hostPool('unknown', { runtime: 'cloud-hypervisor' }, ['acme']);
    expect((await rejection(create(unknown, acme))).code).toBe('INVALID_CONFIG');
    const micro = await hostPool('micro-2', { runtime: 'firecracker' }, ['acme']);
    const qcow = await rejection(create(micro, acme, 's', 'base'));
    expect([qcow.code, qcow.message]).toEqual([
      'INVALID_INPUT',
      expect.stringMatching(/not qcow2/),
    ]);
    const gpu = await rejection(create(micro, acme, 'g', 'rootfs'));
    expect([gpu.code, gpu.message]).toEqual(['INVALID_INPUT', expect.stringMatching(/GPUs/)]);
  });
});

describe('single-tenant containers (§13)', () => {
  it('refuses a container pool that is not marked singleTenant', async () => {
    const shared = await hostPool('containers-shared', { runtime: 'containerd' }, ['acme']);
    const error = await rejection(create(shared, acme, 's', 'rootfs'));
    expect([error.code, error.message]).toEqual([
      'INVALID_CONFIG',
      expect.stringMatching(/single-tenant container runtime: set policy.singleTenant/),
    ]);
  });

  it('serves the one tenant it is offered to, and not its owner', async () => {
    const pool = await hostPool('containers-acme', { runtime: 'containerd', singleTenant: true }, [
      'acme',
    ]);
    const instance = await create(pool, acme, 's', 'rootfs');
    expect(await runtimeOf(instance.id)).toBe('containerd');
    const owner = await rejection(create(pool, root, 's', 'rootfs'));
    expect([owner.code, owner.message]).toEqual([
      'INVALID_STATE',
      expect.stringMatching(/serves tenant acme only/),
    ]);
  });

  it('serves its owner when offered to no one', async () => {
    const pool = await hostPool('containers-own', { runtime: 'containerd', singleTenant: true });
    expect(await runtimeOf((await create(pool, root, 's', 'rootfs')).id)).toBe('containerd');
  });

  it('refuses every tenant once the pool is offered to two (defence in depth behind pools.offer)', async () => {
    const pool = await hostPool('containers-two', { runtime: 'containerd', singleTenant: true }, [
      'acme',
    ]);
    // Written directly: capacity's offer validator is the first line; this is the second.
    await db.query(
      `INSERT INTO pool_offers (pool_id, tenant_id, include_descendants) VALUES ($1, 'beta', false)`,
      [pool],
    );
    for (const who of [acme, beta]) {
      const error = await rejection(create(pool, who, 's', 'rootfs'));
      expect([error.code, error.message]).toEqual([
        'INVALID_STATE',
        expect.stringMatching(/offered to 2 tenants/),
      ]);
    }
  });

  it("refuses a tenant while another tenant's instances still run in the pool", async () => {
    const pool = await hostPool('containers-moved', { runtime: 'containerd', singleTenant: true }, [
      'acme',
    ]);
    await create(pool, acme, 's', 'rootfs');
    // The offer moves to beta while acme's container still exists.
    await db.query(`DELETE FROM pool_offers WHERE pool_id = $1`, [pool]);
    await db.query(
      `INSERT INTO pool_offers (pool_id, tenant_id, include_descendants) VALUES ($1, 'beta', false)`,
      [pool],
    );
    const error = await rejection(create(pool, beta, 's', 'rootfs'));
    expect([error.code, error.message]).toEqual([
      'INVALID_STATE',
      expect.stringMatching(/still runs another tenant's instances/),
    ]);
  });
});
