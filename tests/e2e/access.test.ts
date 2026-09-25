import { afterEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import type { Credential } from '@better-compute/core';
import { installIamHandlers, watchAuthorizer } from '@better-compute/cli';
import { createWatchRegistry, handleWatch } from '@better-compute/events';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';
import { createReplayCache, type ReplayCache } from '@better-compute/pki';
import { TunnelFrameSchema } from '@better-compute/protocol';
import { createDevStack, type DevStack } from '@better-compute/testing';

// PLAN.md §16 v0.3 exit, the access half, end to end on the dev stack (real server, gateway on h2c with its
// control API, FakeDaemons that re-verify tickets): "a replayed ticket is rejected by gateway and daemon" and
// "`delegation:revoke` closes the agent's stream within 5 s", the latter through a real embedded better-iam:
// IAM's audit dispatch → compute's plugin → iam_inbox → the iam.inbox drain → the host's `agent` handler
// (`installIamHandlers`, as `serve` installs it from `host.iam`) → every live gateway's control API.

let stack: DevStack | undefined;
let iam: EmbeddedTestIam | undefined;
let handlers: { close(): void } | undefined;
afterEach(async () => {
  handlers?.close();
  await stack?.close();
  await iam?.close();
  stack = iam = handlers = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A gateway's ticket record that can be swapped for an empty one: the node's session moved to a gateway that never saw the ticket. */
function failoverJtiCache(): { cache: ReplayCache; failover(): void } {
  let inner = createReplayCache({ whenFull: 'refuse' });
  return {
    cache: {
      add: (key, expiresAt, now) => inner.add(key, expiresAt, now),
      get size() {
        return inner.size;
      },
    },
    failover() {
      inner = createReplayCache({ whenFull: 'refuse' });
    },
  };
}

/** Reads a relayed tunnel's text until it closes; `until` waits for a needle. */
function reader(frames: AsyncIterable<{ body: { case?: string; value?: unknown } }>) {
  const decoder = new TextDecoder();
  const state = { text: '', closed: false, closedAt: 0, reason: '' };
  const done = (async () => {
    try {
      for await (const frame of frames) {
        if (frame.body.case === 'data') state.text += decoder.decode(frame.body.value as Uint8Array);
        if (frame.body.case === 'closed') {
          state.reason = (frame.body.value as { reason: string }).reason;
          break;
        }
      }
    } catch {
      // A stream reset ends the tunnel too.
    }
    state.closed = true;
    state.closedAt = Date.now();
  })();
  return {
    state,
    done,
    async until(needle: string, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!state.text.includes(needle) && Date.now() < deadline) await sleep(20);
      expect(state.text).toContain(needle);
    },
  };
}

const typed = (tunnelId: string, text: string) =>
  create(TunnelFrameSchema, {
    tunnelId,
    body: { case: 'data', value: new TextEncoder().encode(text) },
  });

describe('v0.3 access exit', () => {
  it(
    'a replayed ticket is refused by the gateway, and by the daemon when the gateway never saw it',
    { timeout: 90_000 },
    async () => {
      const jti = failoverJtiCache();
      stack = await createDevStack({ tunnels: { jtiCache: jti.cache } });
      const { poolId } = await stack.createPool();
      const [nodeId] = await stack.join({ poolId, seed: 'access-replay' });
      await stack.waitFor([nodeId!], { timeoutMs: 45_000 });
      const api = stack.compute.api as any;
      const daemon = stack.daemons.get(nodeId!)!;
      const relay = stack.tunnelRelay!;
      const gatewayId = stack.gateway.id;

      const opened = await api.tunnels.open(stack.root, {
        tenantId: stack.rootTenantId,
        nodeId,
        op: 'console',
      });
      const request = { ticket: opened.ticket, nodeId: nodeId!, tunnelId: opened.tunnelId, gatewayId };
      const first = await relay.open(request);
      const session = reader(first.frames);
      await session.until(`fake console on ${nodeId}`);
      first.send(typed(opened.tunnelId, 'exit\r'));
      await Promise.race([session.done, sleep(5_000)]);
      first.close();
      expect(daemon.tunnelOutcomes).toEqual([{ opened: true, tunnelId: opened.tunnelId }]);

      // The same gateway remembers the ticket: refused before the node hears of it.
      await expect(relay.open(request)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
      expect(daemon.tunnelOutcomes).toHaveLength(1);

      // A gateway that never saw it (a failover) passes it on; the daemon's own jti set refuses (P14).
      jti.failover();
      const replayed = relay.open(request);
      replayed.catch(() => {});
      const deadline = Date.now() + 10_000;
      while (daemon.tunnelOutcomes.length < 2 && Date.now() < deadline) await sleep(20);
      expect(daemon.tunnelOutcomes[1]).toEqual({
        opened: false,
        tunnelId: opened.tunnelId,
        reason: 'ticket-rejected',
      });
      // Nothing opened: the caller's open fails instead of relaying a shell.
      await expect(replayed).rejects.toBeDefined();
    },
  );

  it(
    "delegation:revoke closes the agent's tunnel within 5 s and leaves the person's own open",
    { timeout: 120_000 },
    async () => {
      // IAM's jobs (audit dispatch every second) run on the iam worker role, as in embedded mode.
      iam = await createEmbeddedTestIam({ now: () => Date.now(), runIamJobs: true });
      const t = iam;
      const tenantId = t.root.tenantId;
      stack = await createDevStack({
        iam: {
          port: t.port,
          rootTenantId: tenantId,
          root: t.root.credential,
          modules: t.bridge.modules,
        },
      });
      // What `serve` does with host.iam: the inbox's `agent` reaction closes tunnels on every live gateway, and
      // this process's /watch streams (the registry the host's GET /watch mount shares).
      const errors: unknown[] = [];
      const watches = createWatchRegistry();
      handlers = installIamHandlers(stack.compute, {
        bridge: t.bridge,
        streams: [watches],
        onError: (error) => errors.push(error),
      });
      const { poolId } = await stack.createPool();
      const [nodeId] = await stack.join({ poolId, seed: 'access-revoke' });
      await stack.waitFor([nodeId!], { timeoutMs: 60_000 });
      const api = stack.compute.api as any;

      // The root administrator delegates node consoles to an agent, which acts under the delegation.
      const agent = await t.iam.api.agents.create(t.root.credential, {
        tenantId,
        name: 'Fleet doctor',
        model: 'claude-sonnet-5',
      });
      const key = await t.iam.api.credentials.create(t.root.credential, {
        tenantId,
        identityId: agent.id,
      });
      const delegation = await t.iam.api.delegations.grant(t.root.credential, {
        tenantId,
        agentId: agent.id,
        scopes: ['compute:nodes:*', 'compute:events:read'],
      });
      const acting: Credential = {
        token: (
          await t.iam.api.delegations.assume({ token: key.token }, { tenantId, delegationId: delegation.id })
        ).token,
      };

      const open = async (credential: Credential) => {
        const ticket = await api.tunnels.open(credential, { tenantId, nodeId, op: 'console' });
        const tunnel = await stack!.tunnelRelay!.open({
          ticket: ticket.ticket,
          nodeId: nodeId!,
          tunnelId: ticket.tunnelId,
          gatewayId: stack!.gateway.id,
        });
        const session = reader(tunnel.frames);
        await session.until(`fake console on ${nodeId}`);
        return { ticket, tunnel, session };
      };
      const agents = await open(acting);
      const persons = await open(t.root.credential);
      // The gateway knows whose tunnel is whose (the ticket's agt/dlg claims).
      agents.tunnel.send(typed(agents.ticket.tunnelId, 'ping\r'));
      await agents.session.until('echo: ping');
      // The agent also follows the tenant's events over SSE, as the host's GET /watch serves them.
      const watch = await handleWatch(
        new Request(`http://127.0.0.1:3000/watch?tenantId=${tenantId}`, {
          headers: { authorization: `Bearer ${acting.token}` },
        }),
        { sql: stack.database, authorize: watchAuthorizer(stack.compute), registry: watches, pollMs: 50 },
      );
      expect(watch.status).toBe(200);
      expect(watches.size).toBe(1);
      const sse = { closed: false, closedAt: 0 };
      void (async () => {
        const reader = watch.body!.getReader();
        try {
          while (!(await reader.read()).done);
        } catch {
          // Cancelled.
        }
        sse.closed = true;
        sse.closedAt = Date.now();
      })();

      const revokedAt = Date.now();
      await t.iam.api.delegations.revoke(t.root.credential, {
        tenantId,
        delegationId: delegation.id,
        reason: 'incident closed',
      });
      while (!agents.session.state.closed && Date.now() - revokedAt < 5_000) await sleep(25);
      expect(agents.session.state.closed).toBe(true);
      expect(agents.session.state.closedAt - revokedAt).toBeLessThan(5_000);
      // Closed by the gateway on the revocation (the event's reason), not by anything else.
      expect(agents.session.state.reason).toBe('incident closed');
      // The agent's event stream too, within the same 5 s.
      while (!sse.closed && Date.now() - revokedAt < 5_000) await sleep(25);
      expect(sse.closed).toBe(true);
      expect(sse.closedAt - revokedAt).toBeLessThan(5_000);
      expect(watches.size).toBe(0);
      expect(errors).toEqual([]);

      // Only the delegation's tunnel closed: the administrator's own console still echoes.
      expect(persons.session.state.closed).toBe(false);
      persons.tunnel.send(typed(persons.ticket.tunnelId, 'still here\r'));
      await persons.session.until('echo: still here');
      persons.tunnel.close();

      // A person signing out: better-iam audits auth:session:revoke with the identity as subject, so the
      // identity's /watch streams close at once (a client reconnects and is re-authorized).
      const member = await t.iam.api.identities.create(t.root.credential, {
        tenantId,
        email: 'watcher@root.test',
        name: 'watcher',
        password: 'a strong watcher test password',
      });
      await t.iam.api.policies
        .create(t.root.credential, {
          tenantId,
          name: 'watch-events',
          document: {
            version: 1,
            statements: [{ effect: 'allow', actions: ['compute:events:read'], resources: ['compute-tenant/*'] }],
          },
        })
        .then((policy: { id: string }) =>
          t.iam.api.roles.create(t.root.credential, { tenantId, name: 'watchers', policyIds: [policy.id] }),
        )
        .then((role: { id: string }) =>
          t.iam.api.bindings.create(t.root.credential, {
            tenantId,
            roleId: role.id,
            subjectType: 'identity',
            subjectId: member.id,
          }),
        );
      const signedIn = await t.iam.api.auth.signIn({
        tenantId,
        email: 'watcher@root.test',
        password: 'a strong watcher test password',
      });
      const memberToken = (signedIn as { token: string }).token;
      const memberWatch = await handleWatch(
        new Request('http://127.0.0.1:3000/watch', { headers: { authorization: `Bearer ${memberToken}` } }),
        { sql: stack.database, authorize: watchAuthorizer(stack.compute), registry: watches, pollMs: 50 },
      );
      expect(memberWatch.status).toBe(200);
      const memberSse = { closed: false };
      void (async () => {
        const reader = memberWatch.body!.getReader();
        try {
          while (!(await reader.read()).done);
        } catch {
          // Cancelled.
        }
        memberSse.closed = true;
      })();
      const signedOutAt = Date.now();
      await t.iam.api.auth.signOut({ token: memberToken });
      while (!memberSse.closed && Date.now() - signedOutAt < 5_000) await sleep(25);
      expect(memberSse.closed).toBe(true);

      // The revoked delegation opens nothing new.
      await expect(
        api.tunnels.open(acting, { tenantId, nodeId, op: 'console' }),
      ).rejects.toMatchObject({ status: expect.any(Number) });
    },
  );
});
