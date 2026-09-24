import { afterEach, describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import {
  createImdsTokenService,
  createWorkloadIssuer,
  imdsSessionHeader,
  imdsSessionTtlHeader,
} from '@better-compute/pki';
import { closeIamFixtures, iamFixture } from './support/iam.js';

// Workload identity (PLAN.md §12.2, v0.5): compute-issued OIDC tokens exchanged at better-iam's
// sts/assumeRoleWithWebIdentity under a trust the workload's tenant admin created, key rotation that
// never breaks issued tokens, and the IMDS token exchange bound to one instance.

afterEach(closeIamFixtures);

const ISSUER = 'https://workload.compute.test';
const AUDIENCE = 'https://iam.acme.test';

const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
const header = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());

describe('workload tokens', () => {
  it('carry sub t:<tenant>:instance:<id>, a unique jti and at most 15 minutes', () => {
    const clock = manualClock(Date.UTC(2026, 8, 24, 12));
    const issuer = createWorkloadIssuer({ issuer: ISSUER, defaultAudience: AUDIENCE, clock });
    const a = issuer.issue({
      tenantId: 'ten_acme',
      instanceId: 'inst_1',
      claims: { pool: 'pool_h100' },
    });
    const b = issuer.issue({ tenantId: 'ten_acme', instanceId: 'inst_1' });
    expect(decode(a.token)).toMatchObject({
      iss: ISSUER,
      sub: 't:ten_acme:instance:inst_1',
      aud: AUDIENCE,
      tenant_id: 'ten_acme',
      instance_id: 'inst_1',
      pool: 'pool_h100',
      exp: decode(a.token).iat + 900,
    });
    expect(header(a.token)).toMatchObject({ alg: 'ES256', typ: 'JWT' });
    expect(a.jti).not.toBe(b.jti);
    expect(() => issuer.issue({ tenantId: 't', instanceId: 'i', ttlSeconds: 901 })).toThrow(
      /60 to 900/,
    );
    expect(() => issuer.issue({ tenantId: 't', instanceId: 'i', claims: { sub: 'root' } })).toThrow(
      /reserved/,
    );
    expect(() => issuer.issue({ tenantId: 't:x', instanceId: 'i' })).toThrow(/ids/);
    expect(issuer.discoveryDocument()).toMatchObject({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ['ES256'],
    });
    expect(() => createWorkloadIssuer({ issuer: 'http://x.test', defaultAudience: 'a' })).toThrow(
      /https/,
    );
    expect(() =>
      createWorkloadIssuer({ issuer: 'https://x.test:8443', defaultAudience: 'a' }),
    ).toThrow(/443/);
  });

  it('rotates without invalidating any issued token', () => {
    const clock = manualClock(Date.UTC(2026, 8, 24, 12));
    const issuer = createWorkloadIssuer({ issuer: ISSUER, defaultAudience: AUDIENCE, clock });
    const [first] = issuer.jwks().keys as { kid: string }[];
    const next = issuer.addKey();
    // Published, not yet signing.
    expect(issuer.jwks().keys).toHaveLength(2);
    expect(header(issuer.issue({ tenantId: 't', instanceId: 'i' }).token).kid).toBe(first!.kid);
    issuer.promote(next);
    expect(header(issuer.issue({ tenantId: 't', instanceId: 'i' }).token).kid).toBe(next);
    // The old key stays published until every token it signed has expired.
    expect(() => issuer.retire(first!.kid)).toThrow(/still be valid/);
    clock.advance(16 * 60_000);
    issuer.retire(first!.kid);
    expect((issuer.jwks().keys as { kid: string }[]).map((key) => key.kid)).toEqual([next]);
    expect(() => issuer.retire(next)).toThrow(/stopped signing/);
    const reloaded = createWorkloadIssuer({
      issuer: ISSUER,
      defaultAudience: AUDIENCE,
      clock,
      keys: issuer.exportKeys(),
    });
    expect(header(reloaded.issue({ tenantId: 't', instanceId: 'i' }).token).kid).toBe(next);
  });

  it('are exchanged at better-iam for a role session under the tenant admin’s trust', async () => {
    const issuer = createWorkloadIssuer({ issuer: ISSUER, defaultAudience: AUDIENCE });
    const f = await iamFixture({ sts: { webIdentity: { enabled: true } } } as never);
    const api = f.iam.api as never as {
      oidcProviders: { create(c: unknown, i: unknown): Promise<{ id: string }> };
      serviceAccounts: { create(c: unknown, i: unknown): Promise<{ id: string }> };
      roles: { create(c: unknown, i: unknown): Promise<{ id: string }> };
      trust: { create(c: unknown, i: unknown): Promise<{ id: string }> };
      sts: {
        assumeRoleWithWebIdentity(i: unknown): Promise<{ token: string; webIdentity: unknown }>;
      };
    };
    // Static JWKS until U6; jwksUri on a public https:443 host otherwise (§12.2).
    const provider = await api.oidcProviders.create(f.ownerCredential, {
      tenantId: f.tenantId,
      name: 'better-compute workloads',
      issuer: ISSUER,
      audiences: [AUDIENCE],
      jwks: issuer.jwks(),
      algorithms: ['ES256'],
    });
    const account = await api.serviceAccounts.create(f.ownerCredential, {
      tenantId: f.tenantId,
      name: 'gpu-jobs',
    });
    const role = await api.roles.create(f.ownerCredential, {
      tenantId: f.tenantId,
      name: 'Workloads',
      document: {
        version: 1,
        statements: [{ effect: 'allow', actions: ['compute:usage:read'], resources: ['*'] }],
      },
    });
    const trust = await api.trust.create(f.ownerCredential, {
      tenantId: f.tenantId,
      kind: 'web-identity',
      providerId: provider.id,
      serviceAccountId: account.id,
      roleId: role.id,
      conditions: { StringLike: { 'token.sub': `t:${f.tenantId}:*` } },
    });
    const exchange = (webIdentityToken: string) =>
      api.sts.assumeRoleWithWebIdentity({
        tenantId: f.tenantId,
        trustId: trust.id,
        webIdentityToken,
        sessionName: 'inst-run',
      });
    const token = issuer.issue({ tenantId: f.tenantId, instanceId: 'inst_1' }).token;
    const credential = await exchange(token);
    expect(credential.webIdentity).toEqual({
      providerId: provider.id,
      issuer: ISSUER,
      subject: `t:${f.tenantId}:instance:inst_1`,
    });
    await expect(f.iam.authenticate({ token: credential.token })).resolves.toBeDefined();
    // Single use; another tenant's instance does not match the trust.
    await expect(exchange(token)).rejects.toMatchObject({ code: 'WEB_IDENTITY_REJECTED' });
    await expect(
      exchange(issuer.issue({ tenantId: 'ten_other', instanceId: 'inst_2' }).token),
    ).rejects.toMatchObject({
      code: 'WEB_IDENTITY_REJECTED',
    });
    // A token from a key the provider was never told about is refused.
    const rogue = createWorkloadIssuer({ issuer: ISSUER, defaultAudience: AUDIENCE });
    await expect(
      exchange(rogue.issue({ tenantId: f.tenantId, instanceId: 'inst_1' }).token),
    ).rejects.toMatchObject({
      code: 'WEB_IDENTITY_REJECTED',
    });
  });
});

describe('IMDS token exchange', () => {
  const setup = () => {
    const issuer = createWorkloadIssuer({ issuer: ISSUER, defaultAudience: AUDIENCE });
    const imds = createImdsTokenService({ issuer, audiences: ['https://other.test'] });
    const a = { tenantId: 'ten_acme', instanceId: 'inst_a' };
    const b = { tenantId: 'ten_acme', instanceId: 'inst_b' };
    const session = async (instance: typeof a) =>
      (
        await imds.handler(
          new Request('http://169.254.169.254/latest/api/token', {
            method: 'PUT',
            headers: { [imdsSessionTtlHeader]: '300' },
          }),
          instance,
        )
      ).text();
    const identity = (
      instance: typeof a,
      sessionToken: string,
      query = '',
      headers: Record<string, string> = {},
    ) =>
      imds.handler(
        new Request(`http://169.254.169.254/latest/identity-token${query}`, {
          headers: { [imdsSessionHeader]: sessionToken, ...headers },
        }),
        instance,
      );
    return { imds, a, b, session, identity };
  };

  it('issues a workload token for the instance that holds the session token', async () => {
    const { a, session, identity } = setup();
    const response = await identity(a, await session(a));
    expect(response.status).toBe(200);
    expect(decode(await response.text())).toMatchObject({
      sub: 't:ten_acme:instance:inst_a',
      aud: AUDIENCE,
    });
    const other = await identity(a, await session(a), '?audience=https://other.test');
    expect(decode(await other.text()).aud).toBe('https://other.test');
    expect((await identity(a, await session(a), '?audience=https://evil.test')).status).toBe(400);
  });

  it('refuses cross-instance session tokens, missing sessions, GET token requests and forwarded requests', async () => {
    const { imds, a, b, session, identity } = setup();
    // PLAN.md v0.5 exit test: IMDS cross-instance access fails.
    expect((await identity(b, await session(a))).status).toBe(401);
    expect((await identity(a, '')).status).toBe(401);
    expect((await identity(a, `${Math.floor(Date.now() / 1000) + 300}.forged`)).status).toBe(401);
    expect(
      (await imds.handler(new Request('http://169.254.169.254/latest/api/token'), a)).status,
    ).toBe(405);
    expect(
      (await identity(a, await session(a), '', { 'x-forwarded-for': '10.0.0.9' })).status,
    ).toBe(403);
    expect(
      (
        await imds.handler(
          new Request('http://169.254.169.254/latest/api/token', {
            method: 'PUT',
            headers: { [imdsSessionTtlHeader]: '99999' },
          }),
          a,
        )
      ).status,
    ).toBe(400);
  });
});
