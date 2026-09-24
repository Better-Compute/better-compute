import { afterEach, describe, expect, it } from 'vitest';
import { IamError } from '@better-iam/core';
import { ComputeError, isComputeError, type UsageEvent } from '@better-compute/core';
import {
  embeddedIam,
  fromIamError,
  isPoisonError,
  recordUsageIsolated,
  toCaller,
  type UsageBilling,
  type UsageInputLike,
} from '@better-compute/iam';
import { closeIamFixtures, iamFixture, type IamFixture } from './support/iam.js';

// embeddedIam(): the IamPort compute sees, over a real (vendored) better-iam (PLAN.md §12.1, §12.7).

afterEach(closeIamFixtures);

async function rejection(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

/** An agent with its own key, and a delegated session of alice's that holds reservations:create back. */
async function agents(f: IamFixture) {
  const alice = await f.member('alice');
  const aliceSession = await f.signIn('alice');
  await f.grant(alice.id, {
    version: 1,
    statements: [
      {
        effect: 'allow',
        actions: ['compute:reservations:*'],
        resources: ['compute-reservation/*'],
      },
    ],
  });
  const agent = await f.iam.api.agents.create(f.ownerCredential, {
    tenantId: f.tenantId,
    name: 'Scheduler',
    model: 'claude-sonnet-5',
  });
  const key = await f.iam.api.credentials.create(f.ownerCredential, {
    tenantId: f.tenantId,
    identityId: agent.id,
  });
  const delegation = await f.iam.api.delegations.grant(aliceSession, {
    tenantId: f.tenantId,
    agentId: agent.id,
    scopes: ['compute:reservations:*'],
    confirm: ['compute:reservations:create'],
  });
  const delegated = {
    token: (
      await f.iam.api.delegations.assume(
        { token: key.token },
        { tenantId: f.tenantId, delegationId: delegation.id },
      )
    ).token,
  };
  return { alice, aliceSession, agent, agentKey: { token: key.token }, delegation, delegated };
}

describe('embeddedIam: identity and decisions', () => {
  it('maps people, agent keys and delegated sessions to Caller', async () => {
    const f = await iamFixture();
    const port = embeddedIam(f.iam, { rootTenantId: f.rootTenantId });
    expect(port.rootTenantId).toBe(f.rootTenantId);
    const { alice, aliceSession, agent, agentKey, delegation, delegated } = await agents(f);

    expect(await port.authenticate(aliceSession)).toEqual({
      identityId: alice.id,
      identityKind: 'user',
      tenantId: f.tenantId,
      sessionId: expect.any(String),
      sessionKind: 'user',
      mfa: false,
    });
    expect(
      await port.authenticate({ headers: { authorization: `Bearer ${aliceSession.token}` } }),
    ).toMatchObject({ identityId: alice.id });
    expect(await port.authenticate(agentKey)).toMatchObject({
      identityId: agent.id,
      identityKind: 'agent',
      sessionKind: 'api-key',
      agentId: agent.id,
    });
    expect(await port.authenticate(delegated)).toMatchObject({
      identityId: alice.id,
      identityKind: 'user',
      sessionKind: 'delegated',
      agentId: agent.id,
      delegationId: delegation.id,
    });
    const bad = await rejection(port.authenticate({ token: 'biam_ses_nope' }));
    expect(bad).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });

  it('decides with require/authorize, maps denials and misses to compute codes', async () => {
    const f = await iamFixture();
    const port = embeddedIam(f.iam);
    const { aliceSession } = await agents(f);
    f.project('compute-reservation', 'rsv-1');
    f.project('compute-pool', 'pool-1');
    const decision = (action: string, type: string, id: string) => ({
      tenantId: f.tenantId,
      action,
      resource: { type, id },
    });
    await expect(
      port.require(
        aliceSession,
        decision('compute:reservations:read', 'compute-reservation', 'rsv-1'),
      ),
    ).resolves.toBeUndefined();
    expect(
      await port.authorize(aliceSession, decision('compute:pools:read', 'compute-pool', 'pool-1')),
    ).toBe(false);
    const denied = await rejection(
      port.require(aliceSession, decision('compute:pools:read', 'compute-pool', 'pool-1')),
    );
    expect(denied).toMatchObject({
      code: 'ACCESS_DENIED',
      status: 403,
      details: { iamCode: 'ACCESS_DENIED' },
    });
    const missing = await rejection(
      port.require(
        aliceSession,
        decision('compute:reservations:read', 'compute-reservation', 'nope'),
      ),
    );
    expect(missing).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('chunks authorizeMany by 50 and fails the whole list on one miss (P11)', async () => {
    const f = await iamFixture();
    const port = embeddedIam(f.iam);
    const { aliceSession } = await agents(f);
    const checks = Array.from({ length: 120 }, (_, index) => {
      const id = `rsv-${index}`;
      f.project('compute-reservation', id);
      return {
        action: index % 2 ? 'compute:reservations:read' : 'compute:pools:read',
        resource: { type: 'compute-reservation', id },
      };
    });
    const answers = await port.authorizeMany(aliceSession, f.tenantId, checks);
    expect(answers).toHaveLength(120);
    expect(answers.every((allowed, index) => allowed === (index % 2 === 1))).toBe(true);
    expect(await port.authorizeMany(aliceSession, f.tenantId, [])).toEqual([]);
    const broken = [
      ...checks.slice(0, 60),
      { ...checks[0]!, resource: { type: 'compute-reservation', id: 'gone' } },
    ];
    expect(await rejection(port.authorizeMany(aliceSession, f.tenantId, broken))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('asks for delegated confirmation, or says the action is not held back', async () => {
    const f = await iamFixture();
    const port = embeddedIam(f.iam);
    const { delegated } = await agents(f);
    f.project('compute-reservation', 'draft-1', { gpuCount: 2 });
    const ask = (action: string) =>
      port.requestConfirmation(delegated, {
        tenantId: f.tenantId,
        action,
        resource: { type: 'compute-reservation', id: 'draft-1' },
        reason: 'Nightly training run',
      });
    expect(await ask('compute:reservations:read')).toBe('not-held-back');
    const asked = await ask('compute:reservations:create');
    expect(asked).toEqual({ confirmationId: expect.any(String), expiresAt: expect.any(Number) });
    // Asking again while the first request is pending reuses it.
    expect(await ask('compute:reservations:create')).toEqual(asked);
  });

  it('serves flags from the cache: one isEnabled per (tenant, key) until invalidated', async () => {
    const f = await iamFixture();
    const port = embeddedIam(f.iam);
    let calls = 0;
    const isEnabled = f.iam.features.isEnabled.bind(f.iam.features);
    f.iam.features.isEnabled = async (tenantId, key) => {
      calls++;
      return isEnabled(tenantId, key);
    };
    expect(await port.featureEnabled(f.tenantId, 'compute.h100')).toBe(false);
    await f.iam.api.features.create(f.rootCredential, {
      tenantId: f.rootTenantId,
      key: 'compute.h100',
      defaultValue: true,
    });
    expect(await port.featureEnabled(f.tenantId, 'compute.h100')).toBe(false);
    expect(calls).toBe(1);
    port.flags.invalidate({ key: 'compute.h100' });
    expect(await port.featureEnabled(f.tenantId, 'compute.h100')).toBe(true);
    expect(await port.featureEnabled(f.tenantId, 'compute.h100')).toBe(true);
    expect(calls).toBe(2);
  });

  it('checks spend and reports the upstream capabilities of better-iam 0.1.0', async () => {
    const f = await iamFixture();
    const port = embeddedIam(f.iam);
    expect(await port.billingCheck({ tenantId: f.tenantId })).toEqual({
      allowed: true,
      budgets: [],
    });
    expect(port.capabilities()).toEqual({
      pluginResolver: false,
      eventDetail: false,
      evaluate: false,
      readOnlyDecisions: false,
    });
  });
});

describe('usage with poison isolation (§12.7)', () => {
  const hour = 3_600_000;

  it('records through recordMany, re-attributes deleted identities, and dead-letters only what still fails', async () => {
    const f = await iamFixture();
    for (const key of ['gpu.h100.hours', 'node.metal.hours'])
      await f.iam.api.billing.createMeter(f.rootCredential, {
        tenantId: f.rootTenantId,
        key,
        name: key,
        unit: 'hour',
      });
    const alice = await f.member('alice');
    const bob = await f.member('bob');
    const carol = await f.member('carol');
    for (const gone of [bob, carol])
      await f.iam.api.identities.delete(f.ownerCredential, {
        tenantId: f.tenantId,
        identityId: gone.id,
      });
    const successors = new Map([[bob.id, alice.id]]);
    const port = embeddedIam(f.iam, {
      successorOf: async (_tenantId, identityId) => successors.get(identityId),
    });
    const usage = (window: number, extra: Partial<UsageEvent> = {}): UsageEvent => ({
      tenantId: f.tenantId,
      meter: 'gpu.h100.hours',
      quantity: 8,
      identityId: alice.id,
      occurredAt: f.now() - 2 * hour,
      tags: { region: 'eu-west-1', pool: 'pool-1', gpuModel: 'H100' },
      idempotencyKey: `cmp:alloc-1:${window}`,
      ...extra,
    });
    await port.recordUsage([usage(0)]);

    const results = await port.recordUsage([
      usage(0),
      usage(1),
      usage(2, { identityId: bob.id }),
      usage(3, { identityId: carol.id }),
      usage(0, { meter: 'node.metal.hours', idempotencyKey: 'cmp:alloc-1:0' }),
      usage(5, { meter: 'gpu.nope.hours' }),
      usage(6),
    ]);
    expect(results).toEqual([
      { idempotencyKey: 'cmp:alloc-1:0', status: 'duplicate' },
      { idempotencyKey: 'cmp:alloc-1:1', status: 'recorded' },
      { idempotencyKey: 'cmp:alloc-1:2', status: 'reattributed', identityId: alice.id },
      { idempotencyKey: 'cmp:alloc-1:3', status: 'reattributed' },
      {
        idempotencyKey: 'cmp:alloc-1:0',
        status: 'dead-lettered',
        error: { code: 'CONFLICT', message: 'This idempotency key was used for another meter' },
      },
      {
        idempotencyKey: 'cmp:alloc-1:5',
        status: 'dead-lettered',
        error: { code: 'NOT_FOUND', message: expect.stringMatching(/meter/i) },
      },
      { idempotencyKey: 'cmp:alloc-1:6', status: 'recorded' },
    ]);
    // Every retry is safe: the same flush again records nothing twice.
    const again = await port.recordUsage([usage(1), usage(6)]);
    expect(again.map((result) => result.status)).toEqual(['duplicate', 'duplicate']);
  });

  /** Billing that fails any batch containing a poisoned key, and counts calls. */
  function fakeBilling(poison: Set<string>, transient = false) {
    const recorded = new Set<string>();
    const calls = { many: 0, one: 0 };
    const fail = (input: UsageInputLike) => {
      if (transient) throw new Error('connect ECONNREFUSED');
      if (poison.has(input.idempotencyKey!))
        throw new IamError('BILLING_PERIOD_CLOSED', '2026-08 has already been invoiced', 409);
    };
    const billing: UsageBilling = {
      async recordMany(events) {
        calls.many++;
        events.forEach(fail);
        return events.map((event) => {
          const duplicate = recorded.has(event.idempotencyKey!);
          recorded.add(event.idempotencyKey!);
          return { duplicate };
        });
      },
      async record(event) {
        calls.one++;
        fail(event);
        return { duplicate: false };
      },
    };
    return { billing, calls, recorded };
  }
  const events = (count: number): UsageEvent[] =>
    Array.from({ length: count }, (_, index) => ({
      tenantId: 't',
      meter: 'gpu.h100.hours',
      quantity: 1,
      occurredAt: 0,
      tags: {},
      idempotencyKey: `k${index}`,
    }));

  it('bisects a poisoned batch down to the event, in batches of batchSize', async () => {
    const { billing, calls, recorded } = fakeBilling(new Set(['k37']));
    const results = await recordUsageIsolated(billing, events(100), { batchSize: 64 });
    expect(results.filter((result) => result.status === 'recorded')).toHaveLength(99);
    expect(results[37]).toMatchObject({
      status: 'dead-lettered',
      error: { code: 'BILLING_PERIOD_CLOSED' },
    });
    expect(recorded.size).toBe(99);
    // 64 → 32 → 16 → 8 → 4 → 2 → 1: log2 splits on the poisoned side, plus the clean batch of 36.
    expect(calls.many).toBeLessThanOrEqual(2 + 2 * 6);
    expect(calls.one).toBe(0);
  });

  it('rethrows transient failures untouched, and validates its input', async () => {
    const { billing } = fakeBilling(new Set(), true);
    await expect(recordUsageIsolated(billing, events(3))).rejects.toThrow('ECONNREFUSED');
    expect(isPoisonError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isPoisonError(new IamError('CONFLICT', 'x', 409))).toBe(true);
    await expect(
      recordUsageIsolated(billing, events(1), { batchSize: 1001 }),
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    await expect(
      recordUsageIsolated(billing, [{ ...events(1)[0]!, idempotencyKey: '' }]),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('toCaller', () => {
  it('uses the tenant the session acts in, and fails closed on unknown kinds', () => {
    const principal = {
      identity: { id: 'idn_1', tenantId: 'ten_home', kind: 'user' },
      session: { id: 'ses_1', tenantId: 'ten_role', kind: 'role', mfa: true },
    };
    expect(toCaller(principal)).toMatchObject({
      tenantId: 'ten_role',
      sessionKind: 'role',
      mfa: true,
    });
    const { tenantId: _omitted, ...legacy } = principal.session;
    expect(toCaller({ ...principal, session: legacy }).tenantId).toBe('ten_home');
    expect(() =>
      toCaller({ ...principal, session: { ...principal.session, kind: 'future-kind' } }),
    ).toThrow(/Unsupported/);
  });
});

describe('fromIamError', () => {
  it('keeps compute codes, maps statuses, and passes other errors through', () => {
    expect(fromIamError(new IamError('ACCESS_DENIED', 'no', 403))).toMatchObject({
      code: 'ACCESS_DENIED',
      status: 403,
    });
    expect(fromIamError(new IamError('INVALID_SESSION_TOKEN', 'revoked', 401))).toMatchObject({
      code: 'UNAUTHENTICATED',
      details: { iamCode: 'INVALID_SESSION_TOKEN' },
    });
    expect(fromIamError(new IamError('RESOURCE_MISMATCH', 'x', 403))).toMatchObject({
      code: 'ACCESS_DENIED',
    });
    expect(fromIamError(new IamError('LOCK_TIMEOUT', 'busy', 503))).toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    const plain = new Error('boom');
    expect(fromIamError(plain)).toBe(plain);
    const already = new ComputeError('CONFLICT', 'x');
    expect(fromIamError(already)).toBe(already);
  });
});
