import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@better-iam/core';
import {
  boundedSpill,
  computeIamPlugin,
  inboxReactions,
  isInboxEvent,
  memoryInbox,
  toInboxEvent,
  type InboxEvent,
  type InboxWriter,
} from '@better-compute/iam/plugin';
import { closeIamFixtures, iamFixture, type IamFixture } from './support/iam.js';

// Compute's IamPlugin on a real (vendored) better-iam: the catalog it contributes and the afterAudit that
// forwards events into compute's inbox and never throws (PLAN.md §12.3, §12.8).

afterEach(closeIamFixtures);

const event = (id: string, extra: Partial<AuditEvent> = {}): AuditEvent => ({
  id,
  tenantId: 'ten_1',
  actorId: 'idn_1',
  action: 'agent:suspend',
  resourceId: 'agt_1',
  timestamp: 1_700_000_000_000,
  outcome: 'allow',
  sequence: 7,
  ...extra,
});

/** An inbox whose availability the test controls. */
function flakyInbox() {
  const inbox = memoryInbox();
  let mode: 'up' | 'down' | 'hang' = 'up';
  const writer: InboxWriter & { set(next: typeof mode): void; calls: number } = {
    calls: 0,
    set(next) {
      mode = next;
    },
    async put(events) {
      writer.calls++;
      if (mode === 'down') throw new Error('compute database unreachable');
      if (mode === 'hang') return new Promise<void>(() => {});
      await inbox.put(events);
    },
  };
  return { inbox, writer };
}

describe('inbox classification', () => {
  it('forwards allowed actions of the §12.8 table only', () => {
    for (const action of [
      'identity:offboard',
      'identity:expire',
      'identity:delete',
      'iam:identities:update',
      'auth:session:revoke',
      'auth:session:revoke-others',
      'identity:revoke-sessions',
      'tenant:revoke-sessions',
      'agent:suspend',
      'agent:suspend-all',
      'delegation:revoke',
      'binding:activate',
      'binding:deactivate',
      'iam:tenants:update',
      'iam:tenants:delete',
      'iam:policies:update',
      'iam:relationships:create',
      'feature:update',
      'billing:budget-alert',
    ])
      expect(isInboxEvent({ action, outcome: 'allow' }), action).toBe(true);
    for (const action of [
      'compute:pools:read',
      'auth:session:create',
      'iam:policies:read',
      'iam:identities:create',
      'billing:budget-create',
    ])
      expect(isInboxEvent({ action, outcome: 'allow' }), action).toBe(false);
    expect(isInboxEvent({ action: 'agent:suspend', outcome: 'deny' })).toBe(false);
    expect(inboxReactions('identity:offboard')).toEqual(['identity', 'sessions']);
    expect(inboxReactions('feature:update')).toEqual(['features', 'authz']);
  });

  it('keeps the fields the inbox table stores', () => {
    expect(toInboxEvent(event('e1'))).toEqual({
      eventId: 'e1',
      tenantId: 'ten_1',
      sequence: 7,
      occurredAt: 1_700_000_000_000,
      action: 'agent:suspend',
      body: expect.objectContaining({ id: 'e1', resourceId: 'agt_1' }),
    });
    expect(toInboxEvent(event('e2', { sequence: undefined })).sequence).toBe(0);
  });
});

describe('boundedSpill', () => {
  it('drops the oldest entries beyond capacity, including after a failed flush', () => {
    const spill = boundedSpill<number>(3);
    spill.push(1, 2, 3, 4);
    expect(spill.size).toBe(3);
    expect(spill.dropped).toBe(1);
    const batch = spill.drain();
    expect(batch).toEqual([2, 3, 4]);
    spill.push(5);
    spill.unshift(batch);
    expect(spill.drain()).toEqual([3, 4, 5]);
    expect(spill.dropped).toBe(2);
    expect(() => boundedSpill(0)).toThrow(/positive integer/);
  });
});

describe('computeIamPlugin (unit)', () => {
  it('writes accepted events and ignores the rest', async () => {
    const inbox = memoryInbox();
    const plugin = computeIamPlugin({ inbox });
    await plugin.afterAudit!(event('e1'));
    await plugin.afterAudit!(event('e2', { outcome: 'deny' }));
    await plugin.afterAudit!(event('e3', { action: 'compute:pools:read' }));
    expect(inbox.events.map((item) => item.eventId)).toEqual(['e1']);
    expect(plugin.stats()).toEqual({
      forwarded: 1,
      spilled: 0,
      dropped: 0,
      pending: 0,
      failures: 0,
    });
    expect(Object.keys(plugin).sort()).toEqual(['afterAudit', 'id', 'resourceTypes']);
  });

  it('never throws: a failing inbox spills, and the next successful write flushes in order', async () => {
    const { inbox, writer } = flakyInbox();
    const errors: unknown[] = [];
    const plugin = computeIamPlugin({
      inbox: writer,
      onError: (error) => {
        errors.push(error);
        throw new Error('a broken reporter changes nothing');
      },
    });
    writer.set('down');
    await expect(plugin.afterAudit!(event('e1'))).resolves.toBeUndefined();
    await expect(plugin.afterAudit!(event('e2'))).resolves.toBeUndefined();
    expect(plugin.stats()).toMatchObject({ spilled: 2, pending: 2, failures: 2 });
    expect(errors).toHaveLength(2);
    writer.set('up');
    await plugin.afterAudit!(event('e3'));
    expect(inbox.events.map((item) => item.eventId)).toEqual(['e3', 'e1', 'e2']);
    expect(plugin.stats()).toMatchObject({ forwarded: 3, pending: 0 });
  });

  it('times out a hanging inbox instead of blocking the IAM dispatch pass', async () => {
    const { writer } = flakyInbox();
    const plugin = computeIamPlugin({ inbox: writer, timeoutMs: 25 });
    writer.set('hang');
    const started = Date.now();
    await plugin.afterAudit!(event('e1'));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(plugin.stats()).toMatchObject({ spilled: 1, pending: 1 });
    writer.set('up');
    expect(await plugin.flush()).toBe(true);
    expect(plugin.stats().pending).toBe(0);
  });

  it('reports each spilled event to onSpill without ever throwing', async () => {
    const { writer } = flakyInbox();
    const spilled: string[] = [];
    const plugin = computeIamPlugin({
      inbox: writer,
      onSpill: (item) => {
        spilled.push(item.eventId);
        throw new Error('broken metrics');
      },
    });
    writer.set('down');
    await expect(plugin.afterAudit!(event('s1'))).resolves.toBeUndefined();
    expect(spilled).toEqual(['s1']);
  });

  it('bounds the spill and counts what it dropped', async () => {
    const { inbox, writer } = flakyInbox();
    const plugin = computeIamPlugin({ inbox: writer, spill: 2 });
    writer.set('down');
    for (const id of ['e1', 'e2', 'e3']) await plugin.afterAudit!(event(id));
    expect(plugin.stats()).toMatchObject({ pending: 2, dropped: 1 });
    writer.set('up');
    await plugin.flush();
    expect(inbox.events.map((item: InboxEvent) => item.eventId)).toEqual(['e2', 'e3']);
  });
});

describe('computeIamPlugin on better-iam', () => {
  /** Suspends a fresh agent as the owner: an audited `agent:suspend` allow. */
  async function suspendAgent(f: IamFixture, name: string) {
    const agent = await f.iam.api.agents.create(f.ownerCredential, {
      tenantId: f.tenantId,
      name,
      model: 'claude-sonnet-5',
    });
    await f.iam.api.agents.suspend(f.ownerCredential, { tenantId: f.tenantId, agentId: agent.id });
    return agent.id;
  }

  it('is accepted as a plugin: compute:* policies validate, and dispatch delivers the events compute wants', async () => {
    const inbox = memoryInbox();
    const f = await iamFixture({ plugins: [computeIamPlugin({ inbox })] });
    await f.iam.api.policies.create(f.ownerCredential, {
      tenantId: f.tenantId,
      name: 'readers',
      document: {
        version: 1,
        statements: [
          { effect: 'allow', actions: ['compute:pools:read'], resources: ['compute-pool/*'] },
        ],
      },
    });
    const agentId = await suspendAgent(f, 'Nightly');
    await f.iam.events.dispatch();
    const suspended = inbox.events.find((item) => item.action === 'agent:suspend');
    expect(suspended).toMatchObject({ tenantId: f.tenantId, body: { resourceId: agentId } });
    expect(suspended!.sequence).toBeGreaterThan(0);
    expect(inbox.events.some((item) => item.action === 'iam:policies:create')).toBe(true);
    expect(inbox.events.every((item) => isInboxEvent(item.body as never))).toBe(true);
  });

  it('keeps the IAM host dispatching while compute is down, then catches up', async () => {
    const { inbox, writer } = flakyInbox();
    const later: string[] = [];
    const plugin = computeIamPlugin({ inbox: writer, timeoutMs: 50 });
    const f = await iamFixture({
      plugins: [
        plugin,
        {
          id: 'later-plugin',
          afterAudit: async (audited) => {
            later.push(audited.action);
          },
        },
      ],
    });
    await f.iam.events.dispatch();
    later.length = 0;
    writer.set('down');
    await suspendAgent(f, 'First');
    // A throwing afterAudit would reject here and leave every row undelivered (tests/iam-contract.test.ts).
    const first = await f.iam.events.dispatch();
    expect(first.dispatched).toBeGreaterThan(0);
    expect(later).toContain('agent:suspend');
    expect(await f.iam.store.find('auditHooks', { delivered: false })).toEqual([]);
    expect(plugin.stats().pending).toBeGreaterThan(0);
    expect(inbox.events).toEqual([]);

    writer.set('up');
    await suspendAgent(f, 'Second');
    await f.iam.events.dispatch();
    expect(inbox.events.filter((item) => item.action === 'agent:suspend')).toHaveLength(2);
    expect(plugin.stats().pending).toBe(0);
  });
});
