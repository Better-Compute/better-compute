import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ComputeError,
  field,
  manifest,
  type ProviderAccountProbe,
  type ProviderContext,
} from '@better-compute/core';
import { digitaloceanProvider, resetBudgets } from '@better-compute/provider-digitalocean';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { defineProvider, vps } from '@better-compute/vps';
import { DoEmulator } from './support/do-emulator/index.js';
import { billingOf } from './support/do-emulator/billing.js';
import { securityOf } from './support/do-emulator/security.js';

// providerAccounts.check (P9): a read-only look at what a stored account's credential may do. vps validates the
// stored config, scopes its secrets to the account exactly as a client's, and asks the provider's `probeAccount`;
// a provider with only `checkAccount` answers ok when it passes; one with neither is UNSUPPORTED. The probe never
// carries a secret, and the call is a `providers:read` on the account.

afterEach(closeFixtures);
beforeEach(() => resetBudgets());

type Probe = (config: { key: string }, context: ProviderContext & { signal: AbortSignal }) => Promise<ProviderAccountProbe>;

type Findings = (config: { key: string }, context: ProviderContext & { signal: AbortSignal }) => Promise<unknown[]>;

async function fakeWorld(hooks: { probe?: Probe; check?: boolean; findings?: Findings } = {}) {
  const contexts: (ProviderContext & { signal: AbortSignal })[] = [];
  const checkAccount = vi.fn(async (_config: { key: string }, context: ProviderContext & { signal: AbortSignal }) => {
    contexts.push(context);
  });
  const provider = defineProvider<{ key: string }>({
    id: 'test',
    version: '1.0.0',
    provides: ['vps'],
    config: manifest({ key: field.secret() }) as never,
    ...(hooks.check ? { checkAccount } : {}),
    ...(hooks.probe
      ? {
          probeAccount: async (config: { key: string }, context: ProviderContext & { signal: AbortSignal }) => {
            contexts.push(context);
            return hooks.probe!(config, context);
          },
        }
      : {}),
    ...(hooks.findings
      ? {
          findings: async (config: { key: string }, context: ProviderContext & { signal: AbortSignal }) => {
            contexts.push(context);
            return hooks.findings!(config, context) as never;
          },
        }
      : {}),
    create: async () => ({
      async listOffers() {
        return [];
      },
      async create() {
        throw new ComputeError('UNIMPLEMENTED', 'test');
      },
      async get() {
        return undefined;
      },
      async delete() {},
    }),
  });
  const fixture = await computeFixture({ modules: [vps({ providers: [provider] })] });
  const { compute, tenants, iam } = fixture;
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as any;
  const acme = { token: tenants.acme.token };
  const { ref } = await api.secrets.put(acme, {
    tenantId: tenants.acme.id,
    name: 'key',
    value: 'the-key-value',
    idempotencyKey: 'key',
  });
  const account = await api.providerAccounts.create(acme, {
    tenantId: tenants.acme.id,
    provider: 'test',
    name: 'main',
    config: { key: ref },
  });
  contexts.length = 0;
  checkAccount.mockClear();
  const check = () =>
    api.providerAccounts.check(acme, { tenantId: tenants.acme.id, accountId: account.id });
  const findings = () =>
    api.providerAccounts.findings(acme, { tenantId: tenants.acme.id, accountId: account.id });
  return { fixture, api, tenants, account, ref, contexts, check, findings, checkAccount };
}

describe('providerAccounts.check', () => {
  it("answers the provider's probe with the account, scoped to the account's own secrets", async () => {
    const probe = vi.fn<Probe>(async (config, context) => {
      // The ref resolves for this account: the probe uses the credential as a client would.
      expect(await context.secrets.resolve(config.key as never)).toBe('the-key-value');
      return { ok: false, missing: ['things:write'], optional: ['costs:read'], details: { id: 'acct-1' } };
    });
    const { check, account, contexts, ref } = await fakeWorld({ probe });
    const result = await check();
    expect(result).toEqual({
      accountId: account.id,
      provider: 'test',
      checkedAt: expect.any(Number),
      ok: false,
      missing: ['things:write'],
      optional: ['costs:read'],
      details: { id: 'acct-1' },
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![0]).toEqual({ key: ref });
    expect(contexts[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(contexts[0]!.account).toMatchObject({ id: account.id });
    expect(JSON.stringify(result)).not.toContain('the-key-value');
  });

  it("passes the provider's request rate limit through, well-formed only", async () => {
    const answers: ProviderAccountProbe['rateLimit'][] = [
      { limit: 5000, remaining: 4990, resetAt: 1_800_000_000_000 },
      { limit: 5000, remaining: 12 },
      { limit: 0, remaining: 3 },
      { limit: 100, remaining: 200 },
      { limit: Number.NaN, remaining: 1 },
      { limit: 10, remaining: -1 },
      { limit: 10, remaining: 2, resetAt: Number.POSITIVE_INFINITY },
    ];
    let next = 0;
    const { check } = await fakeWorld({
      probe: async () => ({ ok: true, missing: [], rateLimit: answers[next++] }),
    });
    expect((await check()).rateLimit).toEqual({ limit: 5000, remaining: 4990, resetAt: 1_800_000_000_000 });
    expect((await check()).rateLimit).toEqual({ limit: 5000, remaining: 12 });
    // Not a limit, more left than the limit, not a number, negative: no gauge rather than a wrong one.
    for (let n = 0; n < 4; n++) expect(await check()).not.toHaveProperty('rateLimit');
    // A reset time that is not one is dropped, the count kept.
    expect((await check()).rateLimit).toEqual({ limit: 10, remaining: 2 });
  });

  it('a provider with only checkAccount answers ok when it passes; with neither, UNSUPPORTED', async () => {
    const checked = await fakeWorld({ check: true });
    expect(await checked.check()).toMatchObject({ ok: true, missing: [] });
    expect(checked.checkAccount).toHaveBeenCalledTimes(1);

    const bare = await fakeWorld();
    await expect(bare.check()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it("a refusal of the credential propagates, and another tenant's account is not found", async () => {
    const refused = await fakeWorld({
      probe: async () => {
        throw new ComputeError('INVALID_CONFIG', 'The provider refused the credential', undefined, {
          reason: 'credential',
        });
      },
    });
    await expect(refused.check()).rejects.toMatchObject({ code: 'INVALID_CONFIG' });

    const { api, fixture, tenants, account } = await fakeWorld({
      probe: async () => ({ ok: true, missing: [] }),
    });
    fixture.iam.allow({ token: tenants.other.token });
    await expect(
      api.providerAccounts.check(
        { token: tenants.other.token },
        { tenantId: tenants.other.id, accountId: account.id },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('providerAccounts.check on DigitalOcean', () => {
  it('reports the account, the missing scopes and the optional operations scopes', async () => {
    const emu = new DoEmulator();
    emu.validTokens = new Set(['acme-token']);
    emu.account.droplet_limit = 25;
    const fixture = await computeFixture({
      modules: [vps({ providers: [digitaloceanProvider({ fetch: emu.fetch })] })],
    });
    const { compute, tenants, iam } = fixture;
    iam.allow({ token: tenants.acme.token });
    const api = compute.api as any;
    const acme = { token: tenants.acme.token };
    const { ref } = await api.secrets.put(acme, {
      tenantId: tenants.acme.id,
      name: 'do',
      value: 'acme-token',
      idempotencyKey: 'do',
    });
    const account = await api.providerAccounts.create(acme, {
      tenantId: tenants.acme.id,
      provider: 'digitalocean',
      name: 'do',
      config: { token: ref, regions: ['nyc3'] },
    });
    const check = () =>
      api.providerAccounts.check(acme, { tenantId: tenants.acme.id, accountId: account.id });

    expect(await check()).toMatchObject({
      provider: 'digitalocean',
      ok: true,
      missing: [],
      optional: [],
      details: {
        account: {
          uuid: emu.account.uuid,
          status: 'active',
          dropletLimit: 25,
          // P9 Organizations: the team the token belongs to, read-only (no member's email or name).
          team: { uuid: emu.account.team.uuid, name: 'My Team' },
        },
        families: { compute: 'ok', networks: 'ok', keys: 'ok', tags: 'ok' },
        operations: { billing: 'ok', projects: 'ok', monitoring: 'ok', security: 'ok' },
      },
      // The token's hourly request budget, as DigitalOcean's last answer to the probe counted it.
      rateLimit: {
        limit: 5000,
        remaining: emu.rate.remaining,
        resetAt: emu.rate.resetAt * 1000,
      },
    });

    emu.failNext({ path: /^\/tags$/ }, 403, emu.error('forbidden').body);
    emu.failNext({ path: /^\/customers\/my\/balance$/ }, 403, emu.error('forbidden').body);
    const scoped = await check();
    expect(scoped).toMatchObject({ ok: false, missing: ['tag:read'], optional: ['billing:read'] });
    expect(JSON.stringify(scoped)).not.toContain('acme-token');
    expect(JSON.stringify(scoped)).not.toContain(emu.account.email);

    // A Droplet-locked account is not ok, whatever the scopes.
    emu.account.status = 'locked';
    expect(await check()).toMatchObject({ ok: false, missing: [] });
  });
});

// providerAccounts.findings (P9): what the provider says an operator should look at on the account (DigitalOcean:
// its security scan), read-only, with the account's own credential. vps keeps only well-formed findings.
describe('providerAccounts.findings', () => {
  it("answers the provider's findings, well-formed ones only, bounded", async () => {
    const { findings, account, contexts, ref } = await fakeWorld({
      findings: async (config, context) => {
        expect(await context.secrets.resolve(config.key as never)).toBe('the-key-value');
        return [
          { id: 'f-1', kind: 'security', severity: 'critical', title: 'Root login', detail: 'd', at: 5, group: 'g' },
          { id: 'f-2', kind: 'security', severity: 'info', title: 'x'.repeat(500) },
          { id: 'f-3', kind: 'security', severity: 'extreme', title: 'Unknown severity' },
          { kind: 'security', severity: 'info', title: 'No id' },
          { id: 'f-4', kind: 'security', severity: 'warning', title: '' },
          'not an object',
        ];
      },
    });
    const result = await findings();
    expect(result).toEqual({
      accountId: account.id,
      provider: 'test',
      readAt: expect.any(Number),
      items: [
        { id: 'f-1', kind: 'security', severity: 'critical', title: 'Root login', detail: 'd', at: 5, group: 'g' },
        { id: 'f-2', kind: 'security', severity: 'info', title: 'x'.repeat(200) },
      ],
    });
    expect(contexts[0]!.account).toMatchObject({ id: account.id });
    expect(JSON.stringify(result)).not.toContain('the-key-value');
    expect(ref).toBeDefined();
  });

  it('is UNSUPPORTED for a provider without findings', async () => {
    const bare = await fakeWorld({ check: true });
    await expect(bare.findings()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('DigitalOcean: the security scan, and a finding saying so when security:read is missing', async () => {
    const emu = new DoEmulator();
    emu.validTokens = new Set(['acme-token']);
    securityOf(emu).scans = [
      {
        id: 'scan-1',
        status: 'COMPLETED',
        created_at: '2026-10-05T10:00:00Z',
        findings: [{ rule_uuid: 'rule-ssh', name: 'SSH open to the internet', severity: 'HIGH' }],
      },
    ];
    const fixture = await computeFixture({
      modules: [vps({ providers: [digitaloceanProvider({ fetch: emu.fetch })] })],
    });
    const { compute, tenants, iam } = fixture;
    iam.allow({ token: tenants.acme.token });
    const api = compute.api as any;
    const acme = { token: tenants.acme.token };
    const { ref } = await api.secrets.put(acme, {
      tenantId: tenants.acme.id,
      name: 'do',
      value: 'acme-token',
      idempotencyKey: 'do',
    });
    const account = await api.providerAccounts.create(acme, {
      tenantId: tenants.acme.id,
      provider: 'digitalocean',
      name: 'do',
      config: { token: ref, regions: ['nyc3'] },
    });
    const read = () =>
      api.providerAccounts.findings(acme, { tenantId: tenants.acme.id, accountId: account.id });
    expect((await read()).items).toEqual([
      {
        id: 'security:rule-ssh',
        kind: 'security',
        severity: 'warning',
        title: 'SSH open to the internet',
        detail: 'Found by the latest DigitalOcean security scan.',
        at: Date.parse('2026-10-05T10:00:00Z'),
        group: 'SSH open to the internet',
      },
    ]);
    emu.failNext({ path: /^\/security\// }, 403, emu.error('forbidden').body);
    const denied = await read();
    expect(denied.items).toEqual([
      expect.objectContaining({ id: 'security:unreadable', kind: 'security', severity: 'info' }),
    ]);
    expect(denied.items[0].detail).toMatch(/security:read/);
    expect(JSON.stringify(denied)).not.toContain('acme-token');
  });
});

// providerAccounts.billing (P9): the account's own bill at its provider (DigitalOcean: balance, invoices, billing
// history), read-only, with the account's own credential; vps keeps integer amounts and bounded text only.
describe('providerAccounts.billing', () => {
  async function doWorld() {
    const emu = new DoEmulator();
    emu.validTokens = new Set(['acme-token']);
    const billing = billingOf(emu);
    billing.invoices = [
      { invoice_uuid: 'i8', invoice_period: '2026-08', amount: '38.00' },
      { invoice_uuid: 'i9', invoice_period: '2026-09', amount: '40.01' },
    ];
    billing.history = [
      { description: 'Payment (card)', amount: '-40.01', date: '2026-10-02T00:00:00Z', type: 'Payment' },
      { description: 'Invoice for September 2026', amount: '40.01', date: '2026-10-01T00:00:00Z', type: 'Invoice' },
    ];
    const fixture = await computeFixture({
      modules: [vps({ providers: [digitaloceanProvider({ fetch: emu.fetch })] })],
    });
    const { compute, tenants, iam } = fixture;
    iam.allow({ token: tenants.acme.token });
    const api = compute.api as any;
    const acme = { token: tenants.acme.token };
    const { ref } = await api.secrets.put(acme, {
      tenantId: tenants.acme.id,
      name: 'do',
      value: 'acme-token',
      idempotencyKey: 'do',
    });
    const account = await api.providerAccounts.create(acme, {
      tenantId: tenants.acme.id,
      provider: 'digitalocean',
      name: 'do',
      config: { token: ref, regions: ['nyc3'] },
    });
    const read = () =>
      api.providerAccounts.billing(acme, { tenantId: tenants.acme.id, accountId: account.id });
    return { emu, account, read };
  }

  it('DigitalOcean: the balance, the invoices newest first and the history, read-only', async () => {
    const { emu, account, read } = await doWorld();
    const before = emu.requests.length;
    const result = await read();
    expect(result).toEqual({
      accountId: account.id,
      provider: 'digitalocean',
      readAt: expect.any(Number),
      currency: 'USD',
      monthToDateMicros: 23_440_000,
      balanceMicros: 12_230_000,
      monthToDateUsageMicros: 11_210_000,
      generatedAt: Date.parse('2026-10-05T12:00:00Z'),
      invoices: [
        { id: 'i9', period: '2026-09', amountMicros: 40_010_000 },
        { id: 'i8', period: '2026-08', amountMicros: 38_000_000 },
      ],
      history: [
        { at: Date.parse('2026-10-02T00:00:00Z'), type: 'Payment', description: 'Payment (card)', amountMicros: -40_010_000 },
        { at: Date.parse('2026-10-01T00:00:00Z'), type: 'Invoice', description: 'Invoice for September 2026', amountMicros: 40_010_000 },
      ],
    });
    expect(emu.requests.slice(before).every((r) => r.method === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('acme-token');
    // A token without billing:read is ACCESS_DENIED, as DigitalOcean answers it.
    emu.failNext({ path: /^\/customers\// }, 403, emu.error('forbidden').body);
    await expect(read()).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('keeps well-formed amounts and bounded text only, and is UNSUPPORTED without the hook', async () => {
    const provider = defineProvider<{ key: string }>({
      id: 'billfake',
      version: '1.0.0',
      provides: ['vps'],
      config: manifest({ key: field.secret() }) as never,
      billingSummary: async () =>
        ({
          currency: 'EUR',
          balanceMicros: 1.5,
          monthToDateMicros: 7,
          invoices: [
            { id: 'a', period: '2026-09', amountMicros: 5 },
            { id: 'b', period: 'September', amountMicros: 5 },
            { id: 'c', period: '2026-08', amountMicros: '5' },
          ],
          history: [
            { at: 1, type: 'Payment', description: 'y'.repeat(500), amountMicros: -5 },
            { at: 'yesterday', type: 'x', description: 'x', amountMicros: 1 },
          ],
        }) as never,
      create: async () => ({
        listOffers: async () => [],
        create: async () => {
          throw new ComputeError('UNIMPLEMENTED', 'test');
        },
        get: async () => undefined,
        delete: async () => {},
      }),
    });
    const fixture = await computeFixture({ modules: [vps({ providers: [provider] })] });
    const { compute, tenants, iam } = fixture;
    iam.allow({ token: tenants.acme.token });
    const api = compute.api as any;
    const acme = { token: tenants.acme.token };
    const { ref } = await api.secrets.put(acme, {
      tenantId: tenants.acme.id,
      name: 'key',
      value: 'the-key-value',
      idempotencyKey: 'key',
    });
    const account = await api.providerAccounts.create(acme, {
      tenantId: tenants.acme.id,
      provider: 'billfake',
      name: 'main',
      config: { key: ref },
    });
    const result = await api.providerAccounts.billing(acme, {
      tenantId: tenants.acme.id,
      accountId: account.id,
    });
    expect(result).toMatchObject({
      currency: 'EUR',
      monthToDateMicros: 7,
      invoices: [{ id: 'a', period: '2026-09', amountMicros: 5 }],
      history: [{ at: 1, type: 'Payment', description: 'y'.repeat(200), amountMicros: -5 }],
    });
    expect(result.balanceMicros).toBeUndefined();

    const bare = await fakeWorld({ check: true });
    await expect(
      bare.api.providerAccounts.billing(
        { token: bare.tenants.acme.token },
        { tenantId: bare.tenants.acme.id, accountId: bare.account.id },
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});
