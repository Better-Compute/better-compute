import { afterEach, describe, expect, it } from 'vitest';
import { watchAuthorizer } from '@better-compute/cli';
import { handleWatch } from '@better-compute/events';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';

// `GET /watch` streams a tenant's events, so it is decided like `events.list` (compute:events:read on
// compute-tenant/{t}), not merely "signed in": a tenant member without the grant is refused before a stream opens.

let compute: BetterCompute<any, any> | undefined;
let iam: EmbeddedTestIam | undefined;
afterEach(async () => {
  await compute?.stop().catch(() => undefined);
  await iam?.close();
  compute = iam = undefined;
});

describe('watchAuthorizer', () => {
  it('lets a caller watch only tenants it may read events of', { timeout: 60_000 }, async () => {
    iam = await createEmbeddedTestIam({ now: () => Date.now() });
    compute = betterCompute({
      database: pglite(),
      iam: iam.port,
      secret: 'watch-authorizer-test-secret-0123456789abcdef',
      baseURL: 'http://127.0.0.1:3000',
      modules: [...iam.bridge.modules],
    } as any);
    await compute.initialize();
    const sql = compute.context.sql;
    const watch = async (token: string | undefined, query = '') => {
      const controller = new AbortController();
      const response = await handleWatch(
        new Request(`http://127.0.0.1:3000/watch${query}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        }),
        { sql, authorize: watchAuthorizer(compute!), pollMs: 20 },
      );
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
      return response.status;
    };
    const tokenOf = (credential: { token?: string }) => credential.token!;
    const acme = iam.acme;

    const nobody = await acme.member('nobody');
    const reader = await acme.member('reader');
    await acme.grant(reader.identityId, {
      version: 1,
      statements: [{ effect: 'allow', actions: ['compute:events:read'], resources: ['compute-tenant/*'] }],
    });

    expect(await watch(undefined)).toBe(401);
    // Signed in, but no compute:events:read: refused (this is what authenticating alone let through).
    expect(await watch(tokenOf(nobody.credential))).toBe(403);
    expect(await watch(tokenOf(reader.credential))).toBe(200);
    expect(await watch(tokenOf(reader.credential), `?tenantId=${acme.tenantId}`)).toBe(200);
    // Another tenant's events: refused by the envelope's tenant pre-check.
    expect(await watch(tokenOf(reader.credential), `?tenantId=${iam.other.tenantId}`)).toBe(403);
    // The root administrator may watch any tenant.
    expect(await watch(tokenOf(iam.root.credential), `?tenantId=${acme.tenantId}`)).toBe(200);
  });
});
