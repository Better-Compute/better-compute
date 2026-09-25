import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Credential, SqlExecutor } from '@better-compute/core';
import { examplePolicies, sqlProjectionSource, type ProjectionSource } from '@better-compute/iam';
import {
  TEST_COMPUTE_AUDIENCE,
  createEmbeddedTestIam,
  type EmbeddedTestIam,
} from '@better-compute/iam/testing';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';

// PLAN.md §16 v0.1 security negative "a resolver timeout denies; a failed authorizeMany fails the list", end to
// end: the compute server, a real embedded better-iam, and compute's resolver inside IAM's decision. A row missing
// from the in-memory projection costs one bounded read; when that read stalls, the call is denied promptly
// (never hangs, never allows), and a list that needs it fails as a whole instead of silently dropping it.

let t: EmbeddedTestIam;
let compute: BetterCompute<any, any>;
let database: SqlExecutor;
let poolId: string;
let alice: { identityId: string; credential: Credential };
let stall = 0;

beforeAll(async () => {
  t = await createEmbeddedTestIam({ now: () => Date.now() });
  database = pglite();
  compute = betterCompute({
    database,
    iam: t.port,
    secret: 'better-compute-resolver-timeout-secret-0123456',
    baseURL: 'http://127.0.0.1:3000',
    modules: [...t.bridge.modules],
  } as any);
  await compute.initialize();
  const root = t.root.credential;
  const site = await compute.api.sites.create(root, {
    tenantId: t.root.tenantId,
    kind: 'shared',
    region: 'eu-west-1',
    idempotencyKey: 'timeout-site',
  });
  const pool = await compute.api.pools.create(root, {
    tenantId: t.root.tenantId,
    siteId: site.id,
    class: 'metal-host',
    gpuModel: 'H100',
    idempotencyKey: 'timeout-pool',
  });
  poolId = pool.id;
  await compute.api.pools.offer(root, {
    tenantId: t.root.tenantId,
    poolId,
    toTenantId: t.acme.tenantId,
    quota: { gpu: 8 },
  });
  alice = await t.acme.member('alice');
  const documents = examplePolicies({ audience: TEST_COMPUTE_AUDIENCE }).map((p) => p.document);
  await t.acme.grant(alice.identityId, ...(documents as never[]));
  await t.acme.share('compute-pool', poolId, 'user', { identityId: alice.identityId });

  // The same store, with a switch that stalls single-row reads (the miss path) for `stall` ms.
  const real = sqlProjectionSource(database);
  const source: ProjectionSource = {
    load: () => real.load(),
    changes: (cursor, limit) => real.changes(cursor, limit),
    async get(type, id, tenantId) {
      if (stall > 0) await new Promise((resolve) => setTimeout(resolve, stall));
      return real.get(type, id, tenantId);
    },
  };
  t.bridge.projection.setSource(source);
  await t.bridge.projection.load();
}, 120_000);

afterAll(async () => {
  await compute?.stop();
  await t?.close();
  await database?.close();
});

const get = () =>
  compute.api.pools.get(alice.credential, { tenantId: t.acme.tenantId, poolId } as never);
const list = () => compute.api.pools.list(alice.credential, { tenantId: t.acme.tenantId } as never);

describe('a resolver timeout denies, end to end', () => {
  it('serves from memory, denies promptly when the miss read stalls, and recovers', async () => {
    expect(await get()).toMatchObject({ id: poolId });
    expect((await list()).items.map((item: { id: string }) => item.id)).toContain(poolId);

    // The row falls out of memory and its read stalls far past the 20 ms budget. (Read decisions are cached
    // for 10 s by the server; drop them so IAM decides again.)
    const forget = () => {
      compute.caches.dropDecisions();
      t.bridge.projection.remove('pool', poolId);
    };
    forget();
    stall = 2_000;
    const started = Date.now();
    await expect(get()).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(Date.now() - started).toBeLessThan(1_500);

    // A list that needs the row fails as a whole: it never answers without it.
    forget();
    await expect(list()).rejects.toMatchObject({
      code: expect.stringMatching(/ACCESS_DENIED|UNAVAILABLE|INTERNAL_ERROR/),
    });

    // The read is fast again: the miss path loads the row and the decision allows.
    stall = 0;
    forget();
    expect(await get()).toMatchObject({ id: poolId });
    expect(t.bridge.projection.size).toBeGreaterThan(0);
  }, 60_000);
});
