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
import { connectStageMs, connectStaging, vps } from '@better-compute/vps';
import { oauthStateOf } from '@better-compute/provider-digitalocean';
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
    expect(
      oauth.requests.filter((r) => r.params.get('grant_type') === 'authorization_code'),
    ).toHaveLength(1);

    // The account works: its first request exchanges the refresh token, and the rotation is written over the same
    // ref, for the account's tenant.
    const check = await call.providerAccounts.check(acme, {
      tenantId: tenants.acme.id,
      accountId: account.id,
    });
    expect(check).toMatchObject({ provider: 'digitalocean', ok: true });
    expect(rotated.get(ref)).toEqual({ tenantId: tenants.acme.id, value: 'refresh-2' });

    const visible = JSON.stringify([account, again, check, lines]);
    for (const secret of [
      'refresh-1',
      'refresh-2',
      'access-1',
      'access-2',
      'client-secret-1',
      'code-1',
    ])
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
    expect((await call.providerAccounts.list(acme, { tenantId: tenants.acme.id })).items).toEqual(
      [],
    );

    // The exchange and the account check pass, then storing fails (the name is taken): the sealed refresh token is
    // deleted again, and only the stored account's credential stays sealed.
    oauth.codes.set('code-3', REDIRECT);
    const first = await connect({ code: 'code-3', name: 'do-taken' });
    oauth.codes.set('code-4', REDIRECT);
    await expect(connect({ code: 'code-4', name: 'do-taken' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(oauth.requests.filter((r) => r.params.get('code') === 'code-4')).toHaveLength(1);
    const left = await fixture.database.query<{ ref: string }>(
      'SELECT ref FROM sealed_secrets WHERE tenant_id = $1',
      [tenants.acme.id],
    );
    expect(left.rows.map((row) => row.ref)).toEqual([first.config.refreshToken]);

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

describe('the sealed credential of a connected account (owned by vps)', () => {
  const connectInput = (tenantId: string, code: string, name = 'do-main') => ({
    tenantId,
    provider: 'digitalocean',
    name,
    code,
    redirectUri: REDIRECT,
    config: { regions: ['nyc3'] },
  });
  const sealedRefs = async (fixture: any, tenantId: string): Promise<string[]> =>
    (
      await fixture.database.query(
        'SELECT ref FROM sealed_secrets WHERE tenant_id = $1 ORDER BY ref',
        [tenantId],
      )
    ).rows.map((row: { ref: string }) => row.ref);
  const markers = async (fixture: any): Promise<string[]> =>
    (
      await fixture.database.query('SELECT ref FROM provider_connect_secrets ORDER BY ref')
    ).rows.map((row: { ref: string }) => row.ref);

  it('deleting the account revokes the grant, deletes the sealed refresh token and forgets the cached token', async () => {
    const { oauth, call, acme, tenants, fixture, api, lines } = await world();
    oauth.codes.set('code-1', REDIRECT);
    const account = await call.providerAccounts.connect(
      acme,
      connectInput(tenants.acme.id, 'code-1'),
    );
    const ref = account.config.refreshToken as string;
    expect(await markers(fixture)).toEqual([ref]);
    await call.providerAccounts.check(acme, { tenantId: tenants.acme.id, accountId: account.id });
    expect(oauthStateOf(ref as never).accessToken).toBe(true);
    expect(api.validTokens.has('access-2')).toBe(true);

    await call.providerAccounts.delete(acme, { tenantId: tenants.acme.id, accountId: account.id });
    // The delete enqueued the sweep: it runs now, not in five minutes.
    expect(await sealedRefs(fixture, tenants.acme.id)).toEqual([ref]);
    await fixture.compute.jobs['vps.connect-secrets']!.tick();
    expect(await sealedRefs(fixture, tenants.acme.id)).toEqual([]);
    // The stored refresh token and the access token in use are revoked at DigitalOcean.
    expect(oauth.revoked).toEqual(['refresh-1', 'access-2']);
    expect(api.validTokens.has('access-2')).toBe(false);
    expect(oauthStateOf(ref as never)).toEqual({
      accessToken: false,
      unwritten: false,
      suspect: false,
    });
    expect(await markers(fixture)).toEqual([]);
    for (const secret of ['refresh-1', 'refresh-2', 'access-2', 'client-secret-1'])
      expect(JSON.stringify(lines)).not.toContain(secret);
  });

  it('a revoke DigitalOcean refuses is logged without a token, and the credential is deleted anyway', async () => {
    const { oauth, call, acme, tenants, fixture, lines } = await world();
    oauth.codes.set('code-1', REDIRECT);
    const account = await call.providerAccounts.connect(
      acme,
      connectInput(tenants.acme.id, 'code-1'),
    );
    const ref = account.config.refreshToken as string;
    await call.providerAccounts.check(acme, { tenantId: tenants.acme.id, accountId: account.id });
    // DigitalOcean's revoke endpoint is down.
    oauth.revokeStatus = 503;
    await call.providerAccounts.delete(acme, { tenantId: tenants.acme.id, accountId: account.id });
    await fixture.compute.jobs['vps.connect-secrets']!.tick();
    expect(oauth.revoked).toEqual([]);
    expect(await sealedRefs(fixture, tenants.acme.id)).toEqual([]);
    expect(await markers(fixture)).toEqual([]);
    expect(oauthStateOf(ref as never).accessToken).toBe(false);
    const warned = lines.filter((line) => line.includes('did not revoke'));
    expect(warned).toHaveLength(1);
    for (const secret of ['refresh-1', 'access-2', 'client-secret-1'])
      expect(JSON.stringify(lines)).not.toContain(secret);
  });

  it('a credential another account also names is kept', async () => {
    const { oauth, call, acme, tenants, fixture } = await world();
    oauth.codes.set('code-1', REDIRECT);
    const account = await call.providerAccounts.connect(
      acme,
      connectInput(tenants.acme.id, 'code-1'),
    );
    const ref = account.config.refreshToken as string;
    // A second account stored by hand with the same ref (rows, not the API: the API would exchange it).
    await fixture.database.query(
      `INSERT INTO provider_accounts (id, tenant_id, provider, name, config, version)
       VALUES ('pacct_twin', $1, 'digitalocean', 'twin', $2::jsonb, 1)`,
      [tenants.acme.id, JSON.stringify({ ...account.config })],
    );
    await call.providerAccounts.delete(acme, { tenantId: tenants.acme.id, accountId: account.id });
    await fixture.compute.jobs['vps.connect-secrets']!.tick();
    expect(await sealedRefs(fixture, tenants.acme.id)).toEqual([ref]);
    expect(oauth.revoked).toEqual([]);
  });

  it('a sealed credential no account claimed (a restart between check and handler) is revoked and deleted by vps.connect-secrets', async () => {
    const { oauth, call, acme, tenants, fixture, store } = await world();
    // What a connect check leaves behind when the process stops before the handler: a sealed refresh token and its
    // marker, and nothing in memory.
    oauth.refreshTokens.add('refresh-orphan');
    const ref = await store.put(tenants.acme.id, 'refresh-orphan');
    await fixture.database.query(
      `INSERT INTO provider_connect_secrets (ref, tenant_id, provider, sealed_at)
       VALUES ($1, $2, 'digitalocean', compute_now() - interval '1 hour')`,
      [ref, tenants.acme.id],
    );
    // A young one (a connect still between check and handler) is left alone.
    const young = await store.put(tenants.acme.id, 'refresh-young');
    await fixture.database.query(
      `INSERT INTO provider_connect_secrets (ref, tenant_id, provider) VALUES ($1, $2, 'digitalocean')`,
      [young, tenants.acme.id],
    );
    await fixture.compute.jobs['vps.connect-secrets']!.tick();
    expect(await sealedRefs(fixture, tenants.acme.id)).toEqual([young]);
    expect(oauth.revoked).toEqual(['refresh-orphan']);
    expect(await markers(fixture)).toEqual([young]);

    // A connect whose account is stored claims its marker: however old, the sweep never touches it.
    oauth.codes.set('code-1', REDIRECT);
    const account = await call.providerAccounts.connect(
      acme,
      connectInput(tenants.acme.id, 'code-1'),
    );
    await fixture.database.query(
      `UPDATE provider_connect_secrets SET sealed_at = compute_now() - interval '1 day'`,
    );
    await fixture.advance(6 * 60_000);
    await fixture.compute.jobs['vps.connect-secrets']!.tick();
    expect(await sealedRefs(fixture, tenants.acme.id)).toEqual([account.config.refreshToken]);
    expect(oauth.revoked).toEqual(['refresh-orphan', 'refresh-young']);
  });

  it('a caller without providers:manage reaches no code exchange and seals nothing', async () => {
    const { oauth, call, acme, tenants, fixture } = await world();
    fixture.iam.deny({ token: tenants.acme.token, action: 'compute:providers:manage' });
    oauth.codes.set('code-1', REDIRECT);
    await expect(
      call.providerAccounts.connect(acme, connectInput(tenants.acme.id, 'code-1')),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(oauth.requests).toEqual([]);
    expect(await sealedRefs(fixture, tenants.acme.id)).toEqual([]);
    expect(await markers(fixture)).toEqual([]);
    expect(oauth.codes.has('code-1')).toBe(true);
  });
});

describe('connectStaging', () => {
  const input = {
    tenantId: 't1',
    provider: 'digitalocean',
    name: 'do-main',
    code: 'code-1',
    redirectUri: REDIRECT,
    config: {},
  };
  it('finds a request by what it is, so a re-validated input (a composite) reaches it', async () => {
    let now = 0;
    const discarded: string[] = [];
    const staging = connectStaging(() => now);
    const stage = (ref: string, of = input) =>
      staging.put(of, {
        request: { tenantId: 't1', provider: 'digitalocean', name: 'do-main', config: {} },
        accountId: 'pacct_1',
        ref,
        discard: async () => void discarded.push(ref),
      });
    await stage('secret://t1/a');
    expect(staging.get({ ...input, config: {} })?.ref).toBe('secret://t1/a');
    expect(staging.get({ ...input, code: 'code-2' })).toBeUndefined();
    // The handler failed: the request's sealed credential is deleted.
    await staging.abandon({ ...input });
    expect(discarded).toEqual(['secret://t1/a']);
    expect(staging.size()).toBe(0);

    // A stored account keeps its credential.
    await stage('secret://t1/b');
    staging.done({ ...input });
    // A request that never reached its handler is discarded once it goes stale.
    await stage('secret://t1/c', { ...input, code: 'code-3' });
    now += connectStageMs + 1;
    await stage('secret://t1/d', { ...input, code: 'code-4' });
    expect(discarded).toEqual(['secret://t1/a', 'secret://t1/c']);
    expect(staging.size()).toBe(1);
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
