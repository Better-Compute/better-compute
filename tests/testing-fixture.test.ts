import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  defineMethod,
  definePlugin,
  field,
  isComputeError,
  manifest,
  type SqlExecutor,
} from '@better-compute/core';
import { serverVersion } from '@better-compute/server';
import {
  closeFixtures,
  computeFixture,
  fakeIam,
  tokenOf,
  type FixtureResponse,
} from '@better-compute/testing';

// computeFixture() (PLAN.md §15): PGlite migrated by initialize(), the sim clock bound to
// compute_now(), the scripted IAM with the root tenant and two organizations, request() through
// compute.handler, and closeFixtures().

afterEach(closeFixtures);

const START = Date.UTC(2026, 0, 1);

const tenantInput = manifest({ tenantId: field.string({ pattern: '^[A-Za-z0-9._:-]{1,128}$' }) });

/** Plugin `clockwork`: `ticks.record` answers both clocks, and its audit row records a third. */
const clockwork = definePlugin({
  id: 'clockwork',
  catalog: { actions: ['compute:clockwork:tick'] },
  api: () => ({
    ticks: {
      record: defineMethod<{ tenantId: string }, { sql: number; clock: number }>({
        action: 'compute:clockwork:tick',
        kind: 'mutation',
        resource: (input) => ({ type: 'tenant', id: input.tenantId }),
        validate: (input) => tenantInput.parse(input),
        async handler(context) {
          const { rows } = await context.sql.query<{ now: Date }>('SELECT compute_now() AS now');
          return { sql: rows[0]!.now.getTime(), clock: context.clock.now() };
        },
      }),
    },
  }),
});

async function computeNow(database: SqlExecutor): Promise<number> {
  const { rows } = await database.query<{ now: Date }>('SELECT compute_now() AS now');
  return rows[0]!.now.getTime();
}

async function rejection(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isComputeError(error)) throw new Error(`expected a ComputeError, got ${String(error)}`);
  return error;
}

function failed<T>(response: FixtureResponse<T>) {
  if (response.ok) throw new Error(`expected an error, got ${JSON.stringify(response.data)}`);
  return { status: response.status, code: response.error.code, message: response.error.message };
}

describe('computeFixture', () => {
  it('boots an initialized control plane on a migrated PGlite store', async () => {
    const { compute, database } = await computeFixture();
    expect(database.kind).toBe('pglite');
    const { rows } = await database.query<{ name: string }>(
      'SELECT name FROM compute_migrations ORDER BY name',
    );
    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(['core/0001_clock', 'core/0002_base']),
    );
    const report = await compute.selfCheck();
    expect(report.findings.filter((finding) => finding.severity !== 'info')).toEqual([]);
    expect(report.ok).toBe(true);
    await expect(compute.start()).resolves.toBeUndefined();
  });

  it('knows the root tenant and two organizations, one person each', async () => {
    const { tenants, iam } = await computeFixture();
    expect(Object.keys(tenants)).toEqual(['root', 'acme', 'other']);
    expect(new Set(Object.values(tenants).map((tenant) => tenant.id)).size).toBe(3);
    for (const tenant of Object.values(tenants)) {
      expect(tenant.caller.tenantId).toBe(tenant.id);
      await expect(iam.authenticate({ token: tenant.token })).resolves.toEqual(tenant.caller);
    }
    expect(tenants.root.caller.mfa).toBe(true);
    expect(tenants.acme.caller.mfa).toBe(false);
  });

  it('rejects options it cannot honour', async () => {
    for (const options of [
      { clock: 'lunar' as never },
      { start: -1 },
      { start: 1.5 },
      { start: Number.NaN },
    ]) {
      const error = await rejection(computeFixture(options));
      expect(error.code).toBe('INVALID_CONFIG');
    }
  });

  it('closes the store when the control plane fails to initialize', async () => {
    const uncatalogued = definePlugin({
      id: 'broken',
      api: () => ({
        things: {
          get: defineMethod<{ tenantId: string }, null>({
            action: 'compute:broken:read',
            kind: 'read',
            resource: (input) => ({ type: 'tenant', id: input.tenantId }),
            validate: (input) => tenantInput.parse(input),
            handler: async () => null,
          }),
        },
      }),
    });
    const error = await rejection(computeFixture({ plugins: [uncatalogued] }));
    expect(error.code).toBe('INVALID_CONFIG');
    await expect(closeFixtures()).resolves.toBeUndefined();
  });
});

describe('the sim clock', () => {
  it('starts compute_now() and the Clock at 2026-01-01 and moves them together', async () => {
    const { clock, advance, database } = await computeFixture();
    expect(clock.mode).toBe('sim');
    expect(clock.now()).toBe(START);
    expect(await computeNow(database)).toBe(START);

    expect(await advance(90_000)).toBe(START + 90_000);
    expect(clock.now()).toBe(START + 90_000);
    expect(await computeNow(database)).toBe(START + 90_000);

    await clock.set(START + 3_600_000);
    expect(clock.now()).toBe(START + 3_600_000);
    expect(await computeNow(database)).toBe(START + 3_600_000);
  });

  it('starts where it is told', async () => {
    const start = Date.UTC(2030, 5, 1, 12);
    const { clock, database } = await computeFixture({ start });
    expect(clock.now()).toBe(start);
    expect(await computeNow(database)).toBe(start);
  });

  it('reaches handlers, column defaults and the admission context', async () => {
    const { request, advance, iam, tenants, database } = await computeFixture({
      plugins: [clockwork],
    });
    iam.allow({ token: tenants.acme.token, action: 'compute:clockwork:tick' });
    const tick = () =>
      request<{ sql: number; clock: number }>(
        'ticks',
        'record',
        { tenantId: tenants.acme.id },
        { token: tenants.acme.token, plugin: 'clockwork' },
      );

    expect(await tick()).toMatchObject({ ok: true, data: { sql: START, clock: START } });
    await advance(7_200_000);
    const later = START + 7_200_000;
    expect(await tick()).toMatchObject({ ok: true, data: { sql: later, clock: later } });

    const { rows } = await database.query<{ occurred_at: Date; admission: { decidedAt: number } }>(
      'SELECT occurred_at, admission FROM audit_events ORDER BY occurred_at',
    );
    expect(rows.map((row) => row.occurred_at.getTime())).toEqual([START, later]);
    expect(rows.map((row) => row.admission.decidedAt)).toEqual([START, later]);
  });

  it('never moves backwards, and a refused move changes neither clock', async () => {
    const { clock, advance, database } = await computeFixture();
    await advance(1_000);
    for (const attempt of [
      () => clock.set(START),
      () => advance(-1),
      () => advance(0.5),
      () => advance(Number.POSITIVE_INFINITY),
    ]) {
      const error = await rejection(attempt());
      expect(error.code).toBe('INVALID_INPUT');
    }
    expect(clock.now()).toBe(START + 1_000);
    expect(await computeNow(database)).toBe(START + 1_000);
  });

  it('applies concurrent moves one at a time', async () => {
    const { clock, advance, database } = await computeFixture();
    const reached = await Promise.all([advance(1_000), advance(2_000), advance(3_000)]);
    expect(reached).toEqual([START + 1_000, START + 3_000, START + 6_000]);
    expect(clock.now()).toBe(START + 6_000);
    expect(await computeNow(database)).toBe(START + 6_000);
  });

  it("leaves compute_now() on the database clock with clock: 'system'", async () => {
    const { clock, advance, compute, database } = await computeFixture({ clock: 'system' });
    expect(clock.mode).toBe('system');
    const before = Date.now();
    const sql = await computeNow(database);
    expect(Math.abs(sql - before)).toBeLessThan(60_000);
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(1_000);
    expect((await rejection(advance(1_000))).code).toBe('INVALID_STATE');
    expect((await rejection(clock.set(Date.now() + 1_000))).code).toBe('INVALID_STATE');
    const report = await compute.selfCheck();
    expect(report.findings.filter((finding) => finding.check === 'clock')).toEqual([]);
  });
});

describe('request()', () => {
  it('answers system.version through compute.handler', async () => {
    const { request, iam } = await computeFixture();
    const response = await request('system', 'version');
    expect(response).toMatchObject({
      ok: true,
      status: 200,
      data: {
        name: 'better-compute',
        version: serverVersion,
        basePath: '/api/compute',
        protocol: { min: 1, max: 1 },
      },
    });
    expect(response.requestId).toMatch(/^req_/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(iam.calls).toEqual([]);
  });

  it('sends the bearer token and extra headers', async () => {
    const { request, iam, tenants } = await computeFixture();
    const whoami = await request(
      'system',
      'whoami',
      {},
      { token: tenants.acme.token, headers: { 'x-request-id': 'fixture-request-1' } },
    );
    expect(whoami).toMatchObject({
      ok: true,
      requestId: 'fixture-request-1',
      data: { authenticated: true, identityId: 'identity-acme', tenantId: tenants.acme.id },
    });
    expect(iam.calls.map((call) => [call.method, call.token])).toEqual([
      ['authenticate', tenants.acme.token],
    ]);

    const csrf = await request('system', 'version', {}, { headers: { 'x-better-compute': '0' } });
    expect(failed(csrf)).toMatchObject({ status: 403, code: 'CSRF_REJECTED' });
  });

  it('goes through the envelope: authentication, tenant pre-check, decision, handler', async () => {
    const { request, iam, tenants } = await computeFixture();
    const input = { tenantId: tenants.acme.id, nodeId: 'node_01jz0000000000000000000000' };
    const get = (token?: string) =>
      request('inventory', 'get', input, token === undefined ? {} : { token });

    expect(failed(await get())).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(failed(await get(tenants.other.token))).toMatchObject({
      status: 403,
      code: 'ACCESS_DENIED',
    });
    expect(iam.count('authorize')).toBe(0);
    expect(failed(await get(tenants.acme.token))).toMatchObject({
      status: 403,
      code: 'ACCESS_DENIED',
    });
    expect(iam.count('authorize')).toBe(1);

    iam.allow({ token: tenants.acme.token, action: 'compute:nodes:read' });
    expect(failed(await get(tenants.acme.token))).toEqual({
      status: 501,
      code: 'NOT_IMPLEMENTED',
      message: 'inventory.get arrives in v0.1',
    });
    expect(iam.calls.at(-1)?.decision).toEqual({
      tenantId: tenants.acme.id,
      action: 'compute:nodes:read',
      resource: { type: 'compute-node', id: input.nodeId },
    });
  });

  it('takes allow rules and extra callers up front', async () => {
    const { request, tenants } = await computeFixture({
      iam: { allow: [{}], callers: { 'token-extra-0123456789': { tenantId: 'tenant-acme' } } },
    });
    const input = { tenantId: tenants.acme.id, nodeId: 'node_01jz0000000000000000000000' };
    for (const token of [tenants.acme.token, 'token-extra-0123456789'])
      expect(failed(await request('inventory', 'get', input, { token }))).toMatchObject({
        code: 'NOT_IMPLEMENTED',
      });
  });

  it('routes plugin methods, typed through compute.api as well', async () => {
    const { request, compute, iam, tenants } = await computeFixture({ plugins: [clockwork] });
    iam.allow({ action: 'compute:clockwork:tick' });
    const over = await request(
      'ticks',
      'record',
      { tenantId: tenants.acme.id },
      { token: tenants.acme.token, plugin: 'clockwork' },
    );
    expect(over).toMatchObject({ ok: true, status: 200, data: { sql: START } });

    const direct = await compute.api.plugins.clockwork.ticks.record(
      { token: tenants.acme.token },
      { tenantId: tenants.acme.id },
    );
    expectTypeOf(direct).toEqualTypeOf<{ sql: number; clock: number }>();
    expect(direct).toEqual({ sql: START, clock: START });
  });
});

describe('closeFixtures', () => {
  it('closes every open fixture, once', async () => {
    const first = await computeFixture();
    const second = await computeFixture({ clock: 'system' });
    await second.close();
    await second.close();
    await closeFixtures();
    for (const { database } of [first, second])
      await expect(database.query('SELECT 1')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    await expect(first.close()).resolves.toBeUndefined();
    await expect(closeFixtures()).resolves.toBeUndefined();
  });
});

describe('fakeIam', () => {
  it('authenticates known tokens from any credential shape', async () => {
    const iam = fakeIam({ callers: { 'token-a-0123456789': { tenantId: 'tenant-a' } } });
    const caller = await iam.authenticate({
      headers: { authorization: 'Bearer token-a-0123456789' },
    });
    expect(caller).toMatchObject({ tenantId: 'tenant-a', identityKind: 'user', mfa: false });
    expect(
      tokenOf({ headers: { cookie: 'theme=dark; better-iam.session=token-a-0123456789' } }),
    ).toBe('token-a-0123456789');
    expect(tokenOf({ token: 'token-a-0123456789' })).toBe('token-a-0123456789');
    expect((await rejection(iam.authenticate({ token: 'nobody' }))).code).toBe('UNAUTHENTICATED');
    expect(iam.count('authenticate')).toBe(2);
    iam.reset();
    expect(iam.calls).toEqual([]);
  });

  it('allows only what a rule allows, and deny wins', async () => {
    const token = 'token-a-0123456789';
    const iam = fakeIam({
      callers: { [token]: { tenantId: 'tenant-a' } },
      allow: [{ tenantId: 'tenant-a' }],
      deny: [{ action: 'compute:nodes:delete' }],
    });
    const decision = (action: string, tenantId = 'tenant-a') => ({
      tenantId,
      action,
      resource: { type: 'compute-node', id: 'node_1' },
    });
    expect(await iam.authorize({ token }, decision('compute:nodes:read'))).toBe(true);
    expect(await iam.authorize({ token }, decision('compute:nodes:read', 'tenant-b'))).toBe(false);
    expect((await rejection(iam.require({ token }, decision('compute:nodes:delete')))).code).toBe(
      'ACCESS_DENIED',
    );
    expect(
      await iam.authorizeMany({ token }, 'tenant-a', [
        { action: 'compute:nodes:read', resource: { type: 'compute-node', id: 'node_1' } },
        { action: 'compute:nodes:delete', resource: { type: 'compute-node', id: 'node_1' } },
      ]),
    ).toEqual([true, false]);
    expect(iam.calls.map((call) => call.method)).toEqual([
      'authorize',
      'authorize',
      'require',
      'authorizeMany',
    ]);
  });
});
