import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apiMethod,
  ComputeError,
  draftId,
  field,
  manifest,
  manualClock,
  type AuthzRow,
  type Caller,
  type ExternalMachine,
  type ManualClock,
  type MethodContext,
  type ModuleContext,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { create } from '@bufbuild/protobuf';
import {
  InstanceObservedState,
  InstanceStatusSchema,
  StatusReportSchema,
} from '@better-compute/protocol';
import { useSimClock, setSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  capacityMigrations,
  capacityModule,
  createCapacityPort,
  readQuotas,
} from '@better-compute/capacity';
import {
  defineProvider,
  instanceStatusHandler,
  instanceWork,
  reportInstances,
  setIpPool,
  vps,
  vpsMigrations,
  type VpsApi,
} from '@better-compute/vps';

// The VPS control plane (PLAN.md §3.6, §11.1) below the envelope: instances on a hosted pool
// (placed through capacity, converged from daemon reports) and on a provider pool (driven through
// an in-memory ProviderImpl), flavors, provider accounts and IPAM, on PGlite with recording fakes.

const T0 = Date.UTC(2026, 8, 24, 12);
let db: SqlExecutor;
let clock: ManualClock;

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq3w8xQy9eYyB7y0YyB alice@laptop';

// --- An in-memory provider -------------------------------------------------------------------------

interface FakeCloud {
  machines: Map<string, ExternalMachine & { userData: string; key: string }>;
  creates: number;
  fail?: string;
}
const cloud: FakeCloud = { machines: new Map(), creates: 0 };

const fakeCloud = defineProvider({
  id: 'fake-cloud',
  version: '1.0.0',
  provides: ['vps'],
  config: manifest({
    token: field.secret(),
    location: field.option(['fsn1', 'hel1']).default('fsn1'),
  }),
  create: async (_config, context) => {
    return {
      async listOffers() {
        return [
          {
            id: 'cx22',
            kind: 'vps' as const,
            region: 'fsn1',
            vcpu: 2,
            memoryGiB: 4,
            available: true,
          },
        ];
      },
      async create(request, call) {
        await context.secrets.resolve('env://FAKE_TOKEN');
        if (cloud.fail) throw new ComputeError('PROVIDER_ERROR', cloud.fail);
        const existing = [...cloud.machines.values()].find(
          (machine) => machine.key === call.idempotencyKey,
        );
        if (existing) return existing;
        cloud.creates++;
        const machine = {
          id: `srv-${cloud.creates}`,
          name: request.name,
          state: 'pending' as const,
          offerId: request.offerId,
          addresses: [`203.0.113.${cloud.creates}`],
          userData: request.userData,
          key: call.idempotencyKey,
        };
        cloud.machines.set(machine.id, machine);
        return machine;
      },
      async get(id) {
        return cloud.machines.get(id);
      },
      async delete(id) {
        if (!cloud.machines.delete(id)) throw new ComputeError('NOT_FOUND', 'gone');
      },
      async power(id, action) {
        const machine = cloud.machines.get(id);
        if (machine) machine.state = action === 'on' ? 'running' : 'stopped';
      },
    };
  },
});

// --- Harness ------------------------------------------------------------------------------------

interface Recorded {
  authz: AuthzRow[];
  removed: { type: string; id: string }[];
  events: string[];
  work: { key: string; notBefore?: number }[];
  invalidated: string[];
}
let recorded: Recorded;

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
  async resolve(_tx: SqlTx, tenantId: string, imageId: string) {
    if (imageId !== 'ubuntu-24.04' || tenantId === 'nobody') return undefined;
    return {
      url: 'https://images.example/ubuntu-24.04.qcow2',
      sha256: 'ab'.repeat(32),
      format: 'qcow2' as const,
      verified: true,
    };
  },
};

function moduleContext(sql: SqlExecutor): ModuleContext {
  return {
    sql,
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { resolve: async (ref: string) => `resolved:${ref}` },
    capacity: createCapacityPort({ clock }, { random: () => 0, topN: 1 }),
    authz: {
      async upsert(_tx, row) {
        recorded.authz.push(row);
      },
      async remove(_tx, ref) {
        recorded.removed.push(ref);
      },
      async setPending() {},
    },
    events: {
      async publish(_tx, event) {
        recorded.events.push(event.type);
      },
    },
    work: {
      async enqueue(_tx, kind, key, options) {
        if (kind === instanceWork)
          recorded.work.push({
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

const module = vps({ runtimes: ['libvirt-kvm'], providers: [fakeCloud], images });
const api = module.api!(moduleContext(db)) as VpsApi;
const capacity = capacityModule({ random: () => 0, topN: 1 });
const capacityApi = capacity.api!(moduleContext(db)) as Record<string, Record<string, unknown>>;

type Definition = {
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

async function run(
  definition: Definition,
  raw: unknown,
  who: Caller,
  deny = false,
): Promise<unknown> {
  const input = definition.validate(raw);
  const context = (tx: SqlTx) =>
    ({ ...moduleContext(within(tx)), caller: who, requestId: 'req' }) as MethodContext;
  if (definition.admission) {
    const plan = await db.transaction((tx) =>
      definition.admission!.prepare(context(tx), input, tx),
    );
    if (plan.status === 'replay') return plan.result;
    if (deny) {
      await db.transaction((tx) =>
        definition.admission!.denied!(context(tx), input, tx, new Error('no')),
      );
      throw new ComputeError('ACCESS_DENIED', 'Access denied');
    }
  }
  return db.transaction((tx) => definition.handler(context(tx), input));
}

const call = (
  group: keyof VpsApi,
  method: string,
  raw: unknown,
  who: Caller = alice,
  deny = false,
) => run((api[group] as Record<string, Definition>)[method]!, raw, who, deny);
const callCapacity = (group: string, method: string, raw: unknown, who: Caller = root) =>
  run(capacityApi[group]![method] as Definition, raw, who);

async function reconcile(instanceId: string): Promise<void> {
  const reconciler = module.reconcilers!.find((entry) => entry.name === instanceWork)!;
  await reconciler.run({ ...moduleContext(db), signal: new AbortController().signal }, instanceId);
}

async function report(
  nodeId: string,
  reports: Parameters<typeof reportInstances>[3],
  complete = true,
) {
  return db.transaction((tx) =>
    reportInstances(tx, moduleContext(db).work, nodeId, reports, { complete }),
  );
}

type View = {
  id: string;
  state: string;
  desiredState: string;
  nodeId?: string;
  addresses: string[];
  conditions: { type: string; reason?: string }[];
  externalId?: string;
};
const get = async (instanceId: string) =>
  (await call('instances', 'get', { tenantId: 'acme', instanceId })) as View;

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations, ...vpsMigrations]);
});
afterAll(async () => {
  await db.close();
});

const tables = [
  'usage_windows',
  'ip_leases',
  'ip_pools',
  'instances',
  'flavors',
  'provider_accounts',
  'pool_capacity_rollup',
  'device_bookings',
  'allocations',
  'node_resources',
  'devices',
  'quota_usage',
  'nodes',
  'pool_offers',
  'pools',
  'sites',
];

let hostedPool: string;
beforeEach(async () => {
  for (const table of tables) await db.query(`DELETE FROM ${table}`);
  recorded = { authz: [], removed: [], events: [], work: [], invalidated: [] };
  cloud.machines.clear();
  cloud.creates = 0;
  delete cloud.fail;
  clock = manualClock(T0);
  await useSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_01jz00000000000000000000aa', 'root', 'shared', 'eu', 1)`,
  );
  const pool = (await callCapacity('pools', 'create', {
    tenantId: 'root',
    siteId: 'site_01jz00000000000000000000aa',
    class: 'vps-host',
    gpuModel: 'L40S',
  })) as { id: string };
  hostedPool = pool.id;
  await callCapacity('pools', 'offer', {
    tenantId: 'root',
    poolId: hostedPool,
    toTenantId: 'acme',
    quota: { vcpu: 64, memoryGiB: 256, diskGiB: 2000, gpu: 2 },
  });
  for (const node of ['node_01jz00000000000000000000va', 'node_01jz00000000000000000000vb']) {
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                          connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_01jz00000000000000000000aa', $2, 'root', 'host', 'adopted', false, false, 'connected',
               'platform', 1, 1, 1, 1, 0, 1)`,
      [node, hostedPool],
    );
    for (const [resource, allocatable, ratio] of [
      ['vcpu', 16, 2],
      ['memoryGiB', 64, 1],
      ['diskGiB', 1000, 1],
    ] as const)
      await db.query(
        `INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated) VALUES ($1, $2, $3, $4, 0)`,
        [node, resource, allocatable, ratio],
      );
    await db.query(
      `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes) VALUES ($1, $2, 'gpu', true, true, '{"gpuModel":"L40S"}')`,
      [`GPU-${node.slice(-2)}`, node],
    );
  }
  await setIpPool(db, { poolId: hostedPool, cidr: '10.0.0.0/29', gateway: '10.0.0.1' });
  for (const [name, vcpu, memoryGiB, diskGiB, gpus] of [
    ['g1.small', 2, 4, 40, 0],
    ['g1.large', 8, 32, 200, 0],
    ['gpu1.l40s', 8, 32, 200, 1],
    ['g1.huge', 40, 32, 200, 0],
  ] as const)
    await call(
      'flavors',
      'create',
      { tenantId: 'root', poolId: hostedPool, name, vcpu, memoryGiB, diskGiB, gpus },
      root,
    );
  recorded = { authz: [], removed: [], events: [], work: [], invalidated: [] };
});

const createHosted = (extra: Record<string, unknown> = {}) => ({
  tenantId: 'acme',
  poolId: hostedPool,
  flavor: 'g1.small',
  imageId: 'ubuntu-24.04',
  sshKeys: [KEY],
  idempotencyKey: 'vm-1',
  ...extra,
});

describe('vps() API surface', () => {
  it('matches the §9.2 rows for every method, and declares its migration and reconciler', () => {
    for (const [group, methods] of Object.entries(api))
      for (const [method, definition] of Object.entries(
        methods as Record<string, { action: string; kind: string }>,
      )) {
        const row = apiMethod(group, method);
        expect(row, `${group}.${method}`).toMatchObject({
          module: 'vps',
          action: definition.action,
          kind: definition.kind,
        });
      }
    expect(module.migrations!.map((migration) => migration.name)).toEqual([
      'vps/0001_instances',
      'vps/0002_sealed_user_data',
      'vps/0003_provider_bootstraps',
    ]);
    expect(module.requires).toEqual(['capacity']);
    expect(() => vps({ runtimes: [] })).toThrow(ComputeError);
    expect(() => vps({ providers: [fakeCloud, fakeCloud] })).toThrow(/twice/);
  });
});

describe('hosted instances', () => {
  it('admits a draft, places it with an IP, and replays by key', async () => {
    const created = (await call('instances', 'create', createHosted())) as View;
    expect(created).toMatchObject({
      state: 'provisioning',
      desiredState: 'running',
      nodeId: 'node_01jz00000000000000000000va',
      addresses: ['10.0.0.2'],
    });
    expect(created.id).toMatch(/^inst_[0-9a-z]{52}$/);
    expect(recorded.authz[0]).toMatchObject({
      type: 'instance',
      id: created.id,
      parentId: hostedPool,
      ownerId: 'usr_alice',
      attributes: { vcpu: 2, memoryGiB: 4, gpus: 0, imageId: 'ubuntu-24.04', imageVerified: true },
    });
    expect(recorded.events).toEqual(['instance.scheduled', 'instance.created']);
    const quotas = Object.fromEntries(
      (await readQuotas(db, 'acme', hostedPool)).map((row) => [row.resource, row.used]),
    );
    expect(quotas).toMatchObject({ vcpu: 2, memoryGiB: 4, diskGiB: 40 });

    expect(((await call('instances', 'create', createHosted())) as View).id).toBe(created.id);
    await expect(
      call('instances', 'create', createHosted({ flavor: 'g1.large' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('forgets a refused draft, and refuses unknown images, flavors and pools', async () => {
    await expect(call('instances', 'create', createHosted(), alice, true)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    expect((await db.query(`SELECT 1 FROM instances`)).rows).toEqual([]);
    expect(recorded.removed).toMatchObject([{ type: 'instance' }]);
    await expect(
      call('instances', 'create', createHosted({ imageId: 'windows-11' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      call('instances', 'create', createHosted({ flavor: 'nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      call('instances', 'create', createHosted({ tenantId: 'other' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      call('instances', 'create', createHosted({ sshKeys: ['not a key'] })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('converges from daemon reports: running, stopped, running again', async () => {
    const created = (await call('instances', 'create', createHosted())) as View;
    const node = created.nodeId!;
    const spec = await module.nodeSpec!(moduleContext(db), { id: node } as never);
    expect(spec.instances).toEqual([
      {
        id: created.id,
        desiredState: 'running',
        runtime: 'libvirt-kvm',
        flavor: { vcpu: 2, memoryGiB: 4, diskGiB: 40 },
        image: {
          url: 'https://images.example/ubuntu-24.04.qcow2',
          sha256: 'ab'.repeat(32),
          format: 'qcow2',
        },
        userData: expect.stringContaining(KEY),
        allocationId: created.allocationId,
        nics: [
          {
            network: 'br0',
            mac: expect.stringMatching(/^02(:[0-9a-f]{2}){5}$/),
            addresses: [expect.stringMatching(/^10\.0\.0\.2\/\d+$/)],
          },
        ],
      },
    ]);

    await report(node, [{ id: created.id, state: 'running', addresses: ['fe80::1'] }]);
    await reconcile(created.id);
    expect(await get(created.id)).toMatchObject({
      state: 'running',
      addresses: ['10.0.0.2', 'fe80::1'],
    });

    await call('instances', 'stop', { tenantId: 'acme', instanceId: created.id });
    await reconcile(created.id);
    expect((await get(created.id)).state).toBe('running'); // until the runtime reports it
    await report(node, [{ id: created.id, state: 'stopped' }]);
    await reconcile(created.id);
    expect(await get(created.id)).toMatchObject({ state: 'stopped', desiredState: 'stopped' });

    await call('instances', 'start', { tenantId: 'acme', instanceId: created.id });
    await report(node, [{ id: created.id, state: 'running' }]);
    await reconcile(created.id);
    expect((await get(created.id)).state).toBe('running');
    expect(recorded.events).toContain('instance.stopped');
  });

  it('resizes a stopped instance in place, quota first', async () => {
    const created = (await call('instances', 'create', createHosted())) as View;
    await expect(
      call('instances', 'resize', { tenantId: 'acme', instanceId: created.id, flavor: 'g1.large' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await call('instances', 'stop', { tenantId: 'acme', instanceId: created.id });
    await report(created.nodeId!, [{ id: created.id, state: 'stopped' }]);
    await reconcile(created.id);
    const resized = (await call('instances', 'resize', {
      tenantId: 'acme',
      instanceId: created.id,
      flavor: 'g1.large',
    })) as {
      flavor: string;
      state: string;
    };
    expect(resized).toMatchObject({ flavor: 'g1.large', state: 'stopped' });
    const used = Object.fromEntries(
      (await readQuotas(db, 'acme', hostedPool)).map((row) => [row.resource, row.used]),
    );
    expect(used).toMatchObject({ vcpu: 8, memoryGiB: 32, diskGiB: 200 });
    const { rows } = await db.query<{ resource: string; allocated: string }>(
      `SELECT resource, allocated FROM node_resources WHERE node_id = $1 ORDER BY resource`,
      [created.nodeId],
    );
    expect(rows.map((row) => [row.resource, Number(row.allocated)])).toEqual([
      ['diskGiB', 200],
      ['memoryGiB', 32],
      ['vcpu', 8],
    ]);
    await expect(
      call('instances', 'resize', {
        tenantId: 'acme',
        instanceId: created.id,
        flavor: 'gpu1.l40s',
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(
      call('instances', 'resize', { tenantId: 'acme', instanceId: created.id, flavor: 'g1.huge' }),
    ).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE' });
    expect(
      (await readQuotas(db, 'acme', hostedPool)).find((row) => row.resource === 'vcpu')!.used,
    ).toBe(8);
  });

  it('deletes only after the runtime drops it, returning booking, IP and quota', async () => {
    const created = (await call(
      'instances',
      'create',
      createHosted({ flavor: 'gpu1.l40s' }),
    )) as View;
    const node = created.nodeId!;
    await report(node, [{ id: created.id, state: 'running' }]);
    await reconcile(created.id);
    await call('instances', 'delete', { tenantId: 'acme', instanceId: created.id });
    await reconcile(created.id);
    expect((await get(created.id)).state).toBe('deleting');
    const spec = await module.nodeSpec!(moduleContext(db), { id: node } as never);
    expect(spec.instances![0]).toMatchObject({ desiredState: 'deleted', deviceIds: [`GPU-va`] });

    await report(node, []); // the runtime's full list no longer has it
    await reconcile(created.id);
    expect((await get(created.id)).state).toBe('deleted');
    expect((await db.query(`SELECT 1 FROM ip_leases`)).rows).toEqual([]);
    expect((await db.query(`SELECT 1 FROM allocations WHERE released_at IS NULL`)).rows).toEqual(
      [],
    );
    expect((await readQuotas(db, 'acme', hostedPool)).every((row) => row.used === 0)).toBe(true);
    expect(recorded.removed.at(-1)).toMatchObject({ type: 'instance', id: created.id });
    expect(await module.nodeSpec!(moduleContext(db), { id: node } as never)).toEqual({});
    expect(
      (await call('instances', 'delete', { tenantId: 'acme', instanceId: created.id })) as View,
    ).toMatchObject({
      state: 'deleted',
    });
  });

  it('reports orphans and ignores other nodes’ instances', async () => {
    const created = (await call('instances', 'create', createHosted())) as View;
    const other =
      created.nodeId === 'node_01jz00000000000000000000va'
        ? 'node_01jz00000000000000000000vb'
        : 'node_01jz00000000000000000000va';
    const result = await report(other, [
      { id: created.id, state: 'running' },
      { id: 'inst_leaked', state: 'running' },
    ]);
    expect(result.orphans).toEqual([created.id, 'inst_leaked'].sort());
    expect((await get(created.id)).state).toBe('provisioning');
  });

  it('ingests StatusReport.instances through the gateway status handler', async () => {
    const created = (await call('instances', 'create', createHosted())) as View;
    const node = created.nodeId!;
    const published: { type: string; data: unknown }[] = [];
    const logged: string[] = [];
    const events = {
      async publish(_tx: SqlTx, event: { type: string; data: unknown }) {
        published.push({ type: event.type, data: event.data });
      },
    };
    const handler = instanceStatusHandler({ events } as never);
    const context = { nodeId: node, tenantId: 'root', work: moduleContext(db).work };
    const status = (
      instances: { instanceId: string; state: InstanceObservedState; addresses?: string[] }[],
      instancesComplete: boolean,
    ) =>
      create(StatusReportSchema, {
        instances: instances.map((instance) => create(InstanceStatusSchema, instance)),
        instancesComplete,
      });
    const result = await db.transaction((tx) =>
      handler(
        tx,
        context,
        status(
          [
            {
              instanceId: created.id,
              state: InstanceObservedState.RUNNING,
              addresses: ['fe80::2'],
            },
            { instanceId: 'inst_leak', state: InstanceObservedState.RUNNING },
            { instanceId: 'inst_unknown', state: InstanceObservedState.UNSPECIFIED },
          ],
          true,
        ),
      ),
    );
    expect(result).toEqual({ updated: 1, orphans: ['inst_leak'] });
    expect(published).toEqual([
      { type: 'instance.orphaned', data: { nodeId: node, instanceIds: ['inst_leak'] } },
    ]);
    // The same leak in the next report is not announced again; failures are attributable by name.
    await db.transaction((tx) =>
      handler(
        tx,
        context,
        status([{ instanceId: 'inst_leak', state: InstanceObservedState.RUNNING }], false),
      ),
    );
    expect(published).toHaveLength(1);
    expect(handler.name).toBe('vpsInstanceStatus');
    await reconcile(created.id);
    expect(await get(created.id)).toMatchObject({
      state: 'running',
      addresses: expect.arrayContaining(['fe80::2']),
    });

    // An empty partial report changes nothing; an empty complete one marks it absent.
    expect(await db.transaction((tx) => handler(tx, context, status([], false)))).toEqual({
      updated: 0,
      orphans: [],
    });
    expect(
      await db.transaction((tx) =>
        instanceStatusHandler({ log: (line) => logged.push(line) })(tx, context, status([], true)),
      ),
    ).toEqual({ updated: 1, orphans: [] });
    expect(logged).toEqual([]);
    expect(
      await db.transaction((tx) =>
        instanceStatusHandler({ log: (line) => logged.push(line) })(
          tx,
          context,
          status([{ instanceId: 'inst_leak', state: InstanceObservedState.STOPPED }], false),
        ),
      ),
    ).toEqual({ updated: 0, orphans: ['inst_leak'] });
    expect(logged).toEqual([expect.stringContaining('inst_leak')]);
  });

  it('waits while nothing fits, then fails on quota', async () => {
    const huge = (await call('instances', 'create', createHosted({ flavor: 'g1.huge' }))) as View;
    expect(huge).toMatchObject({
      state: 'scheduling',
      conditions: [{ type: 'Unschedulable', reason: 'NoFit' }],
    });
    expect(recorded.work.at(-1)).toEqual({ key: huge.id, notBefore: T0 + 30_000 });
    await expect(
      call('instances', 'create', createHosted({ flavor: 'gpu1.l40s', idempotencyKey: 'g1' })),
    ).resolves.toMatchObject({ state: 'provisioning' });
    await call('instances', 'create', createHosted({ flavor: 'gpu1.l40s', idempotencyKey: 'g2' }));
    await expect(
      call('instances', 'create', createHosted({ flavor: 'gpu1.l40s', idempotencyKey: 'g3' })),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('marks instances on a lost host lost, and recreates them when the pool says so', async () => {
    const created = (await call('instances', 'create', createHosted())) as View;
    await report(created.nodeId!, [{ id: created.id, state: 'running' }]);
    await reconcile(created.id);
    await db.query(`UPDATE nodes SET connectivity = 'lost' WHERE id = $1`, [created.nodeId]);
    await reconcile(created.id);
    expect((await get(created.id)).state).toBe('lost');
    await reconcile(created.id);
    expect((await get(created.id)).state).toBe('lost');

    await db.query(`UPDATE pools SET policy = '{"recreateOnHostLoss": true}' WHERE id = $1`, [
      hostedPool,
    ]);
    await reconcile(created.id); // → scheduling
    await reconcile(created.id); // → placed on the surviving node
    const moved = await get(created.id);
    expect(moved.state).toBe('provisioning');
    expect(moved.nodeId).not.toBe(created.nodeId);
    expect(moved.addresses).toEqual(['10.0.0.2']);
  });

  it('lists the caller’s instances by default, everyone’s with scope all', async () => {
    await call('instances', 'create', createHosted());
    await call('instances', 'create', createHosted({ idempotencyKey: 'bob-1' }), {
      ...alice,
      identityId: 'usr_bob',
    });
    const mine = (await call('instances', 'list', { tenantId: 'acme' })) as { items: View[] };
    expect(mine.items).toHaveLength(1);
    const all = (await call('instances', 'list', { tenantId: 'acme', scope: 'all', limit: 1 })) as {
      items: View[];
      cursor?: string;
    };
    expect(all.items).toHaveLength(1);
    expect(all.cursor).toBeDefined();
  });
});

describe('instances.create: async-with-wait and the budget check', () => {
  type CreateDefinition = Definition & {
    poll: {
      done(output: unknown): boolean;
      refresh(c: MethodContext, i: unknown, o: unknown): Promise<unknown>;
    };
    admission: { check(c: MethodContext, i: unknown, r: unknown): Promise<void> };
  };
  const create = () => api.instances.create as unknown as CreateDefinition;

  it('parses wait (≤ 30 s) and leaves it out of the request, so a retry with another wait replays', async () => {
    expect(create().validate(createHosted({ wait: { timeoutMs: 5000 } }))).toMatchObject({
      wait: { timeoutMs: 5000 },
    });
    for (const wait of [{ timeoutMs: 30_001 }, { timeoutMs: -1 }, { timeoutMs: 1, x: 1 }, 5])
      expect(() => create().validate(createHosted({ wait }))).toThrow(ComputeError);
    const first = (await call(
      'instances',
      'create',
      createHosted({ wait: { timeoutMs: 1000 } }),
    )) as View;
    const again = (await call(
      'instances',
      'create',
      createHosted({ wait: { timeoutMs: 9000 } }),
    )) as View;
    expect(again.id).toBe(first.id);
  });

  it('polls until the instance leaves provisioning, refreshed from its row', async () => {
    const created = (await call('instances', 'create', createHosted())) as View;
    const { poll } = create();
    expect(poll.done(created)).toBe(false);
    const context = { ...moduleContext(db), caller: alice } as MethodContext;
    const input = create().validate(createHosted());
    expect(poll.done(await poll.refresh(context, input, created))).toBe(false);
    await report(created.nodeId!, [{ id: created.id, state: 'running', addresses: [] }]);
    await reconcile(created.id);
    const refreshed = (await poll.refresh(context, input, created)) as View;
    expect(refreshed.state).toBe('running');
    expect(poll.done(refreshed)).toBe(true);
  });

  it('refuses with SPEND_LIMIT_REACHED when the pool meters budgets and the budget is spent', async () => {
    const input = create().validate(createHosted());
    let allowed = true;
    const context = {
      ...moduleContext(db),
      caller: alice,
      iam: {
        billingCheck: async () =>
          allowed
            ? { allowed: true, budgets: [] }
            : { allowed: false, budgets: [], blockedBy: { budgetId: 'bud_1', name: 'monthly' } },
      },
    } as unknown as MethodContext;
    // No budget policy on the pool: not asked.
    allowed = false;
    await expect(create().admission.check(context, input, {})).resolves.toBeUndefined();
    await db.query(
      `UPDATE pools SET policy = jsonb_set(policy, '{admission}', '{"budgetCheck":"meter"}') WHERE id = $1`,
      [hostedPool],
    );
    await expect(create().admission.check(context, input, {})).rejects.toMatchObject({
      code: 'SPEND_LIMIT_REACHED',
      details: { budgetId: 'bud_1', name: 'monthly' },
    });
    allowed = true;
    await expect(create().admission.check(context, input, {})).resolves.toBeUndefined();
  });
});

describe('flavors and IPAM', () => {
  it('lists flavors for tenants the pool is offered to, and archives used ones', async () => {
    const flavors = (await call('flavors', 'list', { tenantId: 'acme', poolId: hostedPool })) as {
      items: { name: string }[];
    };
    expect(flavors.items.map((flavor) => flavor.name)).toEqual([
      'g1.huge',
      'g1.large',
      'g1.small',
      'gpu1.l40s',
    ]);
    await expect(
      call('flavors', 'create', {
        tenantId: 'acme',
        poolId: hostedPool,
        name: 'x',
        vcpu: 1,
        memoryGiB: 1,
        diskGiB: 1,
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await call('instances', 'create', createHosted());
    expect(
      await call(
        'flavors',
        'delete',
        { tenantId: 'root', poolId: hostedPool, name: 'g1.small' },
        root,
      ),
    ).toEqual({
      deleted: false,
      archived: true,
    });
    expect(
      await call(
        'flavors',
        'delete',
        { tenantId: 'root', poolId: hostedPool, name: 'g1.huge' },
        root,
      ),
    ).toEqual({
      deleted: true,
      archived: false,
    });
    await expect(
      call('instances', 'create', createHosted({ idempotencyKey: 'x' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('never leases an address twice, and says so when the range runs out', async () => {
    // 10.0.0.0/29: hosts .2–.6 after the gateway .1.
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const created = (await call(
        'instances',
        'create',
        createHosted({ idempotencyKey: `ip-${index}` }),
      )) as View;
      ids.push(created.addresses[0]!);
    }
    expect(ids).toEqual(['10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6']);
    await expect(
      call('instances', 'create', createHosted({ idempotencyKey: 'ip-6' })),
    ).rejects.toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
    });
  });
});

describe('provider instances', () => {
  let providerPool: string;
  let accountId: string;

  beforeEach(async () => {
    await expect(
      call(
        'providerAccounts',
        'create',
        { tenantId: 'root', provider: 'fake-cloud', name: 'main', config: { token: 'plain-text' } },
        root,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const account = (await call(
      'providerAccounts',
      'create',
      {
        tenantId: 'root',
        provider: 'fake-cloud',
        name: 'main',
        config: { token: 'env://FAKE_TOKEN' },
      },
      root,
    )) as { id: string; config: Record<string, unknown> };
    expect(account.config).toEqual({ token: 'env://FAKE_TOKEN', location: 'fsn1' });
    accountId = account.id;
    const pool = (await callCapacity('pools', 'create', {
      tenantId: 'root',
      siteId: 'site_01jz00000000000000000000aa',
      class: 'provider',
      providerAccountId: accountId,
    })) as { id: string; agent: string };
    expect(pool.agent).toBe('none');
    providerPool = pool.id;
    await callCapacity('pools', 'offer', {
      tenantId: 'root',
      poolId: providerPool,
      toTenantId: 'acme',
      quota: { vcpu: 8, memoryGiB: 16, diskGiB: 200 },
    });
    await call(
      'flavors',
      'create',
      {
        tenantId: 'root',
        poolId: providerPool,
        name: 'cx22',
        vcpu: 2,
        memoryGiB: 4,
        diskGiB: 40,
        offerId: 'cx22',
      },
      root,
    );
    await expect(
      call(
        'flavors',
        'create',
        { tenantId: 'root', poolId: providerPool, name: 'bad', vcpu: 2, memoryGiB: 4, diskGiB: 40 },
        root,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  const createProvider = (extra: Record<string, unknown> = {}) => ({
    tenantId: 'acme',
    poolId: providerPool,
    flavor: 'cx22',
    imageId: 'ubuntu-24.04',
    sshKeys: [KEY],
    idempotencyKey: 'cloud-1',
    ...extra,
  });

  it('creates idempotently through the provider, then follows it to running', async () => {
    const created = (await call('instances', 'create', createProvider())) as View;
    expect(created.state).toBe('scheduling');
    expect(
      Object.fromEntries(
        (await readQuotas(db, 'acme', providerPool)).map((row) => [row.resource, row.used]),
      ),
    ).toMatchObject({
      vcpu: 2,
      memoryGiB: 4,
      diskGiB: 40,
    });
    await reconcile(created.id);
    await reconcile(created.id); // a crash-and-retry of the same step creates nothing new
    expect(cloud.creates).toBe(1);
    const machine = [...cloud.machines.values()][0]!;
    expect(machine).toMatchObject({ key: created.id, offerId: 'cx22' });
    expect(machine.userData).toContain(KEY);
    expect(machine.userData).not.toMatch(/token|join/i);
    expect(await get(created.id)).toMatchObject({
      state: 'provisioning',
      externalId: 'srv-1',
      addresses: ['203.0.113.1'],
    });

    machine.state = 'running';
    await reconcile(created.id);
    expect((await get(created.id)).state).toBe('running');

    await call('instances', 'stop', { tenantId: 'acme', instanceId: created.id });
    await reconcile(created.id);
    expect(machine.state).toBe('stopped');
    await reconcile(created.id);
    expect((await get(created.id)).state).toBe('stopped');

    await call('instances', 'delete', { tenantId: 'acme', instanceId: created.id });
    await reconcile(created.id);
    expect(cloud.machines.size).toBe(0);
    expect((await get(created.id)).state).toBe('deleted');
    expect((await readQuotas(db, 'acme', providerPool)).every((row) => row.used === 0)).toBe(true);
  });

  it('records provider errors and retries; a vanished machine is lost', async () => {
    cloud.fail = 'rate limited';
    const created = (await call('instances', 'create', createProvider())) as View;
    await reconcile(created.id);
    expect(await get(created.id)).toMatchObject({
      state: 'scheduling',
      conditions: [{ type: 'ProviderError', reason: 'PROVIDER_ERROR' }],
    });
    delete cloud.fail;
    await reconcile(created.id);
    expect(await get(created.id)).toMatchObject({ state: 'provisioning', conditions: [] });
    cloud.machines.clear();
    await reconcile(created.id);
    expect((await get(created.id)).state).toBe('lost');
    await call('instances', 'delete', { tenantId: 'acme', instanceId: created.id });
    await reconcile(created.id);
    expect((await get(created.id)).state).toBe('deleted');
  });

  it('lists offers and refuses to delete accounts in use', async () => {
    const offers = (await call(
      'providerAccounts',
      'offers',
      { tenantId: 'root', accountId },
      root,
    )) as { items: { id: string }[] };
    expect(offers.items.map((offer) => offer.id)).toEqual(['cx22']);
    await expect(
      call('providerAccounts', 'delete', { tenantId: 'root', accountId }, root),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    const updated = (await call(
      'providerAccounts',
      'update',
      { tenantId: 'root', accountId, config: { token: 'vault://kv/fake', location: 'hel1' } },
      root,
    )) as {
      version: number;
      config: unknown;
    };
    expect(updated).toMatchObject({
      version: 2,
      config: { token: 'vault://kv/fake', location: 'hel1' },
    });
    const listed = (await call('providerAccounts', 'list', { tenantId: 'root' }, root)) as {
      items: unknown[];
    };
    expect(listed.items).toHaveLength(1);
    await expect(
      call('providerAccounts', 'get', { tenantId: 'acme', accountId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets an account go once its pools are archived and its instances deleted', async () => {
    const created = (await call('instances', 'create', createProvider())) as View;
    await reconcile(created.id);
    await callCapacity('pools', 'archive', { tenantId: 'root', poolId: providerPool });
    // A live instance still pins the account.
    await expect(
      call('providerAccounts', 'delete', { tenantId: 'root', accountId }, root),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await call('instances', 'delete', { tenantId: 'acme', instanceId: created.id });
    await reconcile(created.id);
    expect((await get(created.id)).state).toBe('deleted');
    expect(await call('providerAccounts', 'delete', { tenantId: 'root', accountId }, root)).toEqual(
      {
        deleted: true,
      },
    );
    const { rows } = await db.query<{ provider_account_id: string | null }>(
      `SELECT provider_account_id FROM instances WHERE id = $1`,
      [created.id],
    );
    expect(rows).toEqual([{ provider_account_id: null }]);
  });

  it('cannot be resized in place', async () => {
    const created = (await call('instances', 'create', createProvider())) as View;
    await expect(
      call('instances', 'resize', { tenantId: 'acme', instanceId: created.id, flavor: 'cx22' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

describe('time', () => {
  it('uses the sim clock for timestamps', async () => {
    await setSimClock(db, T0 + 1000);
    clock.advance(1000);
    const created = (await call('instances', 'create', createHosted())) as View;
    const { rows } = await db.query<{ ms: number }>(
      `SELECT (extract(epoch FROM created_at) * 1000)::float8 AS ms FROM instances WHERE id = $1`,
      [created.id],
    );
    expect(rows[0]!.ms).toBe(T0 + 1000);
  });
});

describe('instance metering (§12.7)', () => {
  it('bills vCPU, memory and GPU hours from placement until the allocation is released', async () => {
    const created = (await call(
      'instances',
      'create',
      createHosted({ flavor: 'gpu1.l40s' }),
    )) as View;
    const usage = module.reconcilers!.find((reconciler) => reconciler.name === 'vps.usage')!;
    const runUsage = () =>
      usage.run({ ...moduleContext(db), signal: new AbortController().signal }, 'all');
    clock.advance(90 * 60_000);
    await setSimClock(db, clock.now());
    await runUsage();
    const first = await db.query<{ meter: string; quantity: string }>(
      `SELECT meter, quantity::text FROM usage_windows ORDER BY meter`,
    );
    expect(first.rows.map((row) => [row.meter, Number(row.quantity)])).toEqual([
      ['gpu.l40s.hours', 1],
      ['vps.memory.gib.hours', 32],
      ['vps.vcpu.hours', 8],
    ]);

    await call('instances', 'delete', { tenantId: 'acme', instanceId: created.id });
    await reconcile(created.id);
    await report(created.nodeId!, []);
    await reconcile(created.id);
    await runUsage();
    const { rows } = await db.query<{ meter: string; total: string }>(
      `SELECT meter, sum(quantity)::text AS total FROM usage_windows GROUP BY meter ORDER BY meter`,
    );
    expect(rows.map((row) => [row.meter, Number(row.total)])).toEqual([
      ['gpu.l40s.hours', 1.5],
      ['vps.memory.gib.hours', 48],
      ['vps.vcpu.hours', 12],
    ]);
    await runUsage();
    expect((await db.query(`SELECT 1 FROM usage_windows`)).rows).toHaveLength(6);
  });
});

describe('keyed providerAccounts.create (FleetConfig ids)', () => {
  it('derives the id from the key, replays, and refuses a reused key', async () => {
    const input = {
      tenantId: 'root',
      provider: 'fake-cloud',
      name: 'fleet-main',
      config: { token: 'env://FAKE_TOKEN' },
      idempotencyKey: 'fleet:root:account:main',
    };
    const expected = await draftId('pacct', 'root', 'usr_root', 'fleet:root:account:main');
    const first = (await call('providerAccounts', 'create', input, root)) as { id: string };
    expect(first.id).toBe(expected);
    const again = (await call('providerAccounts', 'create', input, root)) as { id: string };
    expect(again.id).toBe(expected);
    await expect(
      call('providerAccounts', 'create', { ...input, name: 'other-name' }, root),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      call('providerAccounts', 'create', { ...input, idempotencyKey: undefined }, root),
    ).rejects.toMatchObject({ code: 'CONFLICT' }); // the name is taken
  });
});
