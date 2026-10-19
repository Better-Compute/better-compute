import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultMeterGpuModels,
  manualClock,
  type Credential,
  type SqlExecutor,
} from '@better-compute/core';
import { usageCsv } from '@better-compute/console-kit';
import { flushUsageWindows } from '@better-compute/iam';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';
import { createMetrics, databaseCollector, standardMetrics } from '@better-compute/observability';
import { pruneUsageWindows, setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { vps } from '@better-compute/vps';
import { csvField } from '../packages/server/src/api/usage.js';

// Root's cross-tenant usage view (Task 22, D17) and the corrections root makes to it (Task 23, D17/D18): dead
// letters, retry and void. Everything runs against a REAL better-iam (embedded, with compute's plugin and resolver,
// as tests/vps-pricing.test.ts does): the root administrator is let through by ROOT_OVERRIDE, a tenant
// administrator is turned away before any IAM decision, and a root-tenant member holds only what its policy grants
// on the fleet.

// A model the bridge's own catalog does not name, so its VM meters are missing until syncMeters creates them.
const MODEL = 'zz9';

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
// Pinned to the 15th, noon UTC, of this month (or last month, before the 15th): the test hours and "last month" never
// straddle a month boundary, whenever CI runs. The embedded better-iam shares the clock.
const midMonth = (() => {
  const now = new Date();
  const thisMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12);
  return thisMonth <= now.getTime()
    ? thisMonth
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12);
})();
const clock = manualClock(midMonth);
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
  t = await createEmbeddedTestIam({ now: () => clock.now() });
  database = pglite();
  compute = betterCompute({
    database,
    iam: t.port,
    secret: 'better-compute-usage-platform-secret-0123456789',
    baseURL: 'http://127.0.0.1:3000',
    clock,
    modules: [
      ...t.bridge.modules,
      vps({ billing: { gpuModels: [...defaultMeterGpuModels, MODEL] } }),
    ],
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
    const marked = withVoided.items.filter((window: any) => window.voided === true);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ quantity: 100, voided: true, voidedAt: expect.any(Number) });
    // Root's free-text reason is root's: a tenant never sees it.
    expect(JSON.stringify(withVoided)).not.toContain('seeded');
    expect(marked[0]).not.toHaveProperty('voidReason');
    expect(withVoided.items.filter((window: any) => window.voided !== true)).toHaveLength(2);
  });

  it('neutralises formula cells in every CSV, as console-kit does', async () => {
    await seed({
      tenant: A,
      kind: 'instance',
      id: 'vm_csv',
      meter: 'vm.vcpu.hours',
      quantity: 1,
      hour: 0,
      identityId: '=cmd|calc',
      tags: { pool: '=cmd', provider: '@x', project: '@x' },
    });
    // The platform CSV: group keys come from tags.
    const platform = await api.usage.platform(root, {
      ...range,
      groupBy: ['pool', 'provider'],
      format: 'csv',
    });
    expect(platform.data.split('\r\n')[1]).toBe(`'=cmd,'@x,1,1,"{""pending"":1}"`);
    // The tenant export: the identity cell is data, not a formula; a tag value is inside the tags JSON.
    const exported = await api.usage.export(acmeAdmin, { tenantId: A, ...range, format: 'csv' });
    const row = exported.data.split('\r\n')[1];
    expect(row).toContain(",'=cmd|calc,");
    expect(row).toContain('"{""pool"":""=cmd"",""project"":""@x"",""provider"":""@x""}"');
    for (const cell of row.split(',')) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
  });

  it("shares console-kit's CSV cell rule", () => {
    const start = Date.UTC(2026, 8, 1);
    for (const value of ['=cmd', '+1', '-1', '@x', '\tx', '\rx', 'a,b', 'say "hi"', 'plain', '']) {
      const csv = usageCsv([
        {
          idempotencyKey: 'k',
          allocationId: 'a',
          tenantId: 't',
          identityId: 'i',
          meter: 'm',
          quantity: 1,
          windowStart: start,
          windowEnd: start + HOUR,
          tags: { project: value },
          outcome: 'recorded',
        },
      ]);
      const row = csv.split('\r\n')[1]!;
      const prefix = `${new Date(start).toISOString()},${new Date(start + HOUR).toISOString()},m,1,`;
      const cell = row.slice(prefix.length, row.length - ',i,a,recorded,k'.length);
      expect(csvField(value)).toBe(cell);
    }
  });
});

describe('corrections', () => {
  beforeEach(async () => {
    await database.query('DELETE FROM usage_windows');
    await database.query('DELETE FROM usage_dead_letters');
  });

  const flush = () => flushUsageWindows(database, t.port);
  /** A pending hourly window of a provider instance, billed on a meter better-iam knows. */
  const pending = (id: string, extra: Partial<Seed> = {}) =>
    seed({
      tenant: A,
      kind: 'instance',
      id,
      meter: 'gpu.h100.hours',
      quantity: 1,
      hour: 0,
      ...extra,
    });
  const windowOf = async (key: string) =>
    (
      await database.query<{ outcome: string | null; recorded_at: unknown; voided_at: unknown }>(
        'SELECT outcome, recorded_at, voided_at FROM usage_windows WHERE idempotency_key = $1',
        [key],
      )
    ).rows[0]!;
  const range = { from: H0 - HOUR, to: H0 + 6 * HOUR };

  it('period-closed dead letter: listed once, never retried by later flushes, and retry refuses it', async () => {
    // Last month, in better-iam: a priced meter, one recorded hour, and the month closed.
    const now = new Date(clock.now());
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const period = lastMonth.toISOString().slice(0, 7);
    const early = lastMonth.getTime() + 2 * HOUR;
    await api.billing.setPrices(root, {
      prices: [
        {
          meter: 'gpu.h100.hours',
          effectiveFrom: period,
          spec: { model: 'per-unit', unitAmountMicros: 4_000_000 },
        },
      ],
    });
    await pending('vm_early', { at: early });
    expect(await flush()).toEqual({ sent: 1, deadLettered: 0, more: false });
    await t.iam.api.billing.closePeriod(root, { tenantId: R, period, draft: false });

    // A late window of the closed month.
    const late = await pending('vm_late', { at: early + HOUR });
    expect(await flush()).toEqual({ sent: 1, deadLettered: 1, more: false });
    expect(await windowOf(late)).toMatchObject({ outcome: 'dead-lettered' });

    const listed = await api.usage.deadLetters(root, {});
    expect(listed.items).toEqual([
      {
        idempotencyKey: late,
        tenantId: A,
        meter: 'gpu.h100.hours',
        quantity: 1,
        windowStart: early + HOUR,
        reason: 'period-closed',
        error: expect.stringMatching(/invoiced|period|closed/i),
      },
    ]);
    expect(listed.cursor).toBeUndefined();
    expect((await api.usage.deadLetters(root, { reason: 'period-closed' })).items).toHaveLength(1);
    expect((await api.usage.deadLetters(root, { reason: 'meter-missing' })).items).toEqual([]);

    // Never retried automatically: the window stays dead-lettered and later passes send nothing.
    expect(await flush()).toEqual({ sent: 0, deadLettered: 0, more: false });
    expect(await flush()).toEqual({ sent: 0, deadLettered: 0, more: false });
    const letters = await database.query<{ attempts: number }>(
      'SELECT attempts FROM usage_dead_letters',
    );
    expect(letters.rows).toEqual([{ attempts: 1 }]);

    // Retrying would only fail again: refused, by key and by reason, and it says what to do.
    const byKey = await failure(api.usage.retry(root, { idempotencyKeys: [late] }));
    expect(byKey.code).toBe('INVALID_STATE');
    expect(byKey.message).toMatch(/invoice item/i);
    const byReason = await failure(api.usage.retry(root, { reason: 'period-closed' }));
    expect(byReason.code).toBe('INVALID_STATE');
    expect(byReason.message).toMatch(/invoice item/i);
    expect(await windowOf(late)).toMatchObject({ outcome: 'dead-lettered' });
  });

  it('meter-missing then retry after syncMeters succeeds', async () => {
    const key = await pending('vm_zz9', { meter: `vm.gpu.${MODEL}.hours` });
    expect(await flush()).toEqual({ sent: 1, deadLettered: 1, more: false });

    const listed = await api.usage.deadLetters(root, { reason: 'meter-missing' });
    expect(listed.items).toEqual([
      expect.objectContaining({
        idempotencyKey: key,
        tenantId: A,
        meter: `vm.gpu.${MODEL}.hours`,
        reason: 'meter-missing',
      }),
    ]);

    // Still missing: the retry is sent again and fails again (attempts counts it).
    expect(await api.usage.retry(root, { idempotencyKeys: [key] })).toEqual({ retried: 1 });
    expect(await windowOf(key)).toMatchObject({ outcome: null, recorded_at: null });
    expect(await flush()).toEqual({ sent: 1, deadLettered: 1, more: false });
    expect(
      (
        await database.query('SELECT attempts FROM usage_dead_letters WHERE idempotency_key = $1', [
          key,
        ])
      ).rows,
    ).toEqual([{ attempts: 2 }]);

    await api.billing.syncMeters(root, {});
    expect(await api.usage.retry(root, { reason: 'meter-missing' })).toEqual({ retried: 1 });
    expect(await flush()).toEqual({ sent: 1, deadLettered: 0, more: false });
    expect(await windowOf(key)).toMatchObject({ outcome: 'recorded' });
    // Resolved: no longer a dead letter, and a retry of it finds nothing to retry.
    expect((await api.usage.deadLetters(root, {})).items).toEqual([]);
    expect(await api.usage.retry(root, { reason: 'meter-missing' })).toEqual({ retried: 0 });
    expect(await outcome(api.usage.retry(root, { idempotencyKeys: [key] }))).toBe('NOT_FOUND');
  });

  it('deadLetters pages, filters by reason and derives the reason from the error', async () => {
    const letters: [string, string][] = [
      ['NOT_FOUND', 'Meter not found'],
      ['BILLING_PERIOD_CLOSED', '2026-08 has already been invoiced'],
      ['NOT_FOUND', 'Identity not found'],
      ['INVALID_INPUT', 'quantity must be a number'],
      ['CONFLICT', 'This idempotency key was used for another meter'],
      ['METER_ARCHIVED', 'Meter is archived'],
    ];
    for (const [index, [code, message]] of letters.entries()) {
      const key = await pending(`vm_${index}`, { hour: index });
      await database.query(
        `UPDATE usage_windows SET recorded_at = compute_now(), outcome = 'dead-lettered' WHERE idempotency_key = $1`,
        [key],
      );
      await database.query(
        `INSERT INTO usage_dead_letters (idempotency_key, tenant_id, event, error_code, error_message)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [
          key,
          A,
          JSON.stringify({
            meter: 'gpu.h100.hours',
            quantity: 1,
            occurredAt: H0 + index * HOUR,
            // A pass-through window carries its cost (currency units) for root's invoice item.
            ...(code === 'BILLING_PERIOD_CLOSED' ? { cost: 0.42 } : {}),
          }),
          code,
          message,
        ],
      );
    }
    const all: any[] = [];
    let cursor: string | undefined;
    do {
      const page: any = await api.usage.deadLetters(root, {
        limit: 4,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.items.length).toBeLessThanOrEqual(4);
      all.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    expect(all).toHaveLength(6);
    expect(new Set(all.map((letter) => letter.idempotencyKey)).size).toBe(6);
    expect(Object.fromEntries(all.map((letter) => [letter.error, letter.reason]))).toEqual({
      'Meter not found': 'meter-missing',
      '2026-08 has already been invoiced': 'period-closed',
      'Identity not found': 'identity',
      'quantity must be a number': 'invalid',
      'This idempotency key was used for another meter': 'other',
      'Meter is archived': 'other',
    });
    expect(all.filter((letter) => 'cost' in letter)).toEqual([
      expect.objectContaining({ reason: 'period-closed', cost: 0.42 }),
    ]);
    for (const reason of ['meter-missing', 'period-closed', 'identity', 'invalid', 'other']) {
      const some = await api.usage.deadLetters(root, { reason });
      expect(some.items.every((letter: any) => letter.reason === reason)).toBe(true);
    }
    expect((await api.usage.deadLetters(root, { reason: 'other' })).items).toHaveLength(2);
    expect(await outcome(api.usage.deadLetters(root, { reason: 'nope' }))).toBe('INVALID_INPUT');
    expect(await outcome(api.usage.deadLetters(root, { cursor: '!' }))).toBe('INVALID_INPUT');
    expect(await outcome(api.usage.deadLetters(root, { limit: 501 }))).toBe('INVALID_INPUT');
    // retry takes keys or a reason, not both and not neither; a reason retries all of its letters.
    expect(await outcome(api.usage.retry(root, {}))).toBe('INVALID_INPUT');
    expect(
      await outcome(api.usage.retry(root, { idempotencyKeys: ['cmp:x'], reason: 'other' })),
    ).toBe('INVALID_INPUT');
    expect(await api.usage.retry(root, { reason: 'other' })).toEqual({ retried: 2 });
    expect(
      (await database.query('SELECT 1 FROM usage_windows WHERE outcome IS NULL')).rows,
    ).toHaveLength(2);
  });

  it('void excludes a pending window from the flush', async () => {
    const voided = await pending('vm_void');
    const kept = await pending('vm_kept', { hour: 1 });
    expect(
      await api.usage.void(root, { idempotencyKeys: [voided], reason: 'bad meter data' }),
    ).toEqual({ voided: 1, alreadyVoided: 0 });
    expect(await windowOf(voided)).toMatchObject({ outcome: null, recorded_at: null });
    expect(
      (
        await database.query<{ void_reason: string; voided_at: unknown }>(
          'SELECT void_reason, voided_at FROM usage_windows WHERE idempotency_key = $1',
          [voided],
        )
      ).rows[0],
    ).toEqual({ void_reason: 'bad meter data', voided_at: expect.anything() });

    // Only the other window is sent, now and ever.
    expect(await flush()).toEqual({ sent: 1, deadLettered: 0, more: false });
    expect(await flush()).toEqual({ sent: 0, deadLettered: 0, more: false });
    expect(await windowOf(kept)).toMatchObject({ outcome: 'recorded' });
    expect(await windowOf(voided)).toMatchObject({ outcome: null, recorded_at: null });

    // Voiding it again changes nothing; the first reason stays.
    expect(await api.usage.void(root, { idempotencyKeys: [voided], reason: 'again' })).toEqual({
      voided: 0,
      alreadyVoided: 1,
    });
    expect(
      (
        await database.query('SELECT void_reason FROM usage_windows WHERE idempotency_key = $1', [
          voided,
        ])
      ).rows,
    ).toEqual([{ void_reason: 'bad meter data' }]);

    // The views leave it out and count it.
    const view = await api.usage.platform(root, { ...range, groupBy: [] });
    expect(view.rows[0]).toMatchObject({ quantity: 1, windows: 1 });
    expect(view.voided).toBe(1);
    const listed = await api.usage.list(acmeAdmin, { tenantId: A });
    expect(listed.items.map((window: any) => window.idempotencyKey)).toEqual([kept]);
  });

  it('void of a recorded window is refused with the credit-note hint, and refuses the whole call', async () => {
    const sent = await pending('vm_sent');
    const open = await pending('vm_open', { hour: 2 });
    // `sent` is recorded by hand, as the flush does.
    await database.query(
      "UPDATE usage_windows SET recorded_at = compute_now(), outcome = 'recorded' WHERE idempotency_key = $1",
      [sent],
    );
    const refusal = await failure(
      api.usage.void(root, { idempotencyKeys: [open, sent], reason: 'oops' }),
    );
    expect(refusal.code).toBe('INVALID_STATE');
    expect(refusal.message).toMatch(/credit note in Better IAM/);
    const unknown = await failure(
      api.usage.void(root, {
        idempotencyKeys: ['cmp:instance:nope:1:gpu.h100.hours'],
        reason: 'x',
      }),
    );
    expect(unknown.code).toBe('NOT_FOUND');
    // Atomic: the pending window of the refused call was not voided.
    for (const key of [open, sent]) expect((await windowOf(key)).voided_at).toBeNull();
    expect(await outcome(api.usage.void(root, { idempotencyKeys: [], reason: 'x' }))).toBe(
      'INVALID_INPUT',
    );
    expect(await outcome(api.usage.void(root, { idempotencyKeys: [open] }))).toBe('INVALID_INPUT');
  });

  /** A dead-lettered window with its open letter, as the flush leaves them. */
  async function deadLettered(id: string, extra: Partial<Seed> = {}, code = 'NOT_FOUND') {
    const key = await pending(id, extra);
    await database.query(
      "UPDATE usage_windows SET recorded_at = compute_now(), outcome = 'dead-lettered' WHERE idempotency_key = $1",
      [key],
    );
    await database.query(
      `INSERT INTO usage_dead_letters (idempotency_key, tenant_id, event, error_code, error_message)
       VALUES ($1, $2, $3::jsonb, $4, 'refused')`,
      [key, A, JSON.stringify({ meter: 'gpu.h100.hours', quantity: 1, occurredAt: H0 }), code],
    );
    return key;
  }
  const letterOf = async (key: string) =>
    (
      await database.query<{ resolved_at: unknown }>(
        'SELECT resolved_at FROM usage_dead_letters WHERE idempotency_key = $1',
        [key],
      )
    ).rows[0]!;

  it('void accepts a dead-lettered window (IAM refused it) and resolves its open letter', async () => {
    const letter = await deadLettered('vm_dl', { hour: 1 }, 'BILLING_PERIOD_CLOSED');
    expect((await api.usage.deadLetters(root, {})).items).toHaveLength(1);
    expect(
      await api.usage.void(root, { idempotencyKeys: [letter], reason: 'invoiced by hand' }),
    ).toEqual({
      voided: 1,
      alreadyVoided: 0,
    });
    expect(await windowOf(letter)).toMatchObject({ outcome: 'dead-lettered' });
    expect((await windowOf(letter)).voided_at).not.toBeNull();
    expect((await letterOf(letter)).resolved_at).not.toBeNull();
    expect((await api.usage.deadLetters(root, {})).items).toEqual([]);
    // Voided: no longer a letter to retry, and the doctor's dead-letter count drops.
    expect(await outcome(api.usage.retry(root, { idempotencyKeys: [letter] }))).toBe('NOT_FOUND');
    // The refusal for a dead-lettered window never carries the credit-note hint (nothing was billed).
    const again = await api.usage.void(root, { idempotencyKeys: [letter], reason: 'again' });
    expect(again).toEqual({ voided: 0, alreadyVoided: 1 });
  });

  it('voiding any window resolves its open letters, a retried pending window included', async () => {
    const key = await deadLettered('vm_retried');
    expect(await api.usage.retry(root, { idempotencyKeys: [key] })).toEqual({ retried: 1 });
    expect((await letterOf(key)).resolved_at).toBeNull();
    expect(await api.usage.void(root, { idempotencyKeys: [key], reason: 'not wanted' })).toEqual({
      voided: 1,
      alreadyVoided: 0,
    });
    expect((await letterOf(key)).resolved_at).not.toBeNull();
    expect((await api.usage.deadLetters(root, {})).items).toEqual([]);
    // A refused call resolves nothing.
    const other = await deadLettered('vm_other', { hour: 1 });
    const sent = await pending('vm_rec', { hour: 2 });
    await database.query(
      "UPDATE usage_windows SET recorded_at = compute_now(), outcome = 'recorded' WHERE idempotency_key = $1",
      [sent],
    );
    expect(
      await outcome(api.usage.void(root, { idempotencyKeys: [other, sent], reason: 'x' })),
    ).toBe('INVALID_STATE');
    expect((await letterOf(other)).resolved_at).toBeNull();
    expect((await windowOf(other)).voided_at).toBeNull();
  });

  it('retry of a key whose window was pruned is NOT_FOUND and says to record it by hand', async () => {
    const key = await deadLettered('vm_pruned');
    await database.query('DELETE FROM usage_windows WHERE idempotency_key = $1', [key]);
    const error = await failure(api.usage.retry(root, { idempotencyKeys: [key] }));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toMatch(/window pruned; record it in Better IAM by hand/);
    // By reason, a pruned window is simply not retried.
    expect(await api.usage.retry(root, { reason: 'meter-missing' })).toEqual({ retried: 0 });
  });

  it('the doctor names usage.deadLetters and usage.retry', async () => {
    await deadLettered('vm_doctor');
    const report = await compute.selfCheck();
    for (const check of ['usage.dead-letters', 'iam.usage-dead-letters']) {
      const finding = report.findings.find((entry: any) => entry.check === check);
      expect(finding?.fix, check).toMatch(/usage\.deadLetters/);
      expect(finding?.fix, check).toMatch(/usage\.retry/);
    }
  });

  describe('claims (the flush and usage.void do not race)', () => {
    /** An IAM that holds the flush mid-send until released. */
    function gatedIam() {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const started = new Promise<void>((resolve) => (entered = resolve));
      return {
        release,
        started,
        iam: {
          async recordUsage(events: Parameters<typeof t.port.recordUsage>[0]) {
            entered();
            await gate;
            return t.port.recordUsage(events);
          },
        },
      };
    }
    const claimedAt = async (key: string) =>
      (
        await database.query<{ claimed_at: unknown }>(
          'SELECT claimed_at FROM usage_windows WHERE idempotency_key = $1',
          [key],
        )
      ).rows[0]!.claimed_at;

    it('a window claimed by a flush cannot be voided', async () => {
      const key = await pending('vm_claim');
      const gated = gatedIam();
      const flushing = flushUsageWindows(database, gated.iam);
      await gated.started;
      expect(await claimedAt(key)).not.toBeNull();

      const refusal = await failure(
        api.usage.void(root, { idempotencyKeys: [key], reason: 'late' }),
      );
      expect(refusal.code).toBe('INVALID_STATE');
      expect(refusal.message).toMatch(/being sent; retry shortly/);
      expect((await windowOf(key)).voided_at).toBeNull();

      gated.release();
      expect(await flushing).toEqual({ sent: 1, deadLettered: 0, more: false });
      expect(await windowOf(key)).toMatchObject({ outcome: 'recorded' });
      // Recorded now: the refusal is the credit-note one.
      expect(
        (await failure(api.usage.void(root, { idempotencyKeys: [key], reason: 'x' }))).message,
      ).toMatch(/credit note/);
    });

    it('a second flush leaves a fresh claim alone, and takes over a stale one (duplicate-safe)', async () => {
      const key = await pending('vm_stale_claim');
      expect(await flush()).toEqual({ sent: 1, deadLettered: 0, more: false });
      // Back to pending, claimed a minute ago by a flush that is still sending: not taken.
      const reopen = (age: string) =>
        database.query(
          `UPDATE usage_windows SET recorded_at = NULL, outcome = NULL,
                  claimed_at = compute_now() - $1::interval WHERE idempotency_key = $2`,
          [age, key],
        );
      await reopen('1 minute');
      expect(await flush()).toEqual({ sent: 0, deadLettered: 0, more: false });
      // Claimed 11 minutes ago (the sender died): taken over and sent again; IAM knows the key.
      await reopen('11 minutes');
      expect(await flush()).toEqual({ sent: 1, deadLettered: 0, more: false });
      expect(await windowOf(key)).toMatchObject({ outcome: 'duplicate' });
    });

    it('a stale claim can be voided, a fresh one cannot', async () => {
      const key = await pending('vm_void_claim');
      await database.query(
        "UPDATE usage_windows SET claimed_at = compute_now() - interval '2 minutes' WHERE idempotency_key = $1",
        [key],
      );
      expect(await outcome(api.usage.void(root, { idempotencyKeys: [key], reason: 'x' }))).toBe(
        'INVALID_STATE',
      );
      await database.query(
        "UPDATE usage_windows SET claimed_at = compute_now() - interval '11 minutes' WHERE idempotency_key = $1",
        [key],
      );
      expect(await api.usage.void(root, { idempotencyKeys: [key], reason: 'x' })).toEqual({
        voided: 1,
        alreadyVoided: 0,
      });
    });

    it('a failed send keeps its claims (it may have been delivered); the takeover after the TTL resends', async () => {
      const key = await pending('vm_failed_send');
      await expect(
        flushUsageWindows(database, { recordUsage: () => Promise.reject(new Error('IAM down')) }),
      ).rejects.toThrow('IAM down');
      // Kept: void refuses it and the next pass leaves it alone until the claim is 10 minutes old.
      expect(await claimedAt(key)).not.toBeNull();
      expect(await outcome(api.usage.void(root, { idempotencyKeys: [key], reason: 'x' }))).toBe(
        'INVALID_STATE',
      );
      expect(await flush()).toEqual({ sent: 0, deadLettered: 0, more: false });
      try {
        await setSimClock(database, clock.now() + 11 * 60_000);
        expect(await flush()).toEqual({ sent: 1, deadLettered: 0, more: false });
      } finally {
        await useSimClock(database, clock.now());
      }
      expect(await windowOf(key)).toMatchObject({ outcome: 'recorded' });
      expect(await claimedAt(key)).toBeNull();
    });

    it("a pass never clears a newer takeover's claim", async () => {
      const key = await pending('vm_taken_over');
      let newer: unknown;
      const report = await flushUsageWindows(database, {
        recordUsage: async (events) => {
          // While this pass sends, its claim expires and another pass takes the window over.
          await database.query(
            "UPDATE usage_windows SET claimed_at = compute_now() + interval '1 second' WHERE idempotency_key = $1",
            [key],
          );
          newer = await claimedAt(key);
          return events.map((event) => ({
            idempotencyKey: event.idempotencyKey,
            status: 'recorded' as const,
          }));
        },
      });
      expect(report).toEqual({ sent: 1, deadLettered: 0, more: false });
      expect(newer).not.toBeNull();
      expect(await claimedAt(key)).toEqual(newer);
    });

    it('retry gives a window back to the flush at once', async () => {
      const key = await deadLettered('vm_retry_claim');
      await database.query(
        'UPDATE usage_windows SET claimed_at = compute_now() WHERE idempotency_key = $1',
        [key],
      );
      expect(await api.usage.retry(root, { idempotencyKeys: [key] })).toEqual({ retried: 1 });
      expect(await claimedAt(key)).toBeNull();
    });

    it('backlog counters still see claimed, unsent windows', async () => {
      const key = await pending('vm_claimed_backlog');
      const gated = gatedIam();
      const flushing = flushUsageWindows(database, gated.iam);
      await gated.started;
      const report = await compute.selfCheck();
      expect(report.findings.some((entry: any) => entry.check === 'usage.backlog')).toBe(true);
      const registry = createMetrics();
      await databaseCollector(standardMetrics(registry), {
        sql: database,
        now: () => clock.now(),
      }).refresh();
      expect(registry.value('backlog', { queue: 'usage' })).toBe(1);
      gated.release();
      await flushing;
      expect(await claimedAt(key)).toBeNull();
    });
  });
  it('void checks the outcome in the statement that writes the void', async () => {
    // The check and the write are one statement: a window with an outcome is never voided.
    const key = await pending('vm_race');
    await database.query(
      "UPDATE usage_windows SET recorded_at = compute_now(), outcome = 'duplicate' WHERE idempotency_key = $1",
      [key],
    );
    expect(await outcome(api.usage.void(root, { idempotencyKeys: [key], reason: 'race' }))).toBe(
      'INVALID_STATE',
    );
    const after = await windowOf(key);
    expect(after.voided_at).toBeNull();
    expect(after.outcome).toBe('duplicate');
  });

  it('tenants cannot read dead letters, retry or void', async () => {
    const key = await pending('vm_guard');
    await database.query(
      `INSERT INTO usage_dead_letters (idempotency_key, tenant_id, event, error_code, error_message)
       VALUES ($1, $2, '{}'::jsonb, 'NOT_FOUND', 'Meter not found')`,
      [key, A],
    );
    for (const credential of [acmeAdmin, otherOwner, reader]) {
      expect(await outcome(api.usage.deadLetters(credential, {}))).toBe('ACCESS_DENIED');
      expect(await outcome(api.usage.retry(credential, { reason: 'meter-missing' }))).toBe(
        'ACCESS_DENIED',
      );
      expect(
        await outcome(api.usage.void(credential, { idempotencyKeys: [key], reason: 'x' })),
      ).toBe('ACCESS_DENIED');
    }
    expect((await windowOf(key)).voided_at).toBeNull();
  });

  describe('voided windows are final', () => {
    it('are not backlog: the doctor, the self-check and the backlog gauge skip them', async () => {
      // Pending for 4 h (stale), and one of last month (IAM's closePeriod would refuse it).
      const now = new Date(clock.now());
      const lastMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 3);
      const stale = await pending('vm_stale');
      const old = await pending('vm_old', { at: lastMonth });
      const backlog = async () => {
        const report = await compute.selfCheck();
        const checks = (report.findings ?? report) as { check: string; severity: string }[];
        const registry = createMetrics();
        await databaseCollector(standardMetrics(registry), {
          sql: database,
          now: () => clock.now(),
        }).refresh();
        return {
          server: checks.some((finding) => finding.check === 'usage.backlog'),
          iamClosing: checks.some(
            (finding) => finding.check === 'iam.usage-backlog' && finding.severity === 'error',
          ),
          iamAny: checks.some((finding) => finding.check === 'iam.usage-backlog'),
          gauge: registry.value('backlog', { queue: 'usage' }),
        };
      };
      expect(await backlog()).toMatchObject({ server: true, iamClosing: true, gauge: 2 });
      await api.usage.void(root, { idempotencyKeys: [stale, old], reason: 'remove' });
      expect(await backlog()).toMatchObject({
        server: false,
        iamClosing: false,
        iamAny: false,
        gauge: 0,
      });
    });

    it('are pruned like recorded ones, and pending ones are not', async () => {
      const voided = await pending('vm_pv');
      const live = await pending('vm_pl', { hour: 1 });
      await api.usage.void(root, { idempotencyKeys: [voided], reason: 'gone' });
      try {
        await setSimClock(database, clock.now() + 30 * 86_400_000);
        expect(
          await database.transaction((tx) => pruneUsageWindows(tx, { olderThanDays: 14 })),
        ).toBe(1);
      } finally {
        await useSimClock(database, clock.now());
      }
      const left = await database.query<{ idempotency_key: string }>(
        'SELECT idempotency_key FROM usage_windows',
      );
      expect(left.rows).toEqual([{ idempotency_key: live }]);
    });
  });
});
