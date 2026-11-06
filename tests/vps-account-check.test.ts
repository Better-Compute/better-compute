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

// providerAccounts.check (P9): a read-only look at what a stored account's credential may do. vps validates the
// stored config, scopes its secrets to the account exactly as a client's, and asks the provider's `probeAccount`;
// a provider with only `checkAccount` answers ok when it passes; one with neither is UNSUPPORTED. The probe never
// carries a secret, and the call is a `providers:read` on the account.

afterEach(closeFixtures);
beforeEach(() => resetBudgets());

type Probe = (config: { key: string }, context: ProviderContext & { signal: AbortSignal }) => Promise<ProviderAccountProbe>;

async function fakeWorld(hooks: { probe?: Probe; check?: boolean } = {}) {
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
  return { fixture, api, tenants, account, ref, contexts, check, checkAccount };
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
        account: { uuid: emu.account.uuid, status: 'active', dropletLimit: 25 },
        families: { compute: 'ok', networks: 'ok', keys: 'ok', tags: 'ok' },
        operations: { billing: 'ok', projects: 'ok', monitoring: 'ok', security: 'ok' },
      },
    });

    emu.failNext({ path: /^\/tags$/ }, 403, emu.error('forbidden').body);
    emu.failNext({ path: /^\/customers\/my\/balance$/ }, 403, emu.error('forbidden').body);
    const scoped = await check();
    expect(scoped).toMatchObject({ ok: false, missing: ['tag:read'], optional: ['billing:read'] });
    expect(JSON.stringify(scoped)).not.toContain('acme-token');

    // A Droplet-locked account is not ok, whatever the scopes.
    emu.account.status = 'locked';
    expect(await check()).toMatchObject({ ok: false, missing: [] });
  });
});
