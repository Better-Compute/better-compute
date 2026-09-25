import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIamClient } from '@better-iam/client';
import { createMcpGate } from '@better-iam/mcp';
import type { BetterIam } from '@better-iam/server';
import { createComputeClient } from '@better-compute/client';
import type { Credential, SqlExecutor } from '@better-compute/core';
import {
  TEST_IAM_ORIGIN,
  createEmbeddedTestIam,
  type EmbeddedTestIam,
} from '@better-compute/iam/testing';
import {
  createComputeMcp,
  gateTools,
  iamConfirmations,
  remoteMcpIam,
} from '@better-compute/mcp';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';

// v0.3 acceptance (PLAN.md §16, §3.4 step 7, §9.3): "an agent reserves via MCP with human
// confirmation, retrying with the same key". Everything is real except the node: embedded better-iam
// (delegation, confirm list, the person's approval), the compute server over its HTTP handler, the
// capacity module's inline placer, the MCP server behind better-iam's gate, and the tools polling
// better-iam with the agent's own delegated credential.

const BASE_URL = 'http://127.0.0.1:3000';
const NODE = 'node_01k5w00000000000000000mcp1';

let t: EmbeddedTestIam;
let compute: BetterCompute<any, any>;
let database: SqlExecutor;
let poolId: string;
let alice: { identityId: string; credential: Credential };
let agentToken: string;

beforeAll(async () => {
  t = await createEmbeddedTestIam({ now: () => Date.now() });
  database = pglite();
  compute = betterCompute({
    database,
    iam: t.port,
    secret: 'better-compute-mcp-e2e-secret-0123456789abcdef',
    baseURL: BASE_URL,
    modules: [...t.bridge.modules],
  } as any);
  await compute.initialize();

  // The platform: a site and an H100 pool offered to acme, with one adopted node of 4 GPUs.
  const root = t.root.credential;
  const site = await compute.api.sites.create(root, {
    tenantId: t.root.tenantId,
    kind: 'shared',
    region: 'eu-west-1',
    idempotencyKey: 'mcp-site',
  });
  const pool = await compute.api.pools.create(root, {
    tenantId: t.root.tenantId,
    siteId: site.id,
    class: 'metal-host',
    gpuModel: 'H100',
    idempotencyKey: 'mcp-pool',
  });
  poolId = pool.id;
  await compute.api.pools.offer(root, {
    tenantId: t.root.tenantId,
    poolId,
    toTenantId: t.acme.tenantId,
    quota: { gpu: 4 },
  });
  await database.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
                        cordoned, connectivity, trust, generation, observed_generation, next_cmd_seq,
                        identity_gen, shard, version)
     VALUES ($1, $2, $3, $4, 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
    [NODE, site.id, poolId, t.root.tenantId],
  );
  for (let index = 0; index < 4; index++)
    await database.query(
      `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
       VALUES ($1, $2, 'gpu', true, true, '{"gpuModel":"H100","gpuProduct":"H100-SXM5-80GB"}')`,
      [`GPU-mcp-e2e-000${index}`, NODE],
    );

  // A person in acme who may reserve, and an agent acting for them whose reservations need approval.
  alice = await t.acme.member('alice');
  await t.acme.grant(alice.identityId, {
    version: 1,
    statements: [
      {
        effect: 'allow',
        actions: ['compute:pools:read'],
        resources: ['compute-pool/*', 'compute-tenant/*'],
      },
      {
        effect: 'allow',
        actions: ['compute:reservations:*'],
        resources: ['compute-reservation/*'],
      },
    ],
  });
  const agent = await t.iam.api.agents.create(t.acme.owner, {
    tenantId: t.acme.tenantId,
    name: 'Trainer',
    model: 'claude-sonnet-5',
  });
  const key = await t.iam.api.credentials.create(t.acme.owner, {
    tenantId: t.acme.tenantId,
    identityId: agent.id,
  });
  const delegation = await t.iam.api.delegations.grant(alice.credential, {
    tenantId: t.acme.tenantId,
    agentId: agent.id,
    scopes: ['compute:pools:read', 'compute:reservations:*'],
    confirm: ['compute:reservations:create'],
  });
  agentToken = (
    await t.iam.api.delegations.assume(
      { token: key.token },
      { tenantId: t.acme.tenantId, delegationId: delegation.id },
    )
  ).token;
}, 120_000);

afterAll(async () => {
  await compute?.stop();
  await t?.close();
});

/**
 * The MCP endpoint as a host mounts it: better-iam's gate, then the compute tools over HTTP. With
 * `remote`, the gate reaches IAM over better-iam's HTTP API (`remoteMcpIam`), as a host whose IAM
 * runs elsewhere would (v0.4).
 */
function mcpEndpoint(options: { poll?: boolean; remote?: boolean } = {}) {
  const mcp = createComputeMcp({
    // Each request's compute client forwards the caller's Authorization to the compute handler.
    client: (request) =>
      createComputeClient({
        baseURL: BASE_URL,
        headers: { authorization: request.headers.get('authorization') ?? '' },
        fetch: async (input, init) => compute.handler(new Request(input, init)),
      }) as never,
    ...(options.poll
      ? { confirmations: iamConfirmations(t.iam.api.delegations, { intervalMs: 20 }) }
      : {}),
  });
  const iam = options.remote
    ? remoteMcpIam(
        createIamClient<BetterIam>({
          baseURL: TEST_IAM_ORIGIN,
          fetch: async (input, init) => t.iam.handler(new Request(input, init)),
        }) as never,
      )
    : t.iam;
  const gate = createMcpGate({
    iam: iam as never,
    tenantId: t.acme.tenantId,
    tools: gateTools(),
    unlisted: 'deny',
  });
  return async (name: string, args: Record<string, unknown>, token = agentToken) => {
    const response = await gate(
      new Request('https://mcp.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      }),
      (forwarded, caller) => mcp.handler(forwarded, caller as never),
    );
    const body = (await response.json()) as {
      result?: { isError?: boolean; structuredContent: Record<string, any> };
      error?: unknown;
    };
    if (!body.result) throw new Error(`MCP error: ${JSON.stringify(body)}`);
    return body.result;
  };
}

async function bookings(reservationId?: string) {
  const { rows } = await database.query<{ reservations: number; gpus: number }>(
    `SELECT (SELECT count(*)::int FROM reservations WHERE tenant_id = $1
               AND state NOT IN ('awaiting-confirmation', 'failed')) AS reservations,
            (SELECT count(*)::int FROM device_bookings b
               JOIN allocations a ON a.id = b.allocation_id
               JOIN reservations r ON r.id = a.owner_id
              WHERE r.tenant_id = $1 AND a.released_at IS NULL
                AND ($2::text IS NULL OR r.id = $2)) AS gpus`,
    [t.acme.tenantId, reservationId ?? null],
  );
  return rows[0]!;
}

async function pendingFor(person: Credential) {
  return t.iam.api.delegations.listConfirmations(person, {
    tenantId: t.acme.tenantId,
    status: 'pending',
  });
}

describe('an agent reserves GPUs over MCP with a person’s confirmation (v0.3 acceptance)', () => {
  it('holds the reservation back, books it once after approval, and replays the same key', async () => {
    const call = mcpEndpoint();
    const pools = await call('list_pools', {});
    expect(pools.isError, JSON.stringify(pools.structuredContent)).toBeUndefined();
    expect(JSON.stringify(pools.structuredContent)).toContain(poolId);

    // 1. The agent asks; better-iam holds create back for alice. Nothing is booked.
    const args = { poolId, gpus: 2, duration: '1h' };
    const first = await call('reserve_gpus', args);
    expect(first.isError).toBeUndefined();
    const key = first.structuredContent.idempotencyKey as string;
    expect(first.structuredContent.reservation).toMatchObject({
      status: 'confirmation-required',
      confirmationId: expect.any(String),
      idempotencyKey: key,
    });
    const confirmationId = first.structuredContent.reservation.confirmationId as string;
    expect(await bookings()).toEqual({ reservations: 0, gpus: 0 });

    // A retry before alice decides reuses the same pending request (no second prompt).
    const again = await call('reserve_gpus', { ...args, idempotencyKey: key });
    expect(again.structuredContent.reservation.confirmationId).toBe(confirmationId);
    const pending = await pendingFor(alice.credential);
    expect(pending.map((item) => item.id)).toEqual([confirmationId]);
    expect(pending[0]).toMatchObject({ action: 'compute:reservations:create' });

    // 2. With polling, the tool waits in the call; alice approves meanwhile; the retry books once.
    const polling = mcpEndpoint({ poll: true });
    const waiting = polling('reserve_gpus', { ...args, idempotencyKey: key });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await t.iam.api.delegations.decideConfirmation(alice.credential, {
      tenantId: t.acme.tenantId,
      confirmationId,
      approve: true,
    });
    const booked = await waiting;
    expect(booked.isError).toBeUndefined();
    const reservation = booked.structuredContent.reservation as { id: string; state: string };
    expect(reservation).toMatchObject({ id: expect.stringMatching(/^rsv_/), state: 'placed' });
    expect(booked.structuredContent.idempotencyKey).toBe(key);
    expect(await bookings(reservation.id)).toEqual({ reservations: 1, gpus: 2 });

    // 3. Another retry with the same key replays the reservation: no second booking.
    const replayed = await call('reserve_gpus', { ...args, idempotencyKey: key });
    expect(replayed.structuredContent.reservation).toMatchObject({ id: reservation.id });
    expect(await bookings()).toEqual({ reservations: 1, gpus: 2 });

    // 4. Release is not held back: the agent ends the reservation itself.
    const released = await call('release_reservation', { reservationId: reservation.id });
    expect(released.isError).toBeUndefined();
    expect((await bookings(reservation.id)).gpus).toBe(0);
  }, 60_000);

  it('reports a rejection to the model and books nothing', async () => {
    const polling = mcpEndpoint({ poll: true });
    const waiting = polling('reserve_gpus', { poolId, gpus: 1, duration: '30m' });
    let confirmationId: string | undefined;
    for (let tries = 0; tries < 100 && !confirmationId; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      confirmationId = (await pendingFor(alice.credential))[0]?.id;
    }
    expect(confirmationId).toBeDefined();
    const before = await bookings();
    await t.iam.api.delegations.decideConfirmation(alice.credential, {
      tenantId: t.acme.tenantId,
      confirmationId: confirmationId!,
      approve: false,
    });
    const answer = await waiting;
    expect(answer.structuredContent.reservation).toMatchObject({
      status: 'confirmation-denied',
      confirmationId,
    });
    expect(await bookings()).toEqual(before);
  }, 60_000);

  it('gates the same way when IAM is reached over HTTP (remoteMcpIam, v0.4)', async () => {
    const call = mcpEndpoint({ remote: true, poll: true });
    const pools = await call('list_pools', {});
    expect(pools.isError, JSON.stringify(pools.structuredContent)).toBeUndefined();
    // Held back for alice over the remote gate too; she approves, the retry books.
    const waiting = call('reserve_gpus', { poolId, gpus: 1, duration: '15m' });
    let confirmationId: string | undefined;
    for (let tries = 0; tries < 100 && !confirmationId; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      confirmationId = (await pendingFor(alice.credential))[0]?.id;
    }
    await t.iam.api.delegations.decideConfirmation(alice.credential, {
      tenantId: t.acme.tenantId,
      confirmationId: confirmationId!,
      approve: true,
    });
    const booked = await waiting;
    expect(booked.structuredContent.reservation).toMatchObject({ state: 'placed' });
    await call('release_reservation', { reservationId: booked.structuredContent.reservation.id });
    // Another organization's owner cannot see acme's pool through the gate.
    const outsider = await call('reserve_gpus', { poolId, gpus: 1, duration: '15m' }, (
      t.other.owner as { token: string }
    ).token);
    expect(outsider.isError).toBe(true);
  }, 60_000);

  it('books at once for a person, and polls only with the caller’s token and tenant', async () => {
    // alice's own session is not delegated: her MCP call books at once, without a confirmation.
    const call = mcpEndpoint();
    const direct = await call('reserve_gpus', { poolId, gpus: 1, duration: '10m' }, (
      alice.credential as { token: string }
    ).token);
    expect(direct.structuredContent.reservation).toMatchObject({ state: 'placed' });
    await call(
      'release_reservation',
      { reservationId: direct.structuredContent.reservation.id },
      (alice.credential as { token: string }).token,
    );
    // Polling is bound to the caller's token and tenant: without either there is nothing to poll.
    const polls = iamConfirmations(t.iam.api.delegations);
    expect(polls(new Request('https://mcp.test/mcp'), { kind: 'agent', tenantId: 'x' })).toBe(
      undefined,
    );
    expect(
      polls(new Request('https://mcp.test/mcp', { headers: { authorization: 'Bearer abc' } })),
    ).toBe(undefined);
  }, 60_000);
});
