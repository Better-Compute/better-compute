import { afterEach, describe, expect, it } from 'vitest';
import { isComputeError, type Credential, type UsageEvent } from '@better-compute/core';
import { credentialHeaders, remoteIam, type ProjectionRow } from '@better-compute/iam';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';

// remoteIam(): the IamPort over better-iam's HTTP API (PLAN.md §12.1 remote column, v0.4), against a real
// deployment's handler. The IAM host still carries compute's plugin and resolver, as computeIamHost does.

const open: EmbeddedTestIam[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
});

async function setup() {
  const t = await createEmbeddedTestIam({ inbox: 'memory' });
  open.push(t);
  const rows: ProjectionRow[] = [
    ...Array.from({ length: 60 }, (_, index) => ({
      type: 'pool',
      id: `pool-${index}`,
      tenantId: t.acme.tenantId,
      attributes: {},
    })),
    { type: 'reservation', id: 'draft-1', tenantId: t.acme.tenantId, attributes: { gpuCount: 2 } },
  ];
  t.bridge.projection.setSource({
    load: async () => ({ rows, cursor: { txid: '0', seq: '0' } }),
    changes: async (cursor) => ({ changed: [], rows: [], cursor }),
    get: async () => undefined,
  });
  await t.bridge.projection.load();
  const port = remoteIam({
    baseURL: 'http://localhost:3000',
    fetch: async (input, init) => t.iam.handler(new Request(input, init)),
    serviceToken: () => t.root.credential.token!,
    rootTenantId: t.root.tenantId,
  });
  return { t, port };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected a rejection');
};

describe('remoteIam', () => {
  it('authenticates and decides as the caller, forwarding its credential per call', async () => {
    const { t, port } = await setup();
    const alice = await t.acme.member('alice');
    await t.acme.grant(alice.identityId, {
      version: 1,
      statements: [
        { effect: 'allow', actions: ['compute:pools:read'], resources: ['compute-pool/*'] },
      ],
    });
    expect(await port.authenticate(alice.credential)).toEqual({
      identityId: alice.identityId,
      identityKind: 'user',
      tenantId: t.acme.tenantId,
      sessionId: expect.any(String),
      sessionKind: 'user',
      mfa: false,
    });
    expect(
      await port.authenticate({ headers: { authorization: `Bearer ${alice.credential.token}` } }),
    ).toMatchObject({ identityId: alice.identityId });
    expect(await failure(port.authenticate({ token: 'biam_ses_nope' }))).toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(await failure(port.authenticate({}))).toMatchObject({ code: 'UNAUTHENTICATED' });

    const decision = (action: string, id = 'pool-1', type = 'compute-pool') => ({
      tenantId: t.acme.tenantId,
      action,
      resource: { type, id },
    });
    await expect(
      port.require(alice.credential, decision('compute:pools:read')),
    ).resolves.toBeUndefined();
    expect(
      await failure(port.require(alice.credential, decision('compute:pools:manage'))),
    ).toMatchObject({
      code: 'ACCESS_DENIED',
      status: 403,
    });
    expect(await port.authorize(alice.credential, decision('compute:pools:manage'))).toBe(false);
    expect(
      await failure(port.require(alice.credential, decision('compute:pools:read', 'absent'))),
    ).toMatchObject({
      code: 'NOT_FOUND',
    });
    const checks = Array.from({ length: 60 }, (_, index) => ({
      action: index % 3 ? 'compute:pools:read' : 'compute:pools:manage',
      resource: { type: 'compute-pool', id: `pool-${index}` },
    }));
    const answers = await port.authorizeMany(alice.credential, t.acme.tenantId, checks);
    expect(answers.every((allowed, index) => allowed === index % 3 > 0)).toBe(true);
  });

  it('asks for delegated confirmation over HTTP, reusing a pending request', async () => {
    const { t, port } = await setup();
    const alice = await t.acme.member('alice');
    await t.acme.grant(alice.identityId, {
      version: 1,
      statements: [
        {
          effect: 'allow',
          actions: ['compute:reservations:*'],
          resources: ['compute-reservation/*'],
        },
      ],
    });
    const agent = await t.iam.api.agents.create(t.acme.owner, {
      tenantId: t.acme.tenantId,
      name: 'Scheduler',
      model: 'claude-sonnet-5',
    });
    const key = await t.iam.api.credentials.create(t.acme.owner, {
      tenantId: t.acme.tenantId,
      identityId: agent.id,
    });
    const delegation = await t.iam.api.delegations.grant(alice.credential, {
      tenantId: t.acme.tenantId,
      agentId: agent.id,
      scopes: ['compute:reservations:*'],
      confirm: ['compute:reservations:create'],
    });
    const acting: Credential = {
      token: (
        await t.iam.api.delegations.assume(
          { token: key.token },
          { tenantId: t.acme.tenantId, delegationId: delegation.id },
        )
      ).token,
    };
    expect(await port.authenticate(acting)).toMatchObject({
      sessionKind: 'delegated',
      agentId: agent.id,
    });
    const ask = (action: string) =>
      port.requestConfirmation(acting, {
        tenantId: t.acme.tenantId,
        action,
        resource: { type: 'compute-reservation', id: 'draft-1' },
        reason: 'Nightly run',
      });
    expect(await ask('compute:reservations:read')).toBe('not-held-back');
    const first = await ask('compute:reservations:create');
    expect(first).toEqual({ confirmationId: expect.any(String), expiresAt: expect.any(Number) });
    expect(await ask('compute:reservations:create')).toEqual(first);
  });

  it('reads flags and records usage with the service credential', async () => {
    const { t, port } = await setup();
    expect(await port.featureEnabled(t.acme.tenantId, 'compute.h100')).toBe(false);
    await t.iam.api.features.create(t.root.credential, {
      tenantId: t.root.tenantId,
      key: 'compute.h100',
      defaultValue: true,
    });
    port.flags.invalidate();
    // Root administrators may evaluate any tenant's flags (the plan's "(verify endpoint)").
    expect(await port.featureEnabled(t.acme.tenantId, 'compute.h100')).toBe(true);

    await t.iam.api.billing.createMeter(t.root.credential, {
      tenantId: t.root.tenantId,
      key: 'gpu.h100.hours',
      name: 'H100 hours',
      unit: 'hour',
    });
    const bob = await t.acme.member('bob');
    const usage = (window: number, extra: Partial<UsageEvent> = {}): UsageEvent => ({
      tenantId: t.acme.tenantId,
      meter: 'gpu.h100.hours',
      quantity: 2,
      identityId: bob.identityId,
      occurredAt: t.now() - 3_600_000,
      tags: { pool: 'pool-1' },
      idempotencyKey: `cmp:alloc-r:${window}`,
      ...extra,
    });
    const results = await port.recordUsage([
      usage(0),
      usage(1),
      usage(2, { meter: 'gpu.nope.hours' }),
      usage(0),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'recorded',
      'recorded',
      'dead-lettered',
      'duplicate',
    ]);
    expect((await port.recordUsage([usage(1)]))[0]!.status).toBe('duplicate');
    // The service account's own tenant can be checked; better-iam 0.1.0 has no HTTP check for other tenants.
    expect(await port.billingCheck({ tenantId: t.root.tenantId })).toMatchObject({ allowed: true });
  });

  it('validates its options and presented credentials', () => {
    expect(() => remoteIam({ baseURL: 'http://x', serviceToken: 't', rootTenantId: '' })).toThrow(
      /root tenant/,
    );
    expect(() =>
      remoteIam({ baseURL: 'http://x', serviceToken: 't', rootTenantId: 'r', usageBatchSize: 101 }),
    ).toThrow(/usageBatchSize/);
    const headers = new Headers(
      credentialHeaders({ token: 'abc', headers: { 'x-request-id': '1' } }),
    );
    expect(headers.get('authorization')).toBe('Bearer abc');
    expect(headers.get('x-request-id')).toBe('1');
    expect(new Headers(credentialHeaders({ headers: { cookie: 'session=1' } })).get('cookie')).toBe(
      'session=1',
    );
    expect(() => credentialHeaders({})).toThrow(/No credential/);
    // The incoming request's framing headers never reach IAM's (different) request.
    const forwarded = new Headers(
      credentialHeaders({
        headers: {
          authorization: 'Bearer from-request',
          'content-length': '999',
          'content-type': 'text/plain',
          host: 'compute.example.com',
          'x-forwarded-for': '203.0.113.7',
        },
      }),
    );
    expect([...forwarded.keys()].sort()).toEqual(['authorization', 'x-forwarded-for']);
  });
});
