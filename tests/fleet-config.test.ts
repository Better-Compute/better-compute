import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ComputeError,
  draftId,
  field,
  manifest,
  manualClock,
  type Caller,
  type MethodContext,
  type ModuleContext,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, capacityModule, createCapacityPort } from '@better-compute/capacity';
import { defineProvider, vps, vpsMigrations } from '@better-compute/vps';
import {
  canonical,
  checkDrift,
  fleetAppliedMigration,
  fleetKey,
  fleetModule,
  fleetNamesMigration,
  validateFleetConfig,
  type ApplyResult,
  type FleetConfig,
  type FleetStatus,
  type PlanResult,
} from '@better-compute/fleet';

// FleetConfig as code (PLAN.md §9.2 `fleet`) against the real capacity and vps handlers on PGlite.
// A small composite double stands in for the W5a envelope: `check` validates and grants one call
// (path + canonical input), `invoke` runs a granted call in the caller's transaction, admission
// replays included. `sites/create` is a stand-in with the server's derived-id semantics.

const T0 = Date.UTC(2026, 8, 24, 12);
let db: SqlExecutor;
let published: string[] = [];
let enqueued: string[] = [];

const root: Caller = {
  identityId: 'usr_root',
  identityKind: 'user',
  tenantId: 'root',
  sessionId: 's',
  sessionKind: 'user',
  mfa: false,
};

const fakeCloud = defineProvider({
  id: 'fake-cloud',
  version: '1.0.0',
  provides: ['vps'],
  config: manifest({
    token: field.secret(),
    location: field.option(['fsn1', 'hel1']).default('fsn1'),
  }),
  create: async () => {
    throw new ComputeError('PROVIDER_ERROR', 'not used');
  },
});

function moduleContext(sql: SqlExecutor): ModuleContext {
  const clock = manualClock(T0);
  return {
    sql,
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    capacity: createCapacityPort({ clock }, { random: () => 0, topN: 1 }),
    authz: { async upsert() {}, async remove() {}, async setPending() {} },
    events: {
      async publish(_tx: SqlTx, event: { type: string }) {
        published.push(event.type);
      },
    },
    work: {
      async enqueue(_tx: SqlTx, kind: string, key: string) {
        enqueued.push(`${kind}:${key}`);
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
    transaction: (fn) => fn(tx),
    migrate: () => Promise.reject(new Error('no')),
    close: () => Promise.reject(new Error('no')),
  } as SqlExecutor;
}

type Definition = {
  validate(raw: unknown): unknown;
  handler(context: MethodContext, input: unknown): Promise<unknown>;
  transaction?: 'auto' | 'manual';
  admission?: {
    prepare(
      context: MethodContext,
      input: unknown,
      tx: SqlTx,
    ): Promise<{ status: string; result?: unknown }>;
  };
};

// The server's sites.create, reduced: derived id, replay, root-owned.
type SiteInput = {
  tenantId: string;
  kind: string;
  region: string;
  iamRegion?: string;
  idempotencyKey: string;
};
const siteId = (input: SiteInput, context: MethodContext) =>
  draftId('site', input.tenantId, context.caller!.identityId, input.idempotencyKey);
const readSite = async (tx: SqlTx, id: string) =>
  (await tx.query<{ id: string }>('SELECT id FROM sites WHERE id = $1', [id])).rows[0];
const sitesCreate: Definition = {
  validate(raw) {
    const input = raw as SiteInput;
    if (!input || typeof input.region !== 'string' || typeof input.idempotencyKey !== 'string')
      throw new ComputeError('INVALID_INPUT', 'bad site');
    return input;
  },
  admission: {
    async prepare(context, input, tx) {
      const existing = await readSite(tx, await siteId(input as SiteInput, context));
      return existing ? { status: 'replay', result: existing } : { status: 'decide' };
    },
  },
  async handler(context, raw) {
    const input = raw as SiteInput;
    const id = await siteId(input, context);
    await context.sql.query(
      `INSERT INTO sites (id, owner_tenant_id, kind, region, iam_region, version) VALUES ($1, $2, $3, $4, $5, 1)`,
      [id, input.tenantId, input.kind, input.region, input.iamRegion ?? null],
    );
    return { id };
  },
};

const capacityApi = capacityModule({ random: () => 0, topN: 1 }).api!(
  moduleContext(db!),
) as unknown as Record<string, Record<string, Definition>>;
const image = {
  url: 'https://images.example/u.qcow2',
  sha256: 'ab'.repeat(32),
  format: 'qcow2' as const,
  verified: true,
};
const vpsApi = vps({
  runtimes: ['libvirt-kvm'],
  providers: [fakeCloud],
  images: {
    resolve: async (_tx, _tenant, imageId) => (imageId.startsWith('ubuntu') ? image : undefined),
  },
}).api!(moduleContext(db!)) as unknown as Record<string, Record<string, Definition>>;
const fleetApi = fleetModule().api!(moduleContext(db!)) as unknown as {
  fleet: Record<'export' | 'plan' | 'apply' | 'status', Definition>;
};

const routes: Record<string, Definition> = {
  'sites/create': sitesCreate,
  'quotas/set': capacityApi.quotas!.set!,
  ...Object.fromEntries(
    ['create', 'update', 'archive', 'offer', 'unoffer'].map((verb) => [
      `pools/${verb}`,
      capacityApi.pools![verb]!,
    ]),
  ),
  ...Object.fromEntries(
    ['create', 'update', 'delete'].map((verb) => [`flavors/${verb}`, vpsApi.flavors![verb]!]),
  ),
  ...Object.fromEntries(
    ['create', 'update', 'delete'].map((verb) => [
      `providerAccounts/${verb}`,
      vpsApi.providerAccounts![verb]!,
    ]),
  ),
  ...Object.fromEntries(
    ['create', 'update', 'delete'].map((verb) => [
      `sandboxTemplates/${verb}`,
      vpsApi.sandboxTemplates![verb]!,
    ]),
  ),
};

interface Composite {
  checks: string[];
  invokes: string[];
  deny?: string;
  /** Runs after each check: a concurrent writer moving the state between the phases. */
  afterCheck?: () => Promise<void>;
}
let composite: Composite;

function methodContext(sql: SqlExecutor): MethodContext {
  const grants: string[] = [];
  const context = {
    ...moduleContext(sql),
    caller: root,
    requestId: 'req',
    async check(path: string, input: unknown) {
      const definition = routes[path];
      if (!definition) throw new ComputeError('NOT_FOUND', `no ${path}`);
      definition.validate(input);
      if (composite.deny === path) throw new ComputeError('ACCESS_DENIED', `denied ${path}`);
      grants.push(canonical({ path, input }));
      composite.checks.push(path);
      await composite.afterCheck?.();
    },
    async invoke(tx: SqlTx, path: string, input: unknown) {
      const index = grants.indexOf(canonical({ path, input }));
      if (index < 0) throw new ComputeError('ACCESS_DENIED', `not checked: ${path}`);
      grants.splice(index, 1);
      const definition = routes[path]!;
      const parsed = definition.validate(input);
      const inner = {
        ...moduleContext(within(tx)),
        caller: root,
        requestId: 'req',
        admission: { tenantId: 'root' },
      } as unknown as MethodContext;
      if (definition.admission) {
        const plan = await definition.admission.prepare(inner, parsed, tx);
        if (plan.status === 'replay') return plan.result;
      }
      composite.invokes.push(path);
      return definition.handler(inner, parsed);
    },
  };
  return context as unknown as MethodContext;
}

async function fleet<O>(method: 'export' | 'plan' | 'apply' | 'status', raw: unknown): Promise<O> {
  const definition = fleetApi.fleet[method];
  const input = definition.validate(raw);
  if (definition.transaction === 'manual')
    return (await definition.handler(methodContext(db), input)) as O;
  return db.transaction(
    async (tx) => (await definition.handler(methodContext(within(tx)), input)) as O,
  );
}
const plan = (config: unknown, prune = false) =>
  fleet<PlanResult>('plan', { tenantId: 'root', config, prune });
const apply = (config: unknown, extra: Record<string, unknown> = {}) =>
  fleet<ApplyResult>('apply', { tenantId: 'root', config, ...extra });

const base: FleetConfig = {
  version: 1,
  sites: [{ name: 'fra', kind: 'shared', region: 'eu-central' }],
  providerAccounts: [
    { name: 'cloud', provider: 'fake-cloud', config: { token: 'env://FAKE_TOKEN' } },
  ],
  pools: [
    {
      name: 'vps-fra',
      site: 'fra',
      class: 'vps-host',
      gpuModel: 'L40S',
      policy: { maxDuration: 'P7D' },
      ownerQuota: { gpu: 8 },
      offers: [{ tenant: 'acme', quota: { vcpu: 64, gpu: 2 }, priority: 5 }],
    },
    { name: 'burst', site: 'fra', class: 'provider', providerAccount: 'cloud' },
  ],
  flavors: [{ pool: 'vps-fra', name: 'g1.small', vcpu: 2, memoryGiB: 4, diskGiB: 40 }],
};
const clone = (): FleetConfig => JSON.parse(JSON.stringify(base)) as FleetConfig;

beforeAll(async () => {
  db = pglite();
  await db.migrate([
    ...capacityMigrations,
    ...vpsMigrations,
    fleetNamesMigration,
    fleetAppliedMigration,
  ]);
});
afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  for (const table of [
    'fleet_names',
    'fleet_applied',
    'sandbox_templates',
    'flavors',
    'quota_usage',
    'pool_offers',
    'pool_capacity_rollup',
    'pools',
    'provider_accounts',
    'sites',
  ])
    await db.query(`DELETE FROM ${table}`);
  await useSimClock(db, T0);
  composite = { checks: [], invokes: [] };
  published = [];
  enqueued = [];
});

describe('drift against the applied document', () => {
  const drift = () => db.transaction((tx) => checkDrift(moduleContext(db), tx, 'root'));
  const status = () => fleet<FleetStatus>('status', { tenantId: 'root' });
  const fleetEvents = () => published.filter((type) => type.startsWith('fleet.'));

  it('records the applied document, reports drift once, and reports convergence', async () => {
    expect(await status()).toEqual({ tenantId: 'root' });
    const applied = await apply(base);
    expect(await status()).toMatchObject({
      applied: { planHash: applied.plan.planHash, appliedBy: 'usr_root', prune: false },
    });
    expect(await drift()).toBeUndefined();
    expect(fleetEvents()).toEqual([]);

    // Someone changes a pool outside fleet.
    const poolId = await draftId('pool', 'root', 'usr_root', fleetKey('root', 'pool', 'vps-fra'));
    await db.query(`UPDATE pools SET policy = '{"maxDuration":"P1D"}'::jsonb WHERE id = $1`, [
      poolId,
    ]);
    const found = await drift();
    expect(found?.changes).toEqual([
      { kind: 'pool', name: 'vps-fra', action: 'update', fields: ['policy'] },
    ]);
    expect(fleetEvents()).toEqual(['fleet.drifted']);
    expect((await status()).drift?.summary.update).toBe(1);
    // The same drift is not announced again.
    await drift();
    expect(fleetEvents()).toEqual(['fleet.drifted']);

    // The fleet moves back on its own: convergence is announced once.
    await db.query(`UPDATE pools SET policy = '{"maxDuration":"P7D"}'::jsonb WHERE id = $1`, [
      poolId,
    ]);
    expect(await drift()).toBeUndefined();
    expect(fleetEvents()).toEqual(['fleet.drifted', 'fleet.converged']);
    expect((await status()).drift).toBeUndefined();
  });

  it('an empty apply still records the document; the reconciler fans out per tenant', async () => {
    await apply(base);
    await db.query('DELETE FROM fleet_applied');
    const again = await apply(base);
    expect(again.applied).toBe(0);
    expect((await status()).applied?.planHash).toBe(again.plan.planHash);

    const reconciler = fleetModule().reconcilers!.find((entry) => entry.name === 'fleet.drift')!;
    expect(reconciler.periodic).toEqual([{ key: 'all', every: '15m' }]);
    const context = { ...moduleContext(db), signal: new AbortController().signal };
    await reconciler.run(context, 'all');
    expect(enqueued).toEqual(['fleet.drift:tenant:root']);
    await expect(reconciler.run(context, 'tenant:root')).resolves.toBe('DONE');
  });
});

describe('sandbox templates (v0.5, PLAN §3.7)', () => {
  const withTemplate = (): FleetConfig => ({
    ...clone(),
    sandboxTemplates: [
      {
        name: 'ci',
        pool: 'vps-fra',
        flavor: 'g1.small',
        imageId: 'ubuntu-24.04',
        maxTtlSeconds: 7200,
        warm: { min: 0, max: 2 },
      },
    ],
  });

  it('creates a template after the flavor it names, round-trips export, and updates in place', async () => {
    const created = await apply(withTemplate());
    expect(composite.invokes.slice(-2)).toEqual(['flavors/create', 'sandboxTemplates/create']);
    expect(created.applied).toBe(7);
    const exported = await fleet<{ config: FleetConfig }>('export', { tenantId: 'root' });
    expect(exported.config.sandboxTemplates).toEqual([
      {
        name: 'ci',
        pool: 'vps-fra',
        flavor: 'g1.small',
        imageId: 'ubuntu-24.04',
        runtime: 'libvirt-kvm',
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 7200,
        warm: { min: 0, max: 2 },
        network: 'egress',
      },
    ]);
    // Server-filled fields (runtime, the default TTL) are not drift; the export plans to nothing.
    expect((await plan(withTemplate())).calls).toEqual([]);
    expect((await plan(validateFleetConfig(exported.config))).calls).toEqual([]);

    const next = withTemplate();
    next.sandboxTemplates![0]!.warm = { min: 1, max: 3 };
    next.sandboxTemplates![0]!.imageId = 'ubuntu-26.04';
    next.sandboxTemplates![0]!.network = 'private';
    const planned = await plan(next);
    expect(planned.changes.find((change) => change.kind === 'sandboxTemplate')).toMatchObject({
      action: 'update',
      fields: ['imageId', 'network', 'warm'],
    });
    expect(planned.calls).toEqual([
      {
        path: 'sandboxTemplates/update',
        input: {
          tenantId: 'root',
          templateId: expect.stringMatching(/^sbxt_/),
          imageId: 'ubuntu-26.04',
          network: 'private',
          warm: { min: 1, max: 3 },
        },
      },
    ]);
    // env is planned as a whole map (applying it needs the secret broker, absent here).
    const withEnv = withTemplate();
    withEnv.sandboxTemplates![0]!.env = { TOKEN: 'secret://root/sec_1' };
    expect((await plan(withEnv)).calls[0]).toMatchObject({
      path: 'sandboxTemplates/update',
      input: { env: { TOKEN: 'secret://root/sec_1' } },
    });
    await apply(next, { planHash: planned.planHash });
    expect((await plan(next)).calls).toEqual([]);
  });

  it('blocks a pool or runtime change and an unknown pool; prunes templates before flavors', async () => {
    await apply(withTemplate());
    const moved = withTemplate();
    moved.sandboxTemplates![0]!.runtime = 'cloud-hypervisor';
    expect(
      (await plan(moved)).changes.find((change) => change.kind === 'sandboxTemplate'),
    ).toMatchObject({
      blocked: 'runtime cannot change; create a new template',
    });
    const ghost = withTemplate();
    ghost.sandboxTemplates![0]!.pool = 'ghost';
    expect((await plan(ghost)).blocked).toBe(true);

    const pruned = await plan({ ...clone(), flavors: [] }, true);
    expect(pruned.calls.map((call) => call.path).slice(0, 2)).toEqual([
      'sandboxTemplates/delete',
      'flavors/delete',
    ]);
    await apply({ ...clone(), flavors: [] }, { prune: true });
    const exported = await fleet<{ config: FleetConfig }>('export', { tenantId: 'root' });
    expect(exported.config.sandboxTemplates).toBeUndefined();
  });

  it('validates templates', () => {
    const bad = (template: Record<string, unknown>) => () =>
      validateFleetConfig({ version: 1, sandboxTemplates: [template] });
    const ok = { name: 'ci', pool: 'vps-fra', flavor: 'g1.small', imageId: 'ubuntu-24.04' };
    expect(bad({ ...ok, extra: 1 })).toThrow(/sandboxTemplates\[0\]\.extra is not a known field/);
    expect(bad({ ...ok, maxTtlSeconds: 10 })).toThrow(/maxTtlSeconds must be an integer/);
    expect(bad({ ...ok, warm: { min: 65 } })).toThrow(/warm\.min/);
    expect(bad({ ...ok, pool: 'Bad Pool' })).toThrow(/pool is not in the expected form/);
    expect(bad({ ...ok, env: { TOKEN: 'plaintext' } })).toThrow(
      /env\.TOKEN is not in the expected form/,
    );
    expect(bad({ ...ok, env: { 'bad-name': 'secret://root/x' } })).toThrow(
      /is not a variable name/,
    );
    expect(bad({ ...ok, network: 'open' })).toThrow(/must be egress, private or none/);
    expect(() => validateFleetConfig({ version: 1, sandboxTemplates: [ok, ok] })).toThrow(
      /repeats "ci"/,
    );
    expect(
      validateFleetConfig({
        version: 1,
        sandboxTemplates: [{ ...ok, pool: `pool_${'a'.repeat(26)}` }],
      }).sandboxTemplates?.[0]?.pool,
    ).toBe(`pool_${'a'.repeat(26)}`);
  });
});

describe('fleet.apply', () => {
  it('creates everything in dependency order, with ids derived from the caller and the name', async () => {
    const result = await apply(base);
    expect(result.applied).toBe(6);
    expect(composite.invokes).toEqual([
      'providerAccounts/create',
      'sites/create',
      'pools/create',
      'pools/create',
      'pools/offer',
      'flavors/create',
    ]);
    // Each call was decided once, before anything ran.
    expect(composite.checks).toHaveLength(6);

    const poolId = await draftId('pool', 'root', 'usr_root', fleetKey('root', 'pool', 'vps-fra'));
    const pool = await db.query<{ gpu_model: string; policy: unknown }>(
      'SELECT gpu_model, policy FROM pools WHERE id = $1',
      [poolId],
    );
    expect(pool.rows[0]?.gpu_model).toBe('L40S');
    const offer = await db.query<{ priority: number }>(
      `SELECT priority FROM pool_offers WHERE pool_id = $1 AND tenant_id = 'acme'`,
      [poolId],
    );
    expect(offer.rows[0]?.priority).toBe(5);
    const names = await db.query<{ kind: string; name: string }>(
      'SELECT kind, name FROM fleet_names ORDER BY kind, name',
    );
    expect(names.rows.map((row) => `${row.kind}:${row.name}`)).toEqual([
      'pool:burst',
      'pool:vps-fra',
      'providerAccount:cloud',
      'site:fra',
    ]);
  });

  it('is idempotent: a second plan is all unchanged, and export round-trips', async () => {
    await apply(base);
    const again = await plan(base);
    expect(again.calls).toEqual([]);
    expect(again.summary.create + again.summary.update + again.summary.delete).toBe(0);
    const exported = await fleet<{ config: FleetConfig }>('export', { tenantId: 'root' });
    const replanned = await plan(validateFleetConfig(exported.config));
    expect(replanned.calls).toEqual([]);
    expect(exported.config.pools?.find((pool) => pool.name === 'vps-fra')).toMatchObject({
      site: 'fra',
      gpuModel: 'L40S',
      ownerQuota: { gpu: 8 },
      offers: [{ tenant: 'acme', quota: { vcpu: 64, gpu: 2 }, priority: 5 }],
    });
  });

  it('updates only what changed, through the owning methods', async () => {
    await apply(base);
    const next = clone();
    next.pools![0]!.policy = { maxDuration: 'P30D' };
    next.pools![0]!.ownerQuota = { gpu: 16 };
    next.pools![0]!.offers![0]!.quota = { vcpu: 128, gpu: 2 };
    next.flavors![0]!.vcpu = 4;
    next.providerAccounts![0]!.config = { token: 'env://FAKE_TOKEN', location: 'hel1' };
    const planned = await plan(next);
    expect(planned.calls.map((call) => call.path)).toEqual([
      'providerAccounts/update',
      'pools/update',
      'quotas/set',
      'pools/offer',
      'flavors/update',
    ]);
    composite = { checks: [], invokes: [] };
    await apply(next, { planHash: planned.planHash });
    expect((await plan(next)).calls).toEqual([]);
  });

  it('deletes only with prune: unoffer, flavors, archive pools, then provider accounts', async () => {
    await apply(base);
    const next = clone();
    next.pools = [{ ...next.pools![0]!, offers: [] }];
    next.flavors = [];
    delete next.providerAccounts;
    expect((await plan(next)).calls).toEqual([]);
    const pruned = await plan(next, true);
    expect(pruned.calls.map((call) => call.path)).toEqual([
      'flavors/delete',
      'pools/unoffer',
      'pools/archive',
      // Archived pools do not pin their provider account.
      'providerAccounts/delete',
    ]);
    await apply(next, { prune: true });
    const state = await fleet<{ config: FleetConfig }>('export', { tenantId: 'root' });
    expect(state.config.pools?.map((pool) => pool.name)).toEqual(['vps-fra']);
    expect(state.config.flavors).toBeUndefined();
    expect(state.config.providerAccounts).toBeUndefined();
    expect(
      await db.query(`SELECT 1 FROM fleet_names WHERE kind = 'pool' AND name = 'burst'`),
    ).toMatchObject({
      rows: [],
    });
  });

  it('refuses a plan with immutable changes before deciding anything', async () => {
    await apply(base);
    const next = clone();
    next.pools![0]!.class = 'metal-host';
    next.sites![0]!.region = 'us-east';
    const planned = await plan(next);
    expect(planned.blocked).toBe(true);
    expect(planned.changes.filter((change) => change.blocked).map((change) => change.name)).toEqual(
      ['fra', 'vps-fra'],
    );
    composite = { checks: [], invokes: [] };
    await expect(apply(next)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(composite.checks).toEqual([]);
  });

  it('blocks dangling references and offers to the owner', async () => {
    const next = clone();
    next.pools![1]!.site = 'nowhere';
    next.pools![0]!.offers!.push({ tenant: 'root', quota: { gpu: 1 } });
    next.flavors!.push({ pool: 'ghost', name: 'x', vcpu: 1, memoryGiB: 1, diskGiB: 1 });
    const planned = await plan(next);
    expect(
      planned.changes.filter((change) => change.blocked).map((change) => change.blocked),
    ).toEqual([
      'a pool is not offered to its owner; use ownerQuota',
      'unknown site nowhere',
      'unknown pool ghost',
    ]);
  });

  it('writes nothing when one call is denied in phase 1', async () => {
    composite.deny = 'pools/offer';
    await expect(apply(base)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(composite.invokes).toEqual([]);
    expect((await db.query('SELECT 1 FROM sites')).rows).toEqual([]);
  });

  it('refuses with CONFIG_DRIFT when the reviewed plan moved', async () => {
    const reviewed = await plan(base);
    await apply({ ...clone(), flavors: [] });
    await expect(apply(base, { planHash: reviewed.planHash })).rejects.toMatchObject({
      code: 'CONFIG_DRIFT',
    });
  });

  it('refuses with CONFIG_DRIFT, and applies nothing, when the state moves between the phases', async () => {
    await apply(base);
    const next = clone();
    next.flavors![0]!.vcpu = 8;
    const poolId = await draftId('pool', 'root', 'usr_root', fleetKey('root', 'pool', 'vps-fra'));
    composite = {
      checks: [],
      invokes: [],
      afterCheck: async () => {
        await db.query(`UPDATE pools SET policy = '{"changed":true}'::jsonb WHERE id = $1`, [
          poolId,
        ]);
      },
    };
    await expect(apply(next)).rejects.toMatchObject({ code: 'CONFIG_DRIFT' });
    expect(composite.invokes).toEqual([]);
    const flavor = await db.query<{ vcpu: number }>(
      `SELECT vcpu FROM flavors WHERE name = 'g1.small'`,
    );
    expect(Number(flavor.rows[0]?.vcpu)).toBe(2);
  });
});

describe('validateFleetConfig', () => {
  it('rejects unknown fields, duplicates and bad names', () => {
    expect(() => validateFleetConfig({ version: 2 })).toThrow(/version/);
    expect(() => validateFleetConfig({ version: 1, extra: true })).toThrow(/extra/);
    expect(() =>
      validateFleetConfig({
        version: 1,
        sites: [
          { name: 'a', kind: 'shared', region: 'eu' },
          { name: 'a', kind: 'shared', region: 'eu' },
        ],
      }),
    ).toThrow(/repeats/);
    expect(() =>
      validateFleetConfig({
        version: 1,
        sites: [{ name: 'Bad Name', kind: 'shared', region: 'eu' }],
      }),
    ).toThrow(/sites\[0\]\.name/);
    expect(validateFleetConfig(base)).toEqual(base);
  });
});
