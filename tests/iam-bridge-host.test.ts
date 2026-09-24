import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { manualClock, type SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { createComputeIamBridge, successorsMigration } from '@better-compute/iam';
import {
  computeIamHost,
  createInboxHandler,
  httpInbox,
  memoryInbox,
  postgresInbox,
  pullRemoteInbox,
  replicaProjection,
  type InboxEvent,
} from '@better-compute/iam/plugin';
import { closeIamFixtures, iamFixture } from './support/iam.js';

// Remote mode, IAM-operator side (PLAN.md §12.1, v0.4): an IAM deployment compute does not run installs
// computeIamHost; its events land in compute_inbox in the IAM database and compute pulls them.

let iamDb: SqlExecutor;
let computeDb: SqlExecutor;
const secret = 'an inbox secret of at least thirty-two characters';

beforeAll(async () => {
  iamDb = pglite();
  computeDb = pglite();
  await computeDb.migrate([successorsMigration]);
});
afterAll(async () => {
  await iamDb.close();
  await computeDb.close();
});
afterEach(async () => {
  await closeIamFixtures();
  await computeDb.query('DELETE FROM iam_inbox');
  await computeDb.query('DELETE FROM authz_projection');
  await iamDb.query('DROP TABLE IF EXISTS compute_inbox');
});

const event = (id: string, sequence = 1): InboxEvent => ({
  eventId: id,
  tenantId: 'ten_a',
  sequence,
  occurredAt: 1_700_000_000_000 + sequence,
  action: 'agent:suspend',
  body: { id, action: 'agent:suspend', outcome: 'allow' },
});

describe('computeIamHost on a better-iam deployment', () => {
  it('validates compute policies, decides through the replica, and delivers events via compute_inbox', async () => {
    const projection = replicaProjection({ sql: computeDb });
    let rootTenantId: string | undefined;
    const host = computeIamHost({
      projection,
      inbox: postgresInbox({ sql: iamDb }),
      rootTenantId: () => rootTenantId,
    });
    const f = await iamFixture({ plugins: [host.plugin], resolveResource: host.resolveResource });
    rootTenantId = f.rootTenantId;
    // plugin.migrate ran during iam.initialize(): the inbox table exists before any event.
    expect(
      (await iamDb.query("SELECT to_regclass('compute_inbox') IS NOT NULL AS found")).rows,
    ).toEqual([{ found: true }]);

    const alice = await f.member('alice');
    const aliceSession = await f.signIn('alice');
    await f.grant(alice.id, {
      version: 1,
      statements: [
        { effect: 'allow', actions: ['compute:pools:read'], resources: ['compute-pool/*'] },
      ],
    });
    await computeDb.query(
      `INSERT INTO authz_projection (type, id, tenant_id, attributes) VALUES ('pool', 'pool-1', $1, '{}')`,
      [f.tenantId],
    );
    const read = {
      ...aliceSession,
      tenantId: f.tenantId,
      action: 'compute:pools:read',
      resource: { type: 'compute-pool', id: 'pool-1' },
    };
    // Not started: compute decisions on this host deny.
    await expect(f.iam.authorize(read)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await host.start();
    try {
      expect((await f.iam.authorize(read)).allowed).toBe(true);

      const agent = await f.iam.api.agents.create(f.ownerCredential, {
        tenantId: f.tenantId,
        name: 'Nightly',
        model: 'claude-sonnet-5',
      });
      await f.iam.api.agents.suspend(f.ownerCredential, {
        tenantId: f.tenantId,
        agentId: agent.id,
      });
      await f.iam.events.dispatch();
      const staged = await iamDb.query<{ action: string }>('SELECT action FROM compute_inbox');
      expect(staged.rows.map((row) => row.action)).toContain('agent:suspend');

      const pulled = await pullRemoteInbox(iamDb, computeDb);
      expect(pulled.moved).toBe(staged.rows.length);
      expect((await iamDb.query('SELECT 1 FROM compute_inbox')).rows).toEqual([]);
      const { rows } = await computeDb.query<{ action: string; tenant_id: string }>(
        'SELECT action, tenant_id FROM iam_inbox',
      );
      expect(rows).toContainEqual({ action: 'agent:suspend', tenant_id: f.tenantId });
      expect(await pullRemoteInbox(iamDb, computeDb)).toEqual({ moved: 0, more: false });
    } finally {
      host.stop();
    }
  });
});

describe('bridge.remote', () => {
  it('is the IamPort over HTTP, and pulls the IAM database inbox through the iam module', async () => {
    const hostProjection = replicaProjection({ sql: computeDb });
    let rootTenantId: string | undefined;
    const host = computeIamHost({
      projection: hostProjection,
      inbox: postgresInbox({ sql: iamDb }),
      rootTenantId: () => rootTenantId,
    });
    const f = await iamFixture({ plugins: [host.plugin], resolveResource: host.resolveResource });
    rootTenantId = f.rootTenantId;
    await host.start();
    try {
      const bridge = createComputeIamBridge();
      const port = bridge.remote({
        baseURL: 'http://localhost:3000',
        fetch: async (input, init) => f.iam.handler(new Request(input, init)),
        serviceToken: f.rootCredential.token,
        rootTenantId: f.rootTenantId,
        iamDatabase: iamDb,
      });
      expect(bridge.flags).toBe(port.flags);
      expect(() => bridge.embedded(f.iam)).toThrow(/already called/);
      const [module] = bridge.modules;
      const pull = module.reconcilers!.find((reconciler) => reconciler.name === 'iam.pull')!;
      expect(pull.periodic).toEqual([{ key: 'pull', every: '1s' }]);

      await f.member('carol');
      expect(await port.authenticate(await f.signIn('carol'))).toMatchObject({
        tenantId: f.tenantId,
      });
      const agent = await f.iam.api.agents.create(f.ownerCredential, {
        tenantId: f.tenantId,
        name: 'Nightly',
        model: 'claude-sonnet-5',
      });
      await f.iam.api.agents.suspend(f.ownerCredential, {
        tenantId: f.tenantId,
        agentId: agent.id,
      });
      await f.iam.events.dispatch();
      expect(await pull.run({ sql: computeDb } as never, 'pull')).toBe('DONE');
      const { rows } = await computeDb.query<{ action: string }>('SELECT action FROM iam_inbox');
      expect(rows.map((row) => row.action)).toContain('agent:suspend');
    } finally {
      host.stop();
    }
  });
});

describe('postgresInbox and pullRemoteInbox', () => {
  it('creates its table once, dedupes, pages, and tolerates a missing table', async () => {
    expect(await pullRemoteInbox(iamDb, computeDb)).toEqual({ moved: 0, more: false });
    const inbox = postgresInbox({ sql: iamDb, clock: manualClock(1_700_000_000_000) });
    await Promise.all([inbox.ensure!(), inbox.ensure!()]);
    await inbox.put([event('e1', 1), event('e2', 2), event('e3', 3)]);
    await inbox.put([event('e1', 1)]);
    expect((await iamDb.query('SELECT 1 FROM compute_inbox')).rows).toHaveLength(3);
    expect(await pullRemoteInbox(iamDb, computeDb, { limit: 2 })).toEqual({ moved: 2, more: true });
    expect(await pullRemoteInbox(iamDb, computeDb, { limit: 2 })).toEqual({
      moved: 1,
      more: false,
    });
    const { rows } = await computeDb.query<{ event_id: string; occurred_at: Date }>(
      'SELECT event_id, occurred_at FROM iam_inbox ORDER BY event_id',
    );
    expect(rows.map((row) => row.event_id)).toEqual(['e1', 'e2', 'e3']);
    expect(new Date(rows[1]!.occurred_at).getTime()).toBe(1_700_000_000_002);
    expect(() => postgresInbox({ sql: iamDb, table: 'bad; drop' })).toThrow(/Invalid table/);
  });
});

describe('httpInbox and createInboxHandler', () => {
  it('delivers signed batches and rejects forged, stale or malformed ones', async () => {
    const clock = manualClock(1_700_000_000_000);
    const received = memoryInbox();
    const handler = createInboxHandler({ secret, inbox: received, clock });
    let last: Request | undefined;
    const writer = httpInbox({
      url: 'https://compute.test/api/compute/iam/inbox',
      secret,
      clock,
      fetch: async (input, init) => {
        last = new Request(input, init);
        return handler(last.clone());
      },
    });
    await writer.put([event('h1'), event('h2', 2)]);
    expect(received.events.map((item) => item.eventId)).toEqual(['h1', 'h2']);

    const body = await last!.clone().text();
    const signature = last!.headers.get('x-better-compute-signature')!;
    const post = (headers: Record<string, string>, payload = body) =>
      handler(new Request('https://compute.test/x', { method: 'POST', headers, body: payload }));
    expect((await post({ 'x-better-compute-signature': signature })).status).toBe(200);
    expect(
      (await post({ 'x-better-compute-signature': signature }, body.replace('h1', 'hx'))).status,
    ).toBe(401);
    expect((await post({})).status).toBe(401);
    clock.advance(301_000);
    expect((await post({ 'x-better-compute-signature': signature })).status).toBe(401);
    expect((await handler(new Request('https://compute.test/x'))).status).toBe(405);

    const failing = httpInbox({
      url: 'https://compute.test/x',
      secret,
      fetch: async () => new Response('nope', { status: 503 }),
    });
    await expect(failing.put([event('h3')])).rejects.toMatchObject({ code: 'DRIVER_ERROR' });
    expect(() => httpInbox({ url: 'x', secret: 'short' })).toThrow(/32 characters/);

    const malformed = createInboxHandler({ secret, inbox: received, clock: manualClock(5) });
    const bad = JSON.stringify({ events: [{ eventId: 1 }] });
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', secret).update(`5.${bad}`).digest('hex');
    const response = await malformed(
      new Request('https://compute.test/x', {
        method: 'POST',
        headers: { 'x-better-compute-signature': `t=5,v1=${sig}` },
        body: bad,
      }),
    );
    expect(response.status).toBe(400);
  });
});
