import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { createWatchRegistry } from '@better-compute/events';
import {
  agentStreamCloser,
  agentStreamFilter,
  combineStreamClosers,
  localStreamCloser,
  drainIamInbox,
  gatewayStreamCloser,
  gatewayTunnelFilter,
  sqlInbox,
  successorsMigration,
  type AgentStreamFilter,
  type GatewayTunnelCloser,
  type GatewayTunnelFilter,
  type IamInboxEvent,
} from '@better-compute/iam';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';

// Closing an agent's live streams when IAM withdraws it (PLAN.md §16 v0.3 exit: "delegation:revoke closes the
// agent's stream within 5 s"): the inbox event → the stream filter → one close request per gateway.

const event = (
  action: string,
  subjectId: string | undefined,
  metadata: IamInboxEvent['metadata'] = {},
): IamInboxEvent => ({
  eventId: `e-${action}`,
  tenantId: 'ten_a',
  sequence: 1,
  occurredAt: 0,
  action,
  ...(subjectId !== undefined ? { subjectId } : {}),
  metadata,
  reactions: ['agent', 'sessions'],
});

/** A gateway holding tunnels, matching filters the way the gateway's registry does. */
function fakeGateway(
  tunnels: { tenantId: string; agentId?: string; delegationId?: string }[],
  options: { fail?: boolean; throwSync?: boolean; reauthorize?: boolean } = {},
) {
  const calls: { op: 'close' | 'reauthorize'; filter: GatewayTunnelFilter; reason?: string }[] = [];
  const matches = (filter: GatewayTunnelFilter) =>
    tunnels.filter(
      (tunnel) =>
        (filter.tenantId === undefined || tunnel.tenantId === filter.tenantId) &&
        (filter.anyAgent === undefined || tunnel.agentId !== undefined) &&
        (filter.agentId === undefined || tunnel.agentId === filter.agentId) &&
        (filter.delegationId === undefined || tunnel.delegationId === filter.delegationId),
    );
  const gateway: GatewayTunnelCloser = {
    closeTunnels(filter, reason) {
      if (options.throwSync) throw new Error('control API misconfigured');
      calls.push({ op: 'close', filter, reason });
      if (options.fail) return Promise.reject(new Error('gateway away'));
      const closed = matches(filter);
      for (const tunnel of closed) tunnels.splice(tunnels.indexOf(tunnel), 1);
      return Promise.resolve(closed.length);
    },
    ...(options.reauthorize
      ? {
          async reauthorizeTunnels(filter: GatewayTunnelFilter) {
            calls.push({ op: 'reauthorize', filter });
            return matches(filter).length;
          },
        }
      : {}),
  };
  return { gateway, calls, tunnels };
}

describe('agentStreamFilter', () => {
  it('maps delegation:revoke, agent:suspend and agent:suspend-all; ignores the rest', () => {
    expect(
      agentStreamFilter(event('delegation:revoke', 'dlg_1', { agentId: 'agt_1', reason: 'done' })),
    ).toEqual({ tenantId: 'ten_a', delegationId: 'dlg_1', agentId: 'agt_1', reason: 'done' });
    expect(agentStreamFilter(event('delegation:revoke', 'dlg_1', { handoffsRevoked: 2 }))).toEqual({
      tenantId: 'ten_a',
      delegationId: 'dlg_1',
      recheckAgents: true,
      reason: 'delegation:revoke',
    });
    expect(agentStreamFilter(event('delegation:revoke', 'dlg_1', { handoffsRevoked: 0 }))).toEqual({
      tenantId: 'ten_a',
      delegationId: 'dlg_1',
      reason: 'delegation:revoke',
    });
    expect(agentStreamFilter(event('agent:suspend', 'agt_1'))).toEqual({
      tenantId: 'ten_a',
      agentId: 'agt_1',
      reason: 'agent:suspend',
    });
    expect(agentStreamFilter(event('agent:suspend-all', 'ten_a', { reason: 'incident' }))).toEqual({
      tenantId: 'ten_a',
      allAgents: true,
      reason: 'incident',
    });
    // Without a subject there is nothing to narrow to: never close more than the event names.
    expect(agentStreamFilter(event('delegation:revoke', undefined))).toBeUndefined();
    expect(agentStreamFilter(event('agent:suspend', ''))).toBeUndefined();
    expect(agentStreamFilter(event('identity:offboard', 'idn_1'))).toBeUndefined();
  });
});

describe('gatewayTunnelFilter', () => {
  it('always narrows to a delegation, an agent, or the agents of one tenant', () => {
    const base = { tenantId: 'ten_a', reason: 'r' };
    expect(gatewayTunnelFilter({ ...base, delegationId: 'dlg_1', agentId: 'agt_1' })).toEqual({
      delegationId: 'dlg_1',
      agentId: 'agt_1',
    });
    expect(gatewayTunnelFilter({ ...base, delegationId: 'dlg_1' })).toEqual({
      delegationId: 'dlg_1',
    });
    expect(gatewayTunnelFilter({ ...base, agentId: 'agt_1' })).toEqual({ agentId: 'agt_1' });
    expect(gatewayTunnelFilter({ ...base, allAgents: true })).toEqual({
      tenantId: 'ten_a',
      anyAgent: true,
    });
  });
});

describe('gatewayStreamCloser', () => {
  it('asks every gateway, sums what they closed, and leaves people and other agents alone', async () => {
    const a = fakeGateway([
      { tenantId: 'ten_a', agentId: 'agt_1', delegationId: 'dlg_1' },
      { tenantId: 'ten_a', agentId: 'agt_2', delegationId: 'dlg_2' },
      { tenantId: 'ten_a' },
    ]);
    const b = fakeGateway([
      { tenantId: 'ten_a', agentId: 'agt_1', delegationId: 'dlg_1' },
      { tenantId: 'ten_b', agentId: 'agt_9' },
    ]);
    const close = gatewayStreamCloser(() => [a.gateway, b.gateway]);
    expect(
      await close({ tenantId: 'ten_a', delegationId: 'dlg_1', agentId: 'agt_1', reason: 'r' }),
    ).toBe(2);
    expect(a.tunnels).toHaveLength(2);
    expect(b.tunnels).toEqual([{ tenantId: 'ten_b', agentId: 'agt_9' }]);
    // suspend-all closes the tenant's agent tunnels only: a person's own tunnel and another tenant's stay.
    expect(await close({ tenantId: 'ten_a', allAgents: true, reason: 'incident' })).toBe(1);
    expect(a.tunnels).toEqual([{ tenantId: 'ten_a' }]);
    expect(b.tunnels).toEqual([{ tenantId: 'ten_b', agentId: 'agt_9' }]);
    expect(a.calls.map((call) => call.reason)).toEqual(['r', 'incident']);
  });

  it('re-authorizes the tenant agent tunnels when hand-offs were revoked, where the gateway can', async () => {
    const a = fakeGateway([{ tenantId: 'ten_a', agentId: 'agt_2', delegationId: 'dlg_child' }], {
      reauthorize: true,
    });
    const old = fakeGateway([{ tenantId: 'ten_a', agentId: 'agt_2', delegationId: 'dlg_child' }]);
    const close = gatewayStreamCloser(async () => new Set([a.gateway, old.gateway]));
    const filter: AgentStreamFilter = {
      tenantId: 'ten_a',
      delegationId: 'dlg_1',
      recheckAgents: true,
      reason: 'r',
    };
    expect(await close(filter)).toBe(0);
    expect(a.calls).toEqual([
      { op: 'close', filter: { delegationId: 'dlg_1' }, reason: 'r' },
      { op: 'reauthorize', filter: { tenantId: 'ten_a', anyAgent: true } },
    ]);
    expect(old.calls.map((call) => call.op)).toEqual(['close']);
  });

  it('tries every gateway before reporting the ones that failed, sync throws included', async () => {
    const ok = fakeGateway([{ tenantId: 'ten_a', agentId: 'agt_1' }]);
    const away = fakeGateway([], { fail: true });
    const broken = fakeGateway([], { throwSync: true });
    const close = gatewayStreamCloser(() => [away.gateway, broken.gateway, ok.gateway]);
    const error = await close({ tenantId: 'ten_a', agentId: 'agt_1', reason: 'r' }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as Error).message).toBe('2 of 3 gateways failed to close tunnels');
    expect(ok.tunnels).toEqual([]);
  });

  it('closes nothing when there are no gateways', async () => {
    expect(
      await gatewayStreamCloser(() => [])({ tenantId: 'ten_a', agentId: 'agt_1', reason: 'r' }),
    ).toBe(0);
  });
});

describe('combineStreamClosers and localStreamCloser', () => {
  it('closes tunnels on the gateways and this process’s SSE streams for one revocation', async () => {
    const gateway = fakeGateway([{ tenantId: 'ten_a', agentId: 'agt_1', delegationId: 'dlg_1' }]);
    const watches = createWatchRegistry();
    const closedWatches: string[] = [];
    watches.add({
      tenantId: 'ten_a',
      subject: { agentId: 'agt_1', delegationId: 'dlg_1' },
      close: (reason) => closedWatches.push(reason),
    });
    watches.add({
      tenantId: 'ten_a',
      subject: { identityId: 'idn_alice' },
      close: () => closedWatches.push('person'),
    });
    const close = combineStreamClosers(
      gatewayStreamCloser(() => [gateway.gateway]),
      localStreamCloser(watches),
    );
    expect(
      await close({ tenantId: 'ten_a', delegationId: 'dlg_1', agentId: 'agt_1', reason: 'done' }),
    ).toBe(2);
    expect(closedWatches).toEqual(['done']);
    expect(await close({ tenantId: 'ten_a', allAgents: true, reason: 'incident' })).toBe(0);

    const failing = combineStreamClosers(
      () => Promise.reject(new Error('gateway away')),
      localStreamCloser(watches),
    );
    await expect(failing({ tenantId: 'ten_a', agentId: 'agt_9', reason: 'r' })).rejects.toThrow(
      /1 stream closers failed/,
    );
  });
});

describe('agentStreamCloser', () => {
  it('sends the close without waiting for it, and never fails the inbox drain', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: AgentStreamFilter[] = [];
    const handler = agentStreamCloser(async (filter) => {
      seen.push(filter);
      await gate;
    });
    // Resolves while the close is still pending.
    await handler(undefined, event('agent:suspend', 'agt_1'));
    await Promise.resolve();
    expect(seen).toEqual([{ tenantId: 'ten_a', agentId: 'agt_1', reason: 'agent:suspend' }]);
    release();

    await handler(undefined, event('identity:offboard', 'idn_1'));
    expect(seen).toHaveLength(1);

    const errors: [unknown, AgentStreamFilter][] = [];
    const failing = agentStreamCloser(
      () => {
        throw new Error('sync');
      },
      { onError: (error, filter) => errors.push([error, filter]) },
    );
    await expect(failing(undefined, event('agent:suspend', 'agt_2'))).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors.map(([error, filter]) => [(error as Error).message, filter.agentId])).toEqual([
      ['sync', 'agt_2'],
    ]);

    const reporterThrows = agentStreamCloser(() => Promise.reject(new Error('away')), {
      onError: () => {
        throw new Error('reporter');
      },
    });
    await expect(
      reporterThrows(undefined, event('agent:suspend', 'agt_3')),
    ).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('on better-iam', () => {
  let db: SqlExecutor;
  const open: EmbeddedTestIam[] = [];
  beforeAll(async () => {
    db = pglite();
    await db.migrate([successorsMigration]);
  });
  afterAll(async () => {
    await db.close();
  });
  afterEach(async () => {
    for (const item of open.splice(0)) await item.close();
  });

  it('a revoked delegation closes the tunnels it opened on every gateway, through the inbox', async () => {
    const t = await createEmbeddedTestIam({ inbox: 'memory' });
    open.push(t);
    const alice = await t.acme.member('alice');
    const agent = await t.iam.api.agents.create(t.acme.owner, {
      tenantId: t.acme.tenantId,
      name: 'Operator',
      model: 'claude-sonnet-5',
    });
    const delegation = await t.iam.api.delegations.grant(alice.credential, {
      tenantId: t.acme.tenantId,
      agentId: agent.id,
      scopes: ['compute:instances:*'],
    });
    const other = await t.iam.api.delegations.grant(t.acme.owner, {
      tenantId: t.acme.tenantId,
      agentId: agent.id,
      scopes: ['compute:instances:*'],
    });
    const east = fakeGateway([
      { tenantId: t.acme.tenantId, agentId: agent.id, delegationId: delegation.id },
      { tenantId: t.acme.tenantId, agentId: agent.id, delegationId: other.id },
    ]);
    const west = fakeGateway([
      { tenantId: t.acme.tenantId, agentId: agent.id, delegationId: delegation.id },
    ]);
    await t.iam.api.delegations.revoke(alice.credential, {
      tenantId: t.acme.tenantId,
      delegationId: delegation.id,
      reason: 'task finished',
    });
    await t.dispatch();
    // The plugin's rows land in compute's inbox table; the iam.inbox reconciler (every 2 s) drains them.
    await sqlInbox(db).put(t.inbox!.events);
    const handlers = {
      agent: agentStreamCloser(gatewayStreamCloser(() => [east.gateway, west.gateway])),
    };
    const drained = await drainIamInbox(db, { handlers });
    expect(drained.failures).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const expected = {
      op: 'close',
      filter: { delegationId: delegation.id, agentId: agent.id },
      reason: 'task finished',
    };
    expect(east.calls).toEqual([expected]);
    expect(west.calls).toEqual([expected]);
    // Only the other delegation's tunnel is left.
    expect(east.tunnels).toEqual([
      { tenantId: t.acme.tenantId, agentId: agent.id, delegationId: other.id },
    ]);
    expect(west.tunnels).toEqual([]);
  });
});
