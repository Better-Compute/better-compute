import { afterEach, describe, expect, it } from 'vitest';
import type { Caller, Credential } from '@better-compute/core';
import { confirmationOf, delegatedDenial, type ProjectionRow } from '@better-compute/iam';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';

// Delegated confirmation, IAM side (PLAN.md §3.4 step 7, v0.3): a held-back action becomes
// CONFIRMATION_REQUIRED, retries reuse the pending request, and the approved triple admits the retry.

const open: EmbeddedTestIam[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
});

async function setup() {
  const t = await createEmbeddedTestIam({ inbox: 'memory' });
  open.push(t);
  const rows: ProjectionRow[] = ['draft-1', 'draft-2'].map((id) => ({
    type: 'reservation',
    id,
    tenantId: t.acme.tenantId,
    attributes: { gpuCount: 2 },
  }));
  t.bridge.projection.setSource({
    load: async () => ({ rows, cursor: { txid: '0', seq: '0' } }),
    changes: async (cursor) => ({ changed: [], rows: [], cursor }),
    get: async () => undefined,
  });
  await t.bridge.projection.load();
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
  const caller: Caller = await t.port.authenticate(acting);
  const decision = (action: string, id = 'draft-1') => ({
    tenantId: t.acme.tenantId,
    action,
    resource: { type: 'compute-reservation', id },
  });
  return { t, alice, acting, caller, decision };
}

describe('delegatedDenial', () => {
  it('asks the person once, then admits the retry on the approved (action, type, id)', async () => {
    const { t, alice, acting, caller, decision } = await setup();
    expect(caller.sessionKind).toBe('delegated');
    const create = decision('compute:reservations:create');
    await expect(t.port.require(acting, create)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    const first = await delegatedDenial(t.port, {
      caller,
      credential: acting,
      decision: create,
      reason: 'Reserve 2× H100 for the nightly run',
    });
    expect(first).toMatchObject({ code: 'CONFIRMATION_REQUIRED', status: 403 });
    const asked = confirmationOf(first)!;
    expect(asked).toMatchObject({
      confirmationId: expect.any(String),
      action: 'compute:reservations:create',
      resource: { type: 'compute-reservation', id: 'draft-1' },
      expiresAt: expect.any(Number),
    });
    // A retry before the person decides reuses the pending request.
    const again = confirmationOf(
      await delegatedDenial(t.port, {
        caller,
        credential: acting,
        decision: create,
        reason: 'again',
      }),
    )!;
    expect(again.confirmationId).toBe(asked.confirmationId);
    const pending = await t.iam.api.delegations.listConfirmations(alice.credential, {
      tenantId: t.acme.tenantId,
      status: 'pending',
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      reason: 'Reserve 2× H100 for the nightly run',
      validSeconds: 900,
    });

    await t.iam.api.delegations.decideConfirmation(alice.credential, {
      tenantId: t.acme.tenantId,
      confirmationId: asked.confirmationId,
      approve: true,
    });
    // The retry with the same key decides on the same draft id: allowed now, and only that one.
    await expect(t.port.require(acting, create)).resolves.toBeUndefined();
    await expect(
      t.port.require(acting, decision('compute:reservations:create', 'draft-2')),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('is a plain ACCESS_DENIED for actions not held back, non-delegated callers, and IAM failures', async () => {
    const { t, alice, acting, caller, decision } = await setup();
    const notHeld = await delegatedDenial(t.port, {
      caller,
      credential: acting,
      decision: decision('compute:nodes:ssh-root'),
      reason: 'x',
    });
    expect(notHeld).toMatchObject({ code: 'ACCESS_DENIED' });
    expect(confirmationOf(notHeld)).toBeUndefined();

    const person = await t.port.authenticate(alice.credential);
    let asked = 0;
    const counting = {
      requestConfirmation: async () => {
        asked++;
        return { confirmationId: 'never' };
      },
    };
    expect(
      await delegatedDenial(counting, {
        caller: person,
        credential: alice.credential,
        decision: decision('compute:reservations:create'),
        reason: 'x',
      }),
    ).toMatchObject({ code: 'ACCESS_DENIED' });
    expect(asked).toBe(0);

    const broken = { requestConfirmation: () => Promise.reject(new Error('IAM down')) };
    expect(
      await delegatedDenial(broken, {
        caller,
        credential: acting,
        decision: decision('compute:reservations:create'),
        reason: 'x',
      }),
    ).toMatchObject({ code: 'ACCESS_DENIED' });
  });
});
