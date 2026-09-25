import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Credential, SqlExecutor } from '@better-compute/core';
import { examplePolicies } from '@better-compute/iam';
import {
  TEST_COMPUTE_AUDIENCE,
  createEmbeddedTestIam,
  type EmbeddedTestIam,
} from '@better-compute/iam/testing';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';

// PLAN.md §12.6 + §16 v0.1 acceptance ("ReserveBoundedH100 allows 8 GPUs and denies 9, and
// BoundedExtend denies 72 h + 1 h") and the delegated-small guardrail, end to end: the compute
// server writes each draft's attributes (gpuModel, region, gpuCount, durationHours, owner, parent
// pool) and embedded better-iam evaluates the gpu-user and agent-guardrails policies verbatim on them.
// tests/iam-contract.test.ts checks the same policies against hand-written attributes.

const NODE = 'node_01k5w00000000000000000pol1';
const hours = (n: number) => n * 3_600_000;

let t: EmbeddedTestIam;
let compute: BetterCompute<any, any>;
let database: SqlExecutor;
let poolId: string;
let alice: { identityId: string; credential: Credential };
let bob: { identityId: string; credential: Credential };
let agent: Credential;
let keys = 0;

beforeAll(async () => {
  t = await createEmbeddedTestIam({ now: () => Date.now() });
  database = pglite();
  compute = betterCompute({
    database,
    iam: t.port,
    secret: 'better-compute-policies-e2e-secret-0123456789ab',
    baseURL: 'http://127.0.0.1:3000',
    modules: [...t.bridge.modules],
  } as any);
  await compute.initialize();

  const root = t.root.credential;
  const site = await compute.api.sites.create(root, {
    tenantId: t.root.tenantId,
    kind: 'shared',
    region: 'eu-west-1',
    idempotencyKey: 'policies-site',
  });
  const pool = await compute.api.pools.create(root, {
    tenantId: t.root.tenantId,
    siteId: site.id,
    class: 'metal-host',
    gpuModel: 'H100',
    idempotencyKey: 'policies-pool',
  });
  poolId = pool.id;
  await compute.api.pools.offer(root, {
    tenantId: t.root.tenantId,
    poolId,
    toTenantId: t.acme.tenantId,
    quota: { gpu: 32 },
  });
  await database.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
                        cordoned, connectivity, trust, generation, observed_generation, next_cmd_seq,
                        identity_gen, shard, version)
     VALUES ($1, $2, $3, $4, 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
    [NODE, site.id, poolId, t.root.tenantId],
  );
  for (let index = 0; index < 32; index++)
    await database.query(
      `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
       VALUES ($1, $2, 'gpu', true, true, '{"gpuModel":"H100","gpuProduct":"H100-SXM5-80GB"}')`,
      [`GPU-policies-${String(index).padStart(4, '0')}`, NODE],
    );
  // ReserveBoundedH100 needs the tenant flag.
  await t.iam.api.features.create(root, {
    tenantId: t.root.tenantId,
    key: 'compute.h100',
    defaultValue: true,
  });

  // alice and bob hold §12.6's policies verbatim; only alice is a user of the pool.
  alice = await t.acme.member('alice');
  bob = await t.acme.member('bob');
  const documents = examplePolicies({ audience: TEST_COMPUTE_AUDIENCE }).map((p) => p.document);
  await t.acme.grant(alice.identityId, ...(documents as never[]));
  await t.acme.grant(bob.identityId, ...(documents as never[]));
  await t.acme.share('compute-pool', poolId, 'user', { identityId: alice.identityId });

  // An agent acting for alice, with no confirm list: only the guardrails stand in its way.
  const trainer = await t.iam.api.agents.create(t.acme.owner, {
    tenantId: t.acme.tenantId,
    name: 'Trainer',
    model: 'claude-sonnet-5',
  });
  const key = await t.iam.api.credentials.create(t.acme.owner, {
    tenantId: t.acme.tenantId,
    identityId: trainer.id,
  });
  const delegation = await t.iam.api.delegations.grant(alice.credential, {
    tenantId: t.acme.tenantId,
    agentId: trainer.id,
    scopes: ['compute:pools:read', 'compute:reservations:*'],
  });
  agent = {
    token: (
      await t.iam.api.delegations.assume(
        { token: key.token },
        { tenantId: t.acme.tenantId, delegationId: delegation.id },
      )
    ).token,
  };
}, 120_000);

afterAll(async () => {
  await compute?.stop();
  await t?.close();
});

const reserve = (who: Credential, gpus: number, durationHours: number) =>
  compute.api.reservations.create(who, {
    tenantId: t.acme.tenantId,
    poolId,
    devices: [{ class: 'gpu', count: gpus }],
    duration: hours(durationHours),
    idempotencyKey: `policies-${++keys}`,
  });
const extend = (who: Credential, reservationId: string, byHours: number) =>
  compute.api.reservations.extend(who, {
    tenantId: t.acme.tenantId,
    reservationId,
    by: `${byHours}h`,
    idempotencyKey: `policies-${++keys}`,
  });
const release = (who: Credential, reservationId: string) =>
  compute.api.reservations.release(who, { tenantId: t.acme.tenantId, reservationId });
const denied = { code: 'ACCESS_DENIED' };

describe('§12.6 example policies on real drafts', () => {
  it('ReserveBoundedH100 allows 8 GPUs for 72 h and denies 9 GPUs or 73 h', async () => {
    const eight = await reserve(alice.credential, 8, 72);
    expect(eight).toMatchObject({ state: 'placed' });
    await release(alice.credential, eight.id);
    await expect(reserve(alice.credential, 9, 1)).rejects.toMatchObject(denied);
    await expect(reserve(alice.credential, 1, 73)).rejects.toMatchObject(denied);
  }, 60_000);

  it('BoundedExtend allows up to 72 h in total and denies 72 h + 1 h', async () => {
    const reservation = await reserve(alice.credential, 2, 70);
    await expect(extend(alice.credential, reservation.id, 2)).resolves.toBeDefined();
    await expect(extend(alice.credential, reservation.id, 1)).rejects.toMatchObject(denied);
    await release(alice.credential, reservation.id);
  }, 60_000);

  it('SeeSharedPools: a member who is not a user of the pool cannot reserve from it', async () => {
    await expect(reserve(bob.credential, 1, 1)).rejects.toMatchObject(denied);
  }, 60_000);

  it('OwnReservations: another member can neither read nor release alice’s reservation', async () => {
    const reservation = await reserve(alice.credential, 1, 1);
    await expect(
      compute.api.reservations.get(bob.credential, {
        tenantId: t.acme.tenantId,
        reservationId: reservation.id,
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/ACCESS_DENIED|NOT_FOUND/) });
    await expect(release(bob.credential, reservation.id)).rejects.toMatchObject({
      code: expect.stringMatching(/ACCESS_DENIED|NOT_FOUND/),
    });
    await release(alice.credential, reservation.id);
  }, 60_000);

  it('DelegatedSmall: alice’s agent reserves and extends 4 GPUs, never 5', async () => {
    const four = await reserve(agent, 4, 1);
    expect(four).toMatchObject({ state: 'placed' });
    await expect(extend(agent, four.id, 1)).resolves.toBeDefined();
    await expect(reserve(agent, 5, 1)).rejects.toMatchObject(denied);
    // alice herself holds 5 GPUs; her agent may not extend them, she may.
    const five = await reserve(alice.credential, 5, 1);
    await expect(extend(agent, five.id, 1)).rejects.toMatchObject(denied);
    await expect(extend(alice.credential, five.id, 1)).resolves.toBeDefined();
    await release(agent, four.id);
    await release(alice.credential, five.id);
  }, 60_000);
});
