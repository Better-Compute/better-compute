import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { manualClock, type Credential, type SqlExecutor } from '@better-compute/core';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { vps } from '@better-compute/vps';

// Root's cross-tenant usage view (Task 22, D17) and the corrections root makes to it (Task 23, D17/D18): dead
// letters, retry and void. Everything runs against a REAL better-iam (embedded, with compute's plugin and resolver,
// as tests/vps-pricing.test.ts does): the root administrator is let through by ROOT_OVERRIDE, a tenant
// administrator is turned away before any IAM decision, and a root-tenant member holds only what its policy grants
// on the fleet.

let t: EmbeddedTestIam;
let compute: BetterCompute<any, any>;
let database: SqlExecutor;
let api: any;
let root: Credential;
let R: string;
let A: string;
let B: string;
let acmeAdmin: Credential;
let reader: Credential;
let otherOwner: Credential;

const HOUR = 3_600_000;
const clock = manualClock(Math.floor(Date.now() / 1000) * 1000);
/** The first of the test's hours, five hours before the (frozen) clock: all of them have ended. */
const H0 = Math.floor(clock.now() / HOUR) * HOUR - 5 * HOUR;
/** Rows in a fixed order, whatever the tenant ids sort like. */
const sorted = (rows: { keys: Record<string, string> }[]) =>
  [...rows].sort((a, b) => JSON.stringify(a.keys).localeCompare(JSON.stringify(b.keys)));
const outcome = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'allowed',
    (error: { code?: string }) => error?.code ?? String(error),
  );
const failure = (promise: Promise<unknown>): Promise<{ code?: string; message: string }> =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error) => error,
  );

interface Seed {
  tenant: string;
  kind: 'instance' | 'grant' | 'network' | 'snapshot' | 'cost';
  id: string;
  meter: string;
  quantity: number;
  /** The hour, counted from H0. */
  hour: number;
  tags?: Record<string, string>;
  outcome?: 'recorded' | 'duplicate' | 'reattributed' | 'dead-lettered';
  voided?: boolean;
  identityId?: string;
  /** Overrides the window start (ms), for windows outside the test hours. */
  at?: number;
}
/** One source window, keyed as the sources do (`cmp:<kind>:<id>:<windowStartMs>:<meter>`). */
async function seed(window: Seed): Promise<string> {
  const start = window.at ?? H0 + window.hour * HOUR;
  const key = `cmp:${window.kind}:${window.id}:${start}:${window.meter}`;
  await database.query(
    `INSERT INTO usage_windows (idempotency_key, allocation_id, tenant_id, identity_id, meter, quantity,
                                window_start, window_end, tags, source_kind, source_id,
                                recorded_at, outcome, voided_at, void_reason)
     VALUES ($1, NULL, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::jsonb, $9, $10,
             CASE WHEN $11::text IS NULL THEN NULL ELSE compute_now() END, $11,
             CASE WHEN $12::bool THEN compute_now() END, CASE WHEN $12::bool THEN 'seeded' END)`,
    [
      key,
      window.tenant,
      window.identityId ?? null,
      window.meter,
      window.quantity,
      new Date(start).toISOString(),
      new Date(start + HOUR).toISOString(),
      JSON.stringify(window.tags ?? {}),
      window.kind,
      window.id,
      window.outcome ?? null,
      window.voided ?? false,
    ],
  );
  return key;
}

beforeAll(async () => {
  t = await createEmbeddedTestIam({ now: () => Date.now() });
  database = pglite();
  compute = betterCompute({
    database,
    iam: t.port,
    secret: 'better-compute-usage-platform-secret-0123456789',
    baseURL: 'http://127.0.0.1:3000',
    clock,
    modules: [...t.bridge.modules, vps()],
  } as any);
  await compute.initialize();
  await useSimClock(database, clock.now());
  api = compute.api;
  root = t.root.credential;
  R = t.root.tenantId;
  A = t.acme.tenantId;
  B = t.other.tenantId;

  const admin = await t.acme.member('admin');
  await t.acme.grant(admin.identityId, {
    version: 1,
    statements: [{ effect: 'allow', actions: ['compute:*'], resources: ['*'] }],
  });
  acmeAdmin = await t.acme.signIn('admin');
  otherOwner = t.other.owner;

  // A member of the root tenant that holds `compute:billing:read` on the fleet, and nothing about usage.
  const member = await t.iam.api.identities.create(root, {
    tenantId: R,
    email: 'biller@root.test',
    name: 'Biller',
    password: 'a strong root biller password',
  });
  const policy = await t.iam.api.policies.create(root, {
    tenantId: R,
    name: 'billing-read',
    document: {
      version: 1,
      statements: [
        { effect: 'allow', actions: ['compute:billing:read'], resources: ['compute-fleet/global'] },
      ],
    },
  });
  const role = await t.iam.api.roles.create(root, {
    tenantId: R,
    name: 'billing-read',
    policyIds: [policy.id],
  });
  await t.iam.api.bindings.create(root, {
    tenantId: R,
    roleId: role.id,
    subjectType: 'identity',
    subjectId: member.id,
  });
  const signedIn = await t.iam.api.auth.signIn({
    tenantId: R,
    email: 'biller@root.test',
    password: 'a strong root biller password',
  });
  if (!('token' in signedIn)) throw new Error('Unexpected MFA for a root member');
  reader = { token: signedIn.token };
}, 120_000);

afterAll(async () => {
  await compute?.stop();
  await t?.close();
  await database?.close();
});

describe('usage.platform', () => {
  beforeEach(async () => {
    await database.query('DELETE FROM usage_windows');
  });

  /** Two tenants, three sources, a pending and a recorded window, and one voided window. */
  async function fleet(): Promise<void> {
    const gce = { provider: 'gcp', pool: 'pool-gce', region: 'us-central1' };
    await seed({
      tenant: A,
      kind: 'instance',
      id: 'vm_1',
      meter: 'vm.vcpu.hours',
      quantity: 8,
      hour: 0,
      tags: gce,
      outcome: 'recorded',
    });
    await seed({
      tenant: A,
      kind: 'instance',
      id: 'vm_1',
      meter: 'vm.vcpu.hours',
      quantity: 8,
      hour: 1,
      tags: gce,
    });
    await seed({
      tenant: A,
      kind: 'instance',
      id: 'vm_1',
      meter: 'vm.memory.gib.hours',
      quantity: 32,
      hour: 0,
      tags: gce,
      outcome: 'recorded',
    });
    await seed({
      tenant: A,
      kind: 'network',
      id: 'net_1',
      meter: 'net.egress.gib',
      quantity: 3,
      hour: 1,
      tags: { provider: 'gcp' },
      outcome: 'dead-lettered',
    });
    await seed({
      tenant: B,
      kind: 'instance',
      id: 'vm_2',
      meter: 'vm.vcpu.hours',
      quantity: 4,
      hour: 0,
      tags: { provider: 'aws', pool: 'pool-aws' },
      outcome: 'recorded',
    });
    await seed({
      tenant: B,
      kind: 'grant',
      id: 'grant_1',
      meter: 'vm.reserved.vcpu.hours',
      quantity: 2,
      hour: 2,
    });
    // Never counted: voided.
    await seed({
      tenant: B,
      kind: 'instance',
      id: 'vm_3',
      meter: 'vm.vcpu.hours',
      quantity: 100,
      hour: 0,
      voided: true,
    });
  }
  const range = { from: H0 - HOUR, to: H0 + 6 * HOUR };

  it('root sees usage across tenants grouped by tenant and meter', async () => {
    await fleet();
    const result = await api.usage.platform(root, { ...range, groupBy: ['tenant', 'meter'] });
    expect(result.format).toBe('json');
    expect(result.truncated).toBe(false);
    expect(sorted(result.rows)).toEqual(
      sorted([
        {
          keys: { tenant: A, meter: 'net.egress.gib' },
          quantity: 3,
          windows: 1,
          outcomes: { 'dead-lettered': 1 },
        },
        {
          keys: { tenant: A, meter: 'vm.memory.gib.hours' },
          quantity: 32,
          windows: 1,
          outcomes: { recorded: 1 },
        },
        {
          keys: { tenant: A, meter: 'vm.vcpu.hours' },
          quantity: 16,
          windows: 2,
          outcomes: { recorded: 1, pending: 1 },
        },
        {
          keys: { tenant: B, meter: 'vm.reserved.vcpu.hours' },
          quantity: 2,
          windows: 1,
          outcomes: { pending: 1 },
        },
        {
          keys: { tenant: B, meter: 'vm.vcpu.hours' },
          quantity: 4,
          windows: 1,
          outcomes: { recorded: 1 },
        },
      ]),
    );
    // The voided window is not in any row, and is counted on its own.
    expect(result.voided).toBe(1);
  });

  it('groups by pool, source and provider, and narrows to one tenant', async () => {
    await fleet();
    const bySource = await api.usage.platform(root, { ...range, groupBy: ['source'] });
    expect(bySource.rows.map((row: any) => [row.keys.source, row.quantity, row.windows])).toEqual([
      ['grant', 2, 1],
      ['instance', 52, 4],
      ['network', 3, 1],
    ]);
    const byProvider = await api.usage.platform(root, {
      ...range,
      groupBy: ['provider', 'pool'],
      tenantId: A,
    });
    expect(byProvider.rows).toEqual([
      {
        keys: { provider: 'gcp', pool: '' },
        quantity: 3,
        windows: 1,
        outcomes: { 'dead-lettered': 1 },
      },
      {
        keys: { provider: 'gcp', pool: 'pool-gce' },
        quantity: 48,
        windows: 3,
        outcomes: { recorded: 2, pending: 1 },
      },
    ]);
    // Without a key: one row for everything in range.
    const total = await api.usage.platform(root, { ...range, groupBy: [] });
    expect(total.rows).toEqual([
      {
        keys: {},
        quantity: 57,
        windows: 6,
        outcomes: { recorded: 3, pending: 2, 'dead-lettered': 1 },
      },
    ]);
    // The range selects windows by their start: [from, to).
    const first = await api.usage.platform(root, {
      from: H0,
      to: H0 + HOUR,
      groupBy: ['tenant'],
    });
    expect(sorted(first.rows).map((row: any) => [row.keys.tenant, row.quantity])).toEqual(
      sorted([
        { keys: { tenant: A }, quantity: 40 },
        { keys: { tenant: B }, quantity: 4 },
      ]).map((row: any) => [row.keys.tenant, row.quantity]),
    );
    expect(first.voided).toBe(1);
  });

  it('csv export', async () => {
    await fleet();
    const result = await api.usage.platform(root, {
      ...range,
      groupBy: ['tenant', 'meter'],
      format: 'csv',
    });
    expect(result.format).toBe('csv');
    expect(result.rows).toEqual([]);
    expect(result.count).toBe(5);
    const lines = result.data.split('\r\n');
    expect(lines[0]).toBe('tenant,meter,quantity,windows,outcomes');
    expect(lines).toContain(`${A},vm.vcpu.hours,16,2,"{""pending"":1,""recorded"":1}"`);
    expect(lines).toHaveLength(7);
    expect(lines[6]).toBe('');
  });

  it('refuses a range over 93 days, a reversed one and unknown group keys', async () => {
    const code = (input: object) => outcome(api.usage.platform(root, input));
    expect(await code({ from: 0, to: 94 * 86_400_000, groupBy: [] })).toBe('INVALID_INPUT');
    expect(await code({ from: 5, to: 5, groupBy: [] })).toBe('INVALID_INPUT');
    expect(await code({ ...range, groupBy: ['instance'] })).toBe('INVALID_INPUT');
    expect(await code({ ...range, groupBy: ['tenant', 'tenant'] })).toBe('INVALID_INPUT');
    expect(await code({ ...range })).toBe('INVALID_INPUT');
    expect(await code({ ...range, groupBy: [], format: 'xml' })).toBe('INVALID_INPUT');
    expect(await code({ from: 0, to: 93 * 86_400_000, groupBy: [] })).toBe('allowed');
  });

  it('a tenant admin is denied usage.platform', async () => {
    await fleet();
    const input = { ...range, groupBy: ['tenant'] };
    expect(await outcome(api.usage.platform(acmeAdmin, input))).toBe('ACCESS_DENIED');
    // A root-tenant member without usage:read on the fleet is refused by the IAM decision.
    expect(await outcome(api.usage.platform(reader, input))).toBe('ACCESS_DENIED');
    expect(await outcome(api.usage.platform(root, input))).toBe('allowed');
  });

  it("a tenant's usage.list includes its provider instance windows", async () => {
    await fleet();
    const listed = await api.usage.list(acmeAdmin, { tenantId: A });
    const kinds = listed.items.map((window: any) => [window.meter, window.quantity]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['vm.vcpu.hours', 8],
        ['vm.memory.gib.hours', 32],
        ['net.egress.gib', 3],
      ]),
    );
    expect(listed.items).toHaveLength(4);
    for (const window of listed.items) {
      expect(window.tenantId).toBe(A);
      // Windows of other sources carry no allocation.
      expect(window).not.toHaveProperty('allocationId');
      expect(window.idempotencyKey).toMatch(/^cmp:(instance|network):/);
    }
    // The export reads the same rows.
    const exported = await api.usage.export(acmeAdmin, {
      tenantId: A,
      from: range.from,
      to: range.to,
      format: 'jsonl',
    });
    expect(exported.count).toBe(4);
    expect(exported.totals).toEqual({
      'vm.vcpu.hours': 16,
      'vm.memory.gib.hours': 32,
      'net.egress.gib': 3,
    });
  });

  it('usage.list and usage.export leave out voided windows and their totals', async () => {
    await fleet();
    const listed = await api.usage.list(otherOwner, { tenantId: B });
    expect(listed.items.map((window: any) => window.meter).sort()).toEqual([
      'vm.reserved.vcpu.hours',
      'vm.vcpu.hours',
    ]);
    const exported = await api.usage.export(otherOwner, {
      tenantId: B,
      from: range.from,
      to: range.to,
      format: 'jsonl',
    });
    expect(exported.count).toBe(2);
    expect(exported.totals).toEqual({ 'vm.vcpu.hours': 4, 'vm.reserved.vcpu.hours': 2 });
    expect(exported.voided).toBe(1);
    // Asking for them marks them.
    const withVoided = await api.usage.list(otherOwner, { tenantId: B, includeVoided: true });
    expect(withVoided.items).toHaveLength(3);
    const marked = withVoided.items.filter((window: any) => window.voidedAt !== undefined);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ quantity: 100, voidReason: 'seeded' });
  });
});
