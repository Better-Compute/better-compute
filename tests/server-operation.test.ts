import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ComputeError,
  defineDriver,
  defineMethod,
  defineModule,
  definePlugin,
  manifest,
  type CommandKindSpec,
  type ComputeModule,
  type ComputePlugin,
  type MethodDefinition,
  type SqlExecutor,
} from '@better-compute/core';
import { restoreSystemClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  betterCompute,
  builtinCommandKinds,
  serverVersion,
  validateNoInput,
} from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import {
  ACME,
  BASE_URL,
  NODE_ID,
  OTHER,
  ROOT,
  acme,
  options,
  spyExecutor,
} from './support/server.js';

// The envelope every method runs through (PLAN.md §3.4 steps 2, 3, 6), the module host and the
// method → action registry (§5.1, §9.2), initialize(), selfCheck() and the P0 lifecycle.

let db: SqlExecutor;
beforeAll(async () => {
  db = pglite();
});
afterAll(async () => {
  await db.close();
});

const USER = 'token-acme-user-0123456789';
const OUTSIDER = 'token-other-user-0123456789';
const ADMIN = 'token-root-admin-0123456789';

/** A fake IAM with three callers and a spying view of the shared store. */
function harness() {
  const iam = fakeIam();
  iam.addCaller(USER, { tenantId: ACME, identityId: 'id-user', sessionId: 'ses-user' });
  iam.addCaller(OUTSIDER, { tenantId: OTHER, identityId: 'id-outsider' });
  iam.addCaller(ADMIN, { tenantId: ROOT, identityId: 'id-admin', mfa: true });
  return { iam, database: spyExecutor(db) };
}

/** A server with plugin `acme`. */
function setup() {
  const { iam, database } = harness();
  return { iam, database, compute: betterCompute({ ...options(database, iam), plugins: [acme] }) };
}

/** With the tenant gate loaded (a process's first call loads it otherwise), and the store log cleared. */
async function primed<
  T extends { compute: { tenants: { ready(): Promise<void> } }; database: { log: string[] } },
>(server: T): Promise<T> {
  await server.compute.tenants.ready();
  server.database.log.length = 0;
  return server;
}

/** A server with other modules and plugins (plugin `acme` unless `plugins` says otherwise). */
function setupWith(extra: {
  modules?: readonly ComputeModule[];
  plugins?: readonly ComputePlugin[];
}) {
  const { iam, database } = harness();
  const compute = betterCompute({
    ...options(database, iam),
    modules: extra.modules ?? [],
    plugins: extra.plugins ?? [acme],
  });
  return { iam, database, compute };
}

/** Runs `fn` and returns the ComputeError it threw. */
async function failure(fn: () => unknown): Promise<ComputeError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ComputeError);
    return error as ComputeError;
  }
  throw new Error('Expected a ComputeError');
}

function configError(fn: () => unknown, pattern: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ComputeError);
  expect((caught as ComputeError).code).toBe('INVALID_CONFIG');
  expect((caught as ComputeError).message).toMatch(pattern);
}

const read = (
  action: `compute:${string}`,
  resource: MethodDefinition['resource'],
  kind: 'read' | 'mutation' = 'read',
) =>
  defineMethod<Record<string, string>, { ok: true }>({
    action,
    kind,
    resource,
    validate: (input) => input as Record<string, string>,
    handler: async () => ({ ok: true }),
  });
const onNode = (input: Record<string, string>) => ({ type: 'node', id: input.nodeId ?? 'n' });

/** The server's own v0.1 groups (module `server` in §9.2), registered right after `system`. */
const serverPaths = [
  'projects/create',
  'projects/get',
  'projects/list',
  'projects/archive',
  'sites/list',
  'sites/get',
  'sites/create',
  'sites/update',
  'sites/delete',
  'joinTokens/create',
  'joinTokens/list',
  'joinTokens/revoke',
  'nodes/list',
  'nodes/get',
  'nodes/events',
  'nodes/cordon',
  'nodes/uncordon',
  'nodes/drain',
  'nodes/label',
  'nodes/taint',
  'nodes/adopt',
  'nodes/revokeIdentity',
  'nodes/delete',
  'commands/run',
  'commands/get',
  'commands/list',
  'commands/cancel',
  'usage/list',
  'usage/export',
  'usage/platform',
  'events/list',
  // v0.2 (tests/server-groups-*).
  'joinRequests/list',
  'joinRequests/approve',
  'joinRequests/reject',
  'siteTokens/create',
  'siteTokens/revoke',
  'secrets/put',
  'secrets/delete',
  'drivers/list',
];

/** The built-in capacity module's groups (§9.2 module `capacity`), right after `inventory`. */
const capacityPaths = [
  'pools/list',
  'pools/get',
  'pools/create',
  'pools/capacity',
  'pools/offer',
  'pools/unoffer',
  'pools/update',
  'pools/archive',
  'capacity/summary',
  'capacity/byPool',
  'capacity/preview',
  'capacity/timeline',
  'reservations/create',
  'reservations/get',
  'reservations/list',
  'reservations/release',
  'reservations/cancel',
  'reservations/extend',
  'reservations/renew',
  'quotas/get',
  'quotas/set',
];

describe('betterCompute()', () => {
  it('is synchronous and side-effect free', () => {
    const { compute, database, iam } = setup();
    expect(compute).not.toBeInstanceOf(Promise);
    expect(Object.keys(compute).sort()).toEqual(
      [
        'api',
        'authz',
        'caches',
        'context',
        'endpoint',
        'events',
        'gatewayServices',
        'handler',
        'initialize',
        'jobs',
        'nodeHandler',
        'registry',
        'selfCheck',
        'start',
        'stop',
        'tenants',
      ].sort(),
    );
    expect(database.log).toEqual([]);
    expect(iam.calls).toEqual([]);
  });

  it('registers system, then the built-in node controllers, inventory and capacity, then modules and plugins', () => {
    const extras = defineModule({
      name: 'extras',
      api: () => ({
        workflows: { abort: read('compute:workflows:manage', onNode, 'mutation') },
      }),
    });
    const { compute } = setupWith({ modules: [extras] });
    expect(compute.registry.modules).toEqual([
      'node-controllers',
      'site-boot',
      'inventory',
      'capacity',
      'tenancy',
      // Approvals bound to the request a person saw (review 14 M1), always hosted.
      'confirmations',
      // v1.0 destructive-batch quorum (§13), always hosted.
      'quorum',
      // The default secret store's table, when no `secrets` are configured.
      'pki',
      'extras',
      'acme',
    ]);
    expect(compute.registry.plugins).toEqual(['acme']);
    expect(compute.registry.methods.map((method) => method.path)).toEqual([
      'system/whoami',
      'system/version',
      'system/selfCheck',
      ...serverPaths,
      'inventory/get',
      'inventory/history',
      'inventory/diff',
      ...capacityPaths,
      'commandBatches/create',
      'commandBatches/get',
      'commandBatches/list',
      'commandBatches/scope',
      'commandBatches/members',
      'commandBatches/approve',
      'commandBatches/cancel',
      'workflows/abort',
      'plugins/acme/widgets/poke',
      'plugins/acme/widgets/fail',
      'plugins/acme/widgets/get',
      'plugins/acme/widgets/limited',
      'plugins/acme/widgets/crash',
    ]);
    expect(compute.registry.method('nodes/cordon')).toMatchObject({
      module: 'server',
      action: 'compute:nodes:cordon',
      kind: 'mutation',
    });
    const get = compute.registry.method('inventory/get')!;
    expect(get).toMatchObject({ module: 'inventory', action: 'compute:nodes:read', kind: 'read' });
    expect(get.row).toMatchObject({ group: 'inventory', method: 'get', resource: 'node' });
    expect(compute.registry.method('plugins/acme/widgets/poke')).toMatchObject({
      plugin: 'acme',
      module: 'acme',
      action: 'compute:acme:poke',
    });
    expect(compute.registry.method('plugins/acme/widgets/poke')!.row).toBeUndefined();
    expect(compute.registry.actions.has('compute:acme:poke')).toBe(true);
    expect(compute.registry.actions.has('compute:reservations:create')).toBe(true);
    // The built-in capacity module's migrations come first, then tenancy's, the quorum's, the sealed
    // secrets, then the plugin's.
    const migrations = compute.registry.migrations.map((migration) => migration.name);
    expect(migrations[0]).toBe('capacity/0001_device_links');
    expect(migrations.at(-1)).toBe('acme/0001_widgets');
    expect(migrations.at(-2)).toBe('pki/0001_sealed_secrets');
    const quorum = migrations.filter((name) => name.startsWith('quorum/'));
    expect(quorum[0]).toBe('quorum/0001_batches');
    expect(migrations.slice(-2 - quorum.length, -2)).toEqual(quorum);
    const beforeQuorum = migrations.slice(0, -2 - quorum.length);
    expect(beforeQuorum.at(-1)).toBe('confirmations/0001_bindings');
    expect(beforeQuorum.at(-2)).toBe('tenancy/0002_teardown_attempts');
    expect(beforeQuorum.at(-3)).toBe('tenancy/0001_tenant_states');
    expect(beforeQuorum.slice(0, -3).every((name) => name.startsWith('capacity/'))).toBe(true);
    expect(compute.registry.hasModule('inventory')).toBe(true);
    expect(compute.registry.hasModule('capacity')).toBe(true);
    expect(compute.registry.hasModule('metal')).toBe(false);
    // The protocol's built-in command kinds are the server's own.
    expect(compute.registry.commandKind('diag.nvml')).toMatchObject({
      kind: 'diag.nvml',
      timeout: '2m',
      attested: true,
    });
  });

  it('builds compute.api from the registry: groups, then plugins by id', async () => {
    const { compute } = setup();
    expect(Object.keys(compute.api).sort()).toEqual([
      'capacity',
      'commandBatches',
      'commands',
      'drivers',
      'events',
      'inventory',
      'joinRequests',
      'joinTokens',
      'nodes',
      'plugins',
      'pools',
      'projects',
      'quotas',
      'reservations',
      'secrets',
      'siteTokens',
      'sites',
      'system',
      'usage',
    ]);
    expect(Object.keys(compute.api.plugins)).toEqual(['acme']);
    expect(Object.keys(compute.api.plugins.acme.widgets)).toEqual([
      'poke',
      'fail',
      'get',
      'limited',
      'crash',
    ]);
    expect(Object.isFrozen(compute.api)).toBe(true);
    expect(await compute.api.system.version()).toEqual({
      name: 'better-compute',
      version: serverVersion,
      basePath: '/api/compute',
      protocol: { min: 1, max: 1 },
    });
  });

  it('refuses inconsistent modules and plugins with INVALID_CONFIG', () => {
    const base = (extra: Parameters<typeof setupWith>[0]) => () => setupWith(extra);
    configError(base({ plugins: [acme, acme] }), /Plugin acme is registered twice/);
    configError(
      base({
        plugins: [acme, { ...definePlugin({ id: 'other' }), name: 'acme' } as ComputePlugin],
      }),
      /Module acme is registered twice/,
    );
    configError(
      base({ modules: [defineModule({ name: 'inventory' })] }),
      /Module inventory is registered twice/,
    );
    configError(base({ modules: [defineModule({ name: 'core' })] }), /reserved module name/);
    configError(base({ modules: [defineModule({ name: 'Bad Name' })] }), /must match/);
    const cordon = () =>
      defineModule({
        name: `cordon-${Math.random().toString(36).slice(2, 8)}`,
        api: () => ({ nodes: { cordon: read('compute:nodes:cordon', onNode, 'mutation') } }),
      });
    configError(base({ modules: [cordon(), cordon()] }), /nodes\/cordon is registered twice/);
    configError(
      base({
        plugins: [
          definePlugin({
            id: 'beta',
            api: () => ({ things: { look: read('compute:nodes:read', onNode) } }),
          }),
        ],
      }),
      /plugin actions are compute:beta:<verb>/,
    );
    configError(
      base({ plugins: [definePlugin({ id: 'beta', catalog: { actions: ['compute:nodes:x'] } })] }),
      /plugin catalog actions are compute:beta:<verb>/,
    );
    configError(
      base({
        modules: [
          defineModule({
            name: 'odd',
            api: () => ({ plugins: { x: read('compute:nodes:read', onNode) } }),
          }),
        ],
      }),
      /not a usable route segment/,
    );
    configError(
      base({
        modules: [
          defineModule({
            name: 'odd',
            api: () => ({ things: { then: read('compute:nodes:read', onNode) } }),
          }),
        ],
      }),
      /not a usable route segment/,
    );
    configError(
      base({
        modules: [
          defineModule({
            name: 'odd',
            api: () => ({
              things: {
                look: { ...read('compute:nodes:read', onNode), action: null } as MethodDefinition,
              },
            }),
          }),
        ],
      }),
      /null is not a compute:<area>:<verb> action/,
    );
    configError(
      base({
        modules: [
          defineModule({
            name: 'odd',
            api: () => ({
              things: {
                look: { ...read('compute:nodes:read', onNode), kind: 'public' } as MethodDefinition,
              },
            }),
          }),
        ],
      }),
      /a public method has action null/,
    );
    configError(
      base({ modules: [defineModule({ name: 'needy', requires: ['metal'] })] }),
      /needy requires module metal/,
    );
    configError(
      base({ modules: [defineModule({ name: 'capacity' })] }),
      /Module capacity is registered twice/,
    );
    configError(
      base({
        modules: [
          defineModule({
            name: 'nvml-again',
            commandKinds: [{ ...builtinCommandKinds[0]! }],
          }),
        ],
      }),
      /Command kind diag.nvml is registered twice/,
    );
    configError(
      base({
        modules: [defineModule({ name: 'mod-a', migrations: [{ name: 'mod-b/0001_x', sql: '' }] })],
      }),
      /must be named mod-a\/<nnnn>_<slug>/,
    );
    const kind: CommandKindSpec = {
      kind: 'acme.blink',
      lane: 'control',
      retrySafe: true,
      timeout: '1m',
      roles: ['node'],
      payload: { kind: 'message', typeName: 'acme.Blink' },
    };
    configError(
      base({
        modules: [
          defineModule({ name: 'blink-a', commandKinds: [kind] }),
          defineModule({ name: 'blink-b', commandKinds: [kind] }),
        ],
      }),
      /Command kind acme.blink is registered twice/,
    );
  });

  it('refuses duplicate extensions and bad options with INVALID_CONFIG', () => {
    const iam = fakeIam();
    const good = options(db, iam);
    const driver = defineDriver({
      id: 'redfish',
      version: '1.0.0',
      runsOn: 'site',
      config: manifest({}),
      implements: {},
    });
    configError(
      () => betterCompute({ ...good, drivers: [driver, driver] }),
      /Extension driver:redfish@1.0.0 is registered twice/,
    );
    configError(
      () =>
        betterCompute({
          ...good,
          drivers: [driver],
          modules: [defineModule({ name: 'dup', extensions: [driver] })],
        }),
      /registered twice/,
    );
    configError(() => betterCompute({ ...good, secret: 'short' }), /secret/);
    configError(() => betterCompute({ ...good, baseURL: 'not a url' }), /baseURL/);
    configError(() => betterCompute({ ...good, baseURL: 'https://x.test/?a=1' }), /baseURL/);
    configError(() => betterCompute({ ...good, baseURL: 'ftp://x.test' }), /baseURL/);
    configError(() => betterCompute({ ...good, basePath: '/api/compute/' }), /basePath/);
    configError(() => betterCompute({ ...good, basePath: 'api' }), /basePath/);
    configError(() => betterCompute({ ...good, rootTenantId: '' }), /rootTenantId/);
    // The root tenant may come from the IAM port instead (IamPort.rootTenantId); both must agree.
    const { rootTenantId: _root, ...withoutRoot } = good;
    configError(() => betterCompute(withoutRoot), /rootTenantId/);
    expect(() =>
      betterCompute({ ...withoutRoot, iam: { ...iam, rootTenantId: ROOT } }),
    ).not.toThrow();
    configError(
      () => betterCompute({ ...good, iam: { ...iam, rootTenantId: 'tenant-elsewhere' } }),
      /name different tenants/,
    );
    configError(() => betterCompute({ ...good, typePrefix: 'Bad_' }), /prefix/);
    configError(
      () => betterCompute({ ...good, acceptIamCookie: 'yes' as never }),
      /acceptIamCookie/,
    );
    configError(
      () => betterCompute({ ...good, database: { query() {} } as never }),
      /database must implement transaction/,
    );
    configError(
      () => betterCompute({ ...good, iam: { ...iam, authorize: undefined } as never }),
      /iam must implement authorize/,
    );
    configError(() => betterCompute(undefined as never), /options object/);
  });
});

describe('initialize()', () => {
  it('fails when a declared action is missing from the merged catalog, before touching the store', async () => {
    const beta = definePlugin({
      id: 'beta',
      catalog: { actions: ['compute:beta:other'] },
      api: () => ({ things: { look: read('compute:beta:look', onNode) } }),
    });
    const { compute, database } = setupWith({ plugins: [beta] });
    const error = await failure(() => compute.initialize());
    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message).toMatch(
      /compute:beta:look, which is missing from the merged IAM catalog/,
    );
    expect(error.details?.problems).toEqual([
      expect.objectContaining({ kind: 'uncatalogued', path: 'plugins/beta/things/look' }),
    ]);
    expect(database.log).toEqual([]);
  });

  it('fails when a method disagrees with its §9.2 row on action, kind or resource', async () => {
    // workflows.abort (v0.2, module provision) is not registered by the server itself.
    const cases: [MethodDefinition, RegExp][] = [
      [read('compute:nodes:read', onNode, 'mutation'), /declares compute:nodes:read \(mutation\)/],
      [
        read('compute:workflows:manage', onNode, 'read'),
        /\(read\); §9.2 says compute:workflows:manage \(mutation\)/,
      ],
      [
        read(
          'compute:workflows:manage',
          (input) => ({ type: 'pool', id: input.poolId ?? 'p' }),
          'mutation',
        ),
        /workflows\/abort decides on pool; §9.2 says node/,
      ],
    ];
    for (const [method, pattern] of cases) {
      const wrong = defineModule({ name: 'wrong', api: () => ({ workflows: { abort: method } }) });
      const { compute, database } = setupWith({ modules: [wrong] });
      const error = await failure(() => compute.initialize());
      expect(error.code).toBe('INVALID_CONFIG');
      expect(error.message).toMatch(pattern);
      expect(database.log).not.toContain('migrate');
    }
  });

  it('accepts methods that match §9.2 and reports (but allows) undeclared ones', async () => {
    const module = defineModule({
      name: 'extras',
      api: () => ({
        workflows: { abort: read('compute:workflows:manage', onNode, 'mutation') },
        // Alternatives count: images.register decides on tenant or fleet.
        images: {
          register: read(
            'compute:images:publish',
            (input) => ({ type: 'fleet', id: input.tenantId ?? 'global' }),
            'mutation',
          ),
        },
        gadgets: { list: read('compute:nodes:read', onNode) },
      }),
    });
    const { compute } = setupWith({ modules: [module] });
    await compute.initialize();
    expect(compute.registry.problems()).toEqual([
      expect.objectContaining({ kind: 'undeclared', path: 'gadgets/list' }),
    ]);
  });

  it('migrates the base schema and the module and plugin migrations, once', async () => {
    const { compute, database } = setup();
    await Promise.all([compute.initialize(), compute.initialize()]);
    await compute.initialize();
    expect(database.log.filter((entry) => entry === 'migrate')).toHaveLength(1);
    const { rows } = await db.query<{ name: string }>(
      'SELECT name FROM compute_migrations ORDER BY name',
    );
    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(['core/0001_clock', 'acme/0001_widgets']),
    );
  });

  it('can be retried after a failure', async () => {
    let fail = true;
    const flaky = spyExecutor(db);
    const iam = fakeIam();
    const compute = betterCompute({
      ...options(
        {
          ...flaky,
          migrate: (extra) =>
            fail ? Promise.reject(new Error('database is starting up')) : flaky.migrate(extra),
        },
        iam,
      ),
    });
    await expect(compute.initialize()).rejects.toThrow('database is starting up');
    fail = false;
    await compute.initialize();
  });
});

describe('the operation envelope', () => {
  const input = { tenantId: ACME, nodeId: NODE_ID };

  beforeAll(async () => {
    await setup().compute.initialize();
  });

  it('refuses a call without a credential before IAM', async () => {
    const { compute, iam, database } = setup();
    for (const credential of [{}, { token: '' }, { headers: { 'x-request-id': 'r-1' } }]) {
      const error = await failure(() => compute.api.inventory.get(credential, input));
      expect(error.code).toBe('UNAUTHENTICATED');
      expect(error.status).toBe(401);
    }
    expect(iam.calls).toEqual([]);
    expect(database.log).toEqual([]);
  });

  it('validates the input before authenticating', async () => {
    const { compute, iam } = setup();
    const error = await failure(() =>
      compute.api.inventory.get({ token: USER }, { tenantId: ACME, nodeId: 'not-a-node' }),
    );
    expect(error.code).toBe('INVALID_INPUT');
    const unknown = await failure(() =>
      compute.api.inventory.get({ token: USER }, { ...input, extra: 1 } as never),
    );
    expect(unknown.message).toMatch(/Unknown field extra/);
    expect(iam.calls).toEqual([]);
  });

  it('refuses callers outside the tenant with no database access and no decision', async () => {
    const { compute, iam, database } = setup();
    iam.allow(); // IAM would allow everything: the refusal must come from the pre-check.
    const read = await failure(() => compute.api.inventory.get({ token: OUTSIDER }, input));
    const write = await failure(() =>
      compute.api.plugins.acme.widgets.poke(
        { token: OUTSIDER },
        { tenantId: ACME, widgetId: 'w-outsider' },
      ),
    );
    for (const error of [read, write]) {
      expect(error.code).toBe('ACCESS_DENIED');
      expect(error.status).toBe(403);
    }
    // One authentication: the second call finds it in the 30 s cache.
    expect(iam.calls.map((call) => call.method)).toEqual(['authenticate']);
    expect(database.log).toEqual([]);

    // Identical to IAM's own denial inside the tenant: nothing tells the two apart.
    const denied = setup();
    const inside = await failure(() => denied.compute.api.inventory.get({ token: USER }, input));
    expect({ code: inside.code, message: inside.message, status: inside.status }).toEqual({
      code: read.code,
      message: read.message,
      status: read.status,
    });
  });

  it('lets root callers through the pre-check for IAM to decide in the target tenant', async () => {
    const { compute, iam } = setup();
    iam.allow({ token: ADMIN });
    // Allowed, the handler runs: the node has no inventory in this store.
    const error = await failure(() => compute.api.inventory.get({ token: ADMIN }, input));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
    expect(iam.calls.map((call) => call.method)).toEqual(['authenticate', 'authorize']);
    expect(iam.calls[1]!.decision).toEqual({
      tenantId: ACME,
      action: 'compute:nodes:read',
      resource: { type: 'compute-node', id: NODE_ID },
    });
  });

  it('decides a read exactly once with authorize, and runs it in a read-only transaction', async () => {
    const { compute, iam, database } = await primed(setup());
    iam.allow({ token: USER, action: 'compute:acme:read' });
    expect(
      await compute.api.plugins.acme.widgets.get(
        { token: USER },
        { tenantId: ACME, widgetId: 'w-none' },
      ),
    ).toEqual({ widgetId: 'w-none', exists: false });
    expect(iam.calls.map((call) => call.method)).toEqual(['authenticate', 'authorize']);
    expect(iam.calls[1]!.decision).toEqual({
      tenantId: ACME,
      action: 'compute:acme:read',
      resource: { type: 'compute-tenant', id: ACME },
    });
    expect(database.log).toEqual(['transaction']);

    const writer = definePlugin({
      id: 'writer',
      catalog: { actions: ['compute:writer:read'] },
      api: () => ({
        sneaky: {
          write: defineMethod<{ tenantId: string }, void>({
            action: 'compute:writer:read',
            kind: 'read',
            resource: (value) => ({ type: 'tenant', id: value.tenantId }),
            validate: (value) => value as { tenantId: string },
            async handler(context) {
              await context.sql.query("INSERT INTO plg_acme_widgets VALUES ('w-sneaky', 'x')");
            },
          }),
        },
      }),
    });
    const other = harness();
    other.iam.allow();
    const withWriter = betterCompute({
      ...options(other.database, other.iam),
      plugins: [acme, writer],
    });
    await expect(
      withWriter.api.plugins.writer.sneaky.write({ token: USER }, { tenantId: ACME }),
    ).rejects.toThrow(/read-only transaction/);
  });

  it('opens no transaction when a read is denied', async () => {
    const { compute, iam, database } = await primed(setup());
    const error = await failure(() =>
      compute.api.plugins.acme.widgets.get({ token: USER }, { tenantId: ACME, widgetId: 'w-1' }),
    );
    expect(error.code).toBe('ACCESS_DENIED');
    expect(iam.count('authorize')).toBe(1);
    expect(database.log).toEqual([]);
  });

  it('decides a mutation exactly once with require and audits it with the admission context', async () => {
    const { compute, iam } = setup();
    iam.allow({ token: USER, action: 'compute:acme:poke', tenantId: ACME });
    const result = await compute.api.plugins.acme.widgets.poke(
      { token: USER },
      { tenantId: ACME, widgetId: 'w-audited' },
    );
    expect(result.poked).toBe('w-audited');
    expect(iam.calls.map((call) => call.method)).toEqual(['authenticate', 'require']);
    const admission = {
      tenantId: ACME,
      identityId: 'id-user',
      identityKind: 'user',
      sessionId: 'ses-user',
      sessionKind: 'user',
      action: 'compute:acme:poke',
      resource: { type: 'compute-tenant', id: ACME },
      requestId: expect.stringMatching(/^req_/),
      decidedAt: expect.any(Number),
    };
    expect(result.admission).toEqual(admission);
    const { rows } = await db.query<{
      tenant_id: string;
      action: string;
      resource_type: string;
      resource_id: string;
      admission: unknown;
      occurred_at: Date;
    }>(
      `SELECT tenant_id, action, resource_type, resource_id, admission, occurred_at
         FROM audit_events WHERE admission->>'requestId' = $1`,
      [result.admission!.requestId],
    );
    expect(rows).toEqual([
      {
        tenant_id: ACME,
        action: 'compute:acme:poke',
        resource_type: 'compute-tenant',
        resource_id: ACME,
        admission,
        occurred_at: expect.any(Date),
      },
    ]);
  });

  it('rolls back a failing mutation together with its audit row', async () => {
    const { compute, iam } = setup();
    iam.allow({ token: USER });
    const count = async () =>
      Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM audit_events')).rows[0]!.n);
    const before = await count();
    const error = await failure(() =>
      compute.api.plugins.acme.widgets.fail(
        { token: USER },
        { tenantId: ACME, widgetId: 'w-lost' },
      ),
    );
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toEqual({ widgetId: 'w-lost' });
    expect(iam.count('require')).toBe(1);
    expect(await count()).toBe(before);
    const { rowCount } = await db.query("SELECT 1 FROM plg_acme_widgets WHERE id = 'w-lost'");
    expect(rowCount).toBe(0);
  });

  it('writes nothing when a mutation is denied', async () => {
    const { compute, iam, database } = await primed(setup());
    iam.allow({ token: USER });
    iam.deny({ action: 'compute:acme:poke' });
    const error = await failure(() =>
      compute.api.plugins.acme.widgets.poke({ token: USER }, { tenantId: ACME, widgetId: 'w-no' }),
    );
    expect(error.code).toBe('ACCESS_DENIED');
    expect(iam.count('require')).toBe(1);
    expect(iam.count('authorize')).toBe(0);
    expect(database.log).toEqual([]);
  });

  it('runs public methods without authentication', async () => {
    const { compute, iam, database } = setup();
    expect((await compute.api.system.version({ token: 'garbage' })).name).toBe('better-compute');
    expect(await compute.api.system.whoami()).toEqual({ authenticated: false });
    expect(iam.calls).toEqual([]);
    expect(await compute.api.system.whoami({ token: USER })).toEqual({
      authenticated: true,
      identityId: 'id-user',
      identityKind: 'user',
      tenantId: ACME,
      sessionKind: 'user',
      mfa: false,
    });
    expect(iam.calls.map((call) => call.method)).toEqual(['authenticate']);
    expect((await failure(() => compute.api.system.whoami({ token: 'unknown' }))).code).toBe(
      'UNAUTHENTICATED',
    );
    expect((await failure(() => compute.api.system.version({}, { x: 1 } as never))).code).toBe(
      'INVALID_INPUT',
    );
    expect(database.log).toEqual([]);
  });

  it('decides system.selfCheck on compute-fleet/global in the root tenant', async () => {
    const { compute, iam } = setup();
    iam.allow({
      action: 'compute:fleet:admin',
      tenantId: ROOT,
      type: 'compute-fleet',
      id: 'global',
    });
    const refused = await failure(() => compute.api.system.selfCheck({ token: USER }));
    expect(refused.code).toBe('ACCESS_DENIED');
    expect(iam.count('authorize')).toBe(0);
    const report = await compute.api.system.selfCheck({ token: ADMIN });
    expect(report.ok).toBe(true);
    expect(iam.calls.at(-1)!.decision).toEqual({
      tenantId: ROOT,
      action: 'compute:fleet:admin',
      resource: { type: 'compute-fleet', id: 'global' },
    });
  });

  it('builds IAM resource types from typePrefix', async () => {
    const iam = fakeIam();
    iam.addCaller(USER, { tenantId: ACME });
    const compute = betterCompute({ ...options(db, iam), typePrefix: 'gpu-' });
    await failure(() => compute.api.inventory.get({ token: USER }, input));
    expect(iam.calls[1]!.decision!.resource).toEqual({ type: 'gpu-node', id: NODE_ID });
  });

  it('drops the IAM cookie unless acceptIamCookie', async () => {
    const cookie = { headers: { cookie: `better-iam.session=${USER}` } };
    const ignoring = setup();
    expect(await ignoring.compute.api.system.whoami(cookie)).toEqual({ authenticated: false });
    expect(ignoring.iam.calls).toEqual([]);

    const iam = fakeIam();
    iam.addCaller(USER, { tenantId: ACME });
    const accepting = betterCompute({ ...options(db, iam), acceptIamCookie: true });
    expect(await accepting.api.system.whoami(cookie)).toMatchObject({ authenticated: true });
  });
});

describe('selfCheck()', () => {
  it('reports a migrated store as healthy', async () => {
    const { compute } = setup();
    await compute.initialize();
    const report = await compute.selfCheck();
    expect(report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('reports a store that was never migrated', async () => {
    const fresh = pglite();
    try {
      const compute = betterCompute(options(fresh, fakeIam()));
      const report = await compute.selfCheck();
      expect(report.ok).toBe(false);
      expect(report.findings).toContainEqual(
        expect.objectContaining({ check: 'migrations', severity: 'error' }),
      );
    } finally {
      await fresh.close();
    }
  });

  it('reports missing module migrations and the sim clock', async () => {
    const late = defineModule({
      name: 'late',
      migrations: [{ name: 'late/0001_table', sql: 'CREATE TABLE late_things (id text)' }],
    });
    const { compute } = setupWith({ modules: [late] });
    const before = await compute.selfCheck();
    expect(before.findings).toContainEqual(
      expect.objectContaining({
        check: 'migrations',
        message: 'Migrations not applied: late/0001_table',
      }),
    );
    await useSimClock(db, Date.UTC(2030, 0, 1));
    try {
      const report = await compute.selfCheck();
      expect(report.findings).toContainEqual(
        expect.objectContaining({ check: 'clock', severity: 'info' }),
      );
    } finally {
      await restoreSystemClock(db);
    }
  });

  it('reports registry problems and module findings', async () => {
    const noisy = defineModule({
      name: 'noisy',
      api: () => ({ gadgets: { list: read('compute:nodes:read', onNode) } }),
      selfCheck: async () => [
        { check: 'noisy.fans', severity: 'warning', message: 'Fans are loud', fix: 'Oil them' },
      ],
    });
    const broken = defineModule({
      name: 'broken',
      selfCheck: async () => {
        throw new Error('sensor offline');
      },
    });
    const { compute } = setupWith({ modules: [noisy, broken] });
    await compute.initialize();
    const report = await compute.selfCheck();
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: 'catalog.undeclared', severity: 'warning' }),
        expect.objectContaining({ check: 'noisy.fans' }),
        expect.objectContaining({
          check: 'module.broken',
          severity: 'error',
          message: 'The selfCheck of module broken failed: sensor offline',
        }),
      ]),
    );
    expect(report.ok).toBe(false);
  });
});

describe('lifecycle and later-phase placeholders', () => {
  it('starts only after initialize(), with known roles; jobs are the runtime passes', async () => {
    const { compute } = setup();
    expect((await failure(() => compute.start())).code).toBe('INVALID_STATE');
    await compute.initialize();
    expect((await failure(() => compute.start({ roles: ['gateway' as never] }))).code).toBe(
      'INVALID_CONFIG',
    );
    await compute.start({ roles: ['controllers', 'iam'] });
    await compute.start();
    await compute.stop();
    // Every reconciler by name, plus the runtime's own singleton passes (tests/server-runtime-*).
    expect(Object.keys(compute.jobs)).toEqual(
      expect.arrayContaining([
        'inventory',
        'command-sweeper',
        'outbox-dispatch',
        'event-subscribers',
      ]),
    );
  });

  it('answers NOT_IMPLEMENTED for gateway services and the authz projection', async () => {
    const { compute } = setup();
    // JoinService is wired (tests/server-join); without pki.join it refuses as misconfigured.
    expect((await failure(() => compute.gatewayServices.join({} as never))).code).toBe(
      'INVALID_CONFIG',
    );
    // The secret broker runs over the default sealed store (tests/server-secret-broker); an
    // unsigned request is refused in the answer, never with a value.
    const refused = await compute.gatewayServices.secret({} as never);
    expect(refused.error).toBeTruthy();
    expect(refused.jwe ?? '').toBe('');
    // The authz projection reads authz_projection by primary key (tests/server-runtime-authz).
    await compute.initialize();
    expect(await compute.authz.get('compute-pool', 'p', ACME)).toBeUndefined();
  });

  it('describes its endpoint and version', () => {
    const { compute } = setup();
    expect(compute.endpoint).toEqual({
      origin: new URL(BASE_URL).origin,
      basePath: '/api/compute',
      secure: true,
    });
    const manifest = JSON.parse(
      readFileSync(new URL('../packages/server/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(serverVersion).toBe(manifest.version);
    expect(validateNoInput(undefined)).toEqual({});
  });
});
