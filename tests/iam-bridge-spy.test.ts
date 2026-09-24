import { describe, expect, it } from 'vitest';
import { ComputeError, manualClock, type IamPort } from '@better-compute/core';
import { spyIamPort } from '@better-compute/iam';

// The IamPort spy behind the v0.1 security negative "zero IAM calls on fleet paths" (PLAN.md §16, P7).

function stubPort(): IamPort {
  return {
    rootTenantId: 'ten_root',
    authenticate: async () => ({
      identityId: 'idn_1',
      identityKind: 'user',
      tenantId: 'ten_a',
      sessionId: 'ses_1',
      sessionKind: 'user',
      mfa: false,
    }),
    require: async (_credential, decision) => {
      if (decision.action === 'compute:nodes:ssh-root')
        throw new ComputeError('ACCESS_DENIED', 'no');
    },
    authorize: async () => true,
    authorizeMany: async (_credential, _tenantId, checks) => checks.map(() => true),
    requestConfirmation: async () => 'not-held-back',
    billingCheck: async () => ({ allowed: true, budgets: [] }),
    recordUsage: async (events) =>
      events.map((event) => ({ idempotencyKey: event.idempotencyKey, status: 'recorded' })),
    featureEnabled: async () => true,
    capabilities: () => ({
      pluginResolver: false,
      eventDetail: false,
      evaluate: false,
      readOnlyDecisions: false,
    }),
  };
}

const credential = { token: 't' };
const decision = (action: string) => ({
  tenantId: 'ten_a',
  action,
  resource: { type: 'compute-reservation', id: 'rsv_1' },
});

describe('spyIamPort', () => {
  it('forwards every call unchanged and records it with its details', async () => {
    const clock = manualClock(1000);
    const spy = spyIamPort(stubPort(), { clock });
    expect(spy.rootTenantId).toBe('ten_root');
    expect(await spy.authenticate(credential)).toMatchObject({ identityId: 'idn_1' });
    await spy.require(credential, decision('compute:reservations:create'));
    await expect(spy.require(credential, decision('compute:nodes:ssh-root'))).rejects.toMatchObject(
      {
        code: 'ACCESS_DENIED',
      },
    );
    expect(await spy.authorizeMany(credential, 'ten_a', [decision('x'), decision('y')])).toEqual([
      true,
      true,
    ]);
    expect(await spy.featureEnabled('ten_a', 'compute.h100')).toBe(true);
    expect(spy.capabilities().evaluate).toBe(false);
    expect(spy.calls).toEqual([
      { method: 'authenticate', paths: [], at: 1000, outcome: 'ok' },
      {
        method: 'require',
        paths: [],
        at: 1000,
        outcome: 'ok',
        tenantId: 'ten_a',
        action: 'compute:reservations:create',
        resource: { type: 'compute-reservation', id: 'rsv_1' },
      },
      expect.objectContaining({
        method: 'require',
        outcome: 'error',
        action: 'compute:nodes:ssh-root',
      }),
      expect.objectContaining({ method: 'authorizeMany', tenantId: 'ten_a', size: 2 }),
      expect.objectContaining({ method: 'featureEnabled', action: 'feature:compute.h100' }),
    ]);
  });

  it('attributes calls to the innermost path across awaits, and keeps concurrent paths apart', async () => {
    const spy = spyIamPort(stubPort());
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.all([
      spy.path('heartbeat', async () => {
        await tick();
        await tick();
      }),
      spy.path('admission', async () => {
        await tick();
        await spy.authenticate(credential);
        await spy.path('admission.decide', async () => {
          await tick();
          await spy.require(credential, decision('compute:reservations:create'));
        });
      }),
      spy.path('inventory', async () => {
        await tick();
      }),
    ]);
    await spy.featureEnabled('ten_a', 'k');
    expect(spy.callsOn('heartbeat')).toEqual([]);
    expect(spy.callsOn('inventory', { nested: true })).toEqual([]);
    expect(spy.callsOn('admission').map((call) => call.method)).toEqual(['authenticate']);
    expect(spy.callsOn('admission', { nested: true }).map((call) => call.method)).toEqual([
      'authenticate',
      'require',
    ]);
    expect(spy.callsOn('admission.decide')[0]!.paths).toEqual(['admission', 'admission.decide']);
    expect(spy.summary()).toEqual({ admission: 1, 'admission.decide': 1, '(none)': 1 });
    spy.reset();
    expect(spy.calls).toEqual([]);
  });
});
