import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SecretStore } from '@better-compute/core';
import { localSealedSecretStore } from '@better-compute/pki';
import {
  digitaloceanProvider,
  resetBudgets,
  resetOAuthState,
  rotateInto,
} from '@better-compute/provider-digitalocean';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { vps } from '@better-compute/vps';
import { DoEmulator } from './support/do-emulator/index.js';
import { OAuthEmulator } from './support/do-emulator/oauth.js';

// "Connect a DigitalOcean account" (P9) end to end: providerAccounts.connectSetup answers DigitalOcean's
// authorization URL for a registered redirect URI; providerAccounts.connect trades the code (single use), seals the
// refresh token in the deployment's secret store and stores the account with that ref as `refreshToken`. The
// account then works: its first request exchanges the refresh token, and the rotated one is written back over the
// same ref through rotateInto(store). No token appears in the account, the answers or the log.

afterEach(closeFixtures);
beforeEach(() => {
  resetBudgets();
  resetOAuthState();
});

const REDIRECT = 'https://console.example.test/provider-accounts/connect/callback';
/** The fixture's sealing secret (packages/testing), so the test's store reads what the server sealed. */
const FIXTURE_SECRET = 'better-compute-testing-fixture-secret-0123456789';

async function world(options: { redirectUris?: string[] } = {}) {
  const api = new DoEmulator();
  api.validTokens = new Set();
  const oauth = new OAuthEmulator(api);
  oauth.refreshTokens.clear();
  /** Rotations, as the host's store receives them through rotateInto (in memory: pglite has one connection). */
  const rotated = new Map<string, { tenantId: string; value: string }>();
  const rotations: Pick<SecretStore, 'put'> = {
    put: async (tenantId, value, putOptions) => {
      rotated.set(putOptions!.ref!, { tenantId, value });
      return putOptions!.ref!;
    },
  };
  const lines: string[] = [];
  const log = {
    debug: (...a: unknown[]) => void lines.push(JSON.stringify(a)),
    info: (...a: unknown[]) => void lines.push(JSON.stringify(a)),
    warn: (...a: unknown[]) => void lines.push(JSON.stringify(a)),
    error: (...a: unknown[]) => void lines.push(JSON.stringify(a)),
  };
  const provider = digitaloceanProvider({
    fetch: oauth.fetch,
    oauth: {
      clientId: oauth.clientId,
      clientSecret: async () => oauth.clientSecret,
      redirectUris: options.redirectUris ?? [REDIRECT],
      rotate: rotateInto(rotations),
    },
  });
  const fixture = await computeFixture({ modules: [vps({ providers: [provider] })], log });
  const store = localSealedSecretStore({ sql: fixture.database, keys: FIXTURE_SECRET });
  const { compute, tenants, iam } = fixture;
  iam.allow({ token: tenants.acme.token });
  const call = compute.api as any;
  const acme = { token: tenants.acme.token };
  return { api, oauth, fixture, call, acme, tenants, store, rotated, lines };
}

describe('providerAccounts.connect (DigitalOcean OAuth)', () => {
  it('answers the authorization URL for a registered redirect URI only', async () => {
    const { call, acme, tenants } = await world();
    const state = 'state-0123456789abcdef';
    const { authorizeUrl } = await call.providerAccounts.connectSetup(acme, {
      tenantId: tenants.acme.id,
      provider: 'digitalocean',
      redirectUri: REDIRECT,
      state,
    });
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://cloud.digitalocean.com/v1/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-1',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'read write',
      state,
    });
    expect(authorizeUrl).not.toContain('client-secret');
    await expect(
      call.providerAccounts.connectSetup(acme, {
        tenantId: tenants.acme.id,
        provider: 'digitalocean',
        redirectUri: 'https://evil.example.test/callback',
        state,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('trades the code, seals the refresh token and stores a working account', async () => {
    const { oauth, call, acme, tenants, store, rotated, lines } = await world();
    oauth.codes.set('code-1', REDIRECT);
    const account = await call.providerAccounts.connect(acme, {
      tenantId: tenants.acme.id,
      provider: 'digitalocean',
      name: 'do-main',
      code: 'code-1',
      redirectUri: REDIRECT,
      config: { regions: ['nyc3'] },
      idempotencyKey: 'connect-1',
    });
    expect(account).toMatchObject({ provider: 'digitalocean', name: 'do-main' });
    const ref = account.config.refreshToken as string;
    expect(ref).toMatch(new RegExp(`^secret://${tenants.acme.id}/`));
    expect(account.config.token).toBeUndefined();
    // The sealed value is the refresh token the code exchange answered.
    expect(await store.resolve(ref)).toBe('refresh-1');

    // A retry with the key replays without spending another code.
    const again = await call.providerAccounts.connect(acme, {
      tenantId: tenants.acme.id,
      provider: 'digitalocean',
      name: 'do-main',
      code: 'code-1',
      redirectUri: REDIRECT,
      config: { regions: ['nyc3'] },
      idempotencyKey: 'connect-1',
    });
    expect(again.id).toBe(account.id);
    expect(oauth.requests.filter((r) => r.url.searchParams.get('grant_type') === 'authorization_code')).toHaveLength(1);

    // The account works: its first request exchanges the refresh token, and the rotation is written over the same
    // ref, for the account's tenant.
    const check = await call.providerAccounts.check(acme, {
      tenantId: tenants.acme.id,
      accountId: account.id,
    });
    expect(check).toMatchObject({ provider: 'digitalocean', ok: true });
    expect(rotated.get(ref)).toEqual({ tenantId: tenants.acme.id, value: 'refresh-2' });

    const visible = JSON.stringify([account, again, check, lines]);
    for (const secret of ['refresh-1', 'refresh-2', 'access-1', 'access-2', 'client-secret-1', 'code-1'])
      expect(visible).not.toContain(secret);
  });

  it('refuses a refused code, a config naming the credential, and a provider without a flow', async () => {
    const { call, acme, tenants, oauth, fixture } = await world();
    const connect = (input: Record<string, unknown>) =>
      call.providerAccounts.connect(acme, {
        tenantId: tenants.acme.id,
        provider: 'digitalocean',
        name: 'do-x',
        code: 'nope',
        redirectUri: REDIRECT,
        config: { regions: ['nyc3'] },
        ...input,
      });
    await expect(connect({})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      connect({ config: { regions: ['nyc3'], refreshToken: `secret://${tenants.acme.id}/x` } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(connect({ redirectUri: 'http://console.example.test/cb' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    // A config the account check refuses after the exchange: the sealed refresh token is deleted again.
    oauth.codes.set('code-2', REDIRECT);
    await expect(connect({ code: 'code-2', config: { regions: [] } })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const sealed = await fixture.database.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM sealed_secrets WHERE tenant_id = $1',
      [tenants.acme.id],
    );
    expect(sealed.rows[0]!.n).toBe(0);
    expect((await call.providerAccounts.list(acme, { tenantId: tenants.acme.id })).items).toEqual([]);

    const bare = await world({ redirectUris: [] });
    await expect(
      bare.call.providerAccounts.connectSetup(bare.acme, {
        tenantId: bare.tenants.acme.id,
        provider: 'digitalocean',
        redirectUri: REDIRECT,
        state: 'state-0123456789abcdef',
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

describe('rotateInto', () => {
  it("writes the rotated refresh token over the account's own ref, for its tenant", async () => {
    const puts: unknown[] = [];
    const rotate = rotateInto({
      put: async (tenantId, value, putOptions) => {
        puts.push({ tenantId, value, putOptions });
        return putOptions!.ref!;
      },
    });
    await rotate({ ref: 'secret://acme/sec_1' as never, value: 'refresh-9', tenantId: 'acme' });
    expect(puts).toEqual([
      { tenantId: 'acme', value: 'refresh-9', putOptions: { ref: 'secret://acme/sec_1' } },
    ]);
  });
});
