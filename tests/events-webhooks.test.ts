import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isComputeError,
  systemClock,
  type MethodContext,
  type SqlExecutor,
} from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  assertPublicDestination,
  checkWebhookUrl,
  deliverWebhooks,
  eventsMigrations,
  eventsModule,
  fanOutWebhooks,
  formatCursor,
  isNonPublicAddress,
  matchesEventType,
  openSecret,
  outboxTail,
  parseCursor,
  pruneWebhookDeliveries,
  purgeTenantWebhooks,
  readOutbox,
  sealSecret,
  signatureHeader,
  verifyWebhookSignature,
  webhookHeaders,
  webhookStore,
} from '@better-compute/events';

// v0.3 event delivery (PLAN.md §9.3): webhooks signed like better-iam's, retries, dead letters, redelivery.

const secret = 'events-test-deployment-secret-of-32-chars!';
let db: SqlExecutor;

beforeAll(async () => {
  db = pglite();
  await db.migrate([...eventsMigrations]);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  for (const table of ['webhook_deliveries', 'webhooks', 'event_cursors', 'outbox'])
    await db.query(`DELETE FROM ${table}`);
});

const emit = (tenantId: string, type: string, n = 1) =>
  db.transaction(async (tx) => {
    for (let i = 0; i < n; i++)
      await tx.query(`INSERT INTO outbox (topic, payload) VALUES ($1, $2::jsonb)`, [
        type,
        JSON.stringify({
          id: `evt_${type}_${i}_${Math.random().toString(36).slice(2)}`,
          type,
          tenantId,
          subject: `reservation/rsv_${i}`,
          time: new Date().toISOString(),
          data: { n: i },
        }),
      ]);
  });

/** A receiver that verifies signatures the way a customer endpoint would. */
function receiver(status = () => 200) {
  const received: {
    body: Record<string, unknown>;
    headers: Headers;
    verified: (s: string) => boolean;
  }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.text();
    const headers = request.headers;
    received.push({
      body: JSON.parse(body),
      headers,
      verified: (key) =>
        verifyWebhookSignature({
          secret: key,
          signature: headers.get(webhookHeaders.signature)!,
          timestamp: headers.get(webhookHeaders.timestamp)!,
          body,
        }),
    });
    return new Response('ok', { status: status() });
  };
  return { received, fetch };
}

describe('signatures, sealing, URLs and cursors', () => {
  it('signs like better-iam and verifies any live secret within the tolerance', () => {
    const now = 1_700_000_000_000;
    const ts = now / 1000;
    const header = signatureHeader(['new-secret', 'old-secret'], ts, '{"a":1}');
    expect(header).toMatch(/^v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
    const verify = (key: string, extra: object = {}) =>
      verifyWebhookSignature({
        secret: key,
        signature: header,
        timestamp: ts,
        body: '{"a":1}',
        now,
        ...extra,
      });
    expect(verify('new-secret')).toBe(true);
    expect(verify('old-secret')).toBe(true);
    expect(verify('other')).toBe(false);
    expect(verify('new-secret', { body: '{"a":2}' })).toBe(false);
    expect(verify('new-secret', { now: now + 301_000 })).toBe(false);
    expect(verify('new-secret', { timestamp: 'x' })).toBe(false);
  });

  it('seals signing secrets per webhook and opens them with previous deployment secrets', () => {
    const sealed = sealSecret('whsec_abc', secret, 'webhook:whk_1');
    expect(sealed).toMatch(/^v1\./);
    expect(openSecret(sealed, [secret], 'webhook:whk_1')).toBe('whsec_abc');
    expect(
      openSecret(sealed, ['a-newer-deployment-secret-32-chars!!', secret], 'webhook:whk_1'),
    ).toBe('whsec_abc');
    expect(() => openSecret(sealed, [secret], 'webhook:whk_2')).toThrow(/cannot be opened/);
  });

  it('refuses SSRF-prone webhook URLs', async () => {
    expect(checkWebhookUrl('https://hooks.example.com/x#frag')).toBe('https://hooks.example.com/x');
    for (const bad of [
      'http://hooks.example.com',
      'https://user:pw@hooks.example.com',
      'https://127.0.0.1/x',
      'https://10.1.2.3',
      'https://[::1]/',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost:8080',
      'https://metadata.google.internal',
      'not a url',
    ])
      expect(() => checkWebhookUrl(bad), bad).toThrow();
    expect(checkWebhookUrl('http://localhost:9', { allowInsecure: true, allowPrivate: true })).toBe(
      'http://localhost:9/',
    );
    for (const address of [
      '10.0.0.1',
      '172.20.1.1',
      '192.168.1.1',
      '100.64.0.1',
      '::ffff:127.0.0.1',
      'fd00::1',
      'fe80::1',
    ])
      expect(isNonPublicAddress(address), address).toBe(true);
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
      expect(isNonPublicAddress(address), address).toBe(false);
    await expect(
      assertPublicDestination('https://rebind.example.com', {}, async () => [
        '93.184.216.34',
        '10.0.0.5',
      ]),
    ).rejects.toMatchObject({ code: 'DRIVER_ERROR' });
    await expect(
      assertPublicDestination('https://ok.example.com', {}, async () => ['93.184.216.34']),
    ).resolves.toBeUndefined();
  });

  it('pages the outbox by (txid, seq) across a digit boundary, per tenant', async () => {
    await emit('ten_a', 'reservation.placed', 25);
    await emit('ten_b', 'node.connected', 3);
    const seen: string[] = [];
    let after = { txid: '0', seq: '0' };
    for (;;) {
      const page = await readOutbox(db, { after, limit: 7, tenantId: 'ten_a' });
      seen.push(...page.events.map((event) => event.subject));
      after = page.cursor;
      if (!page.more) break;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    const all = await readOutbox(db, { limit: 100 });
    expect(all.events).toHaveLength(28);
    expect(all.events[0]).toMatchObject({
      type: 'reservation.placed',
      tenantId: 'ten_a',
      sequence: expect.stringMatching(/^\d+\.\d+$/),
      data: { n: 0 },
    });
    expect(formatCursor(await outboxTail(db))).toBe(all.events.at(-1)!.sequence);
    expect(parseCursor(' 12.34 ')).toEqual({ txid: '12', seq: '34' });
    expect(() => parseCursor('12;34')).toThrow();
    expect(matchesEventType('*', 'x.y')).toBe(true);
    expect(matchesEventType('reservation.*', 'reservation.placed')).toBe(true);
    expect(matchesEventType('reservation.*', 'reservations.placed')).toBe(false);
    expect(matchesEventType('node.connected', 'node.connected')).toBe(true);
  });
});

describe('webhook delivery', () => {
  const policy = { secret, allowPrivate: false as const };
  const store = webhookStore({ ...policy, clock: systemClock });
  const resolve = async () => ['93.184.216.34'];

  it("purges a deleted tenant's subscriptions and their deliveries, in batches (§12.8)", async () => {
    await fanOutWebhooks(db);
    for (const url of [
      'https://a1.example.com/in',
      'https://a2.example.com/in',
      'https://a3.example.com/in',
    ])
      await db.transaction((tx) => store.create(tx, { tenantId: 'ten_a', url, events: ['*'] }));
    await db.transaction((tx) =>
      store.create(tx, { tenantId: 'ten_b', url: 'https://b.example.com/in', events: ['*'] }),
    );
    await emit('ten_a', 'reservation.released');
    await emit('ten_b', 'reservation.released');
    expect(await fanOutWebhooks(db)).toMatchObject({ queued: 4 });
    // Two per call: the third subscription needs a second pass.
    expect(await purgeTenantWebhooks(db, 'ten_a', 2)).toBe('SYNC_AGAIN');
    expect(await purgeTenantWebhooks(db, 'ten_a', 2)).toBe('DONE');
    expect(await purgeTenantWebhooks(db, 'ten_a', 2)).toBe('DONE');
    const deliveries = await db.query<{ tenant_id: string; n: number }>(
      'SELECT tenant_id, count(*)::int AS n FROM webhook_deliveries GROUP BY tenant_id',
    );
    expect(deliveries.rows).toEqual([{ tenant_id: 'ten_b', n: 1 }]);
    const hooks = await db.query<{ tenant_id: string }>('SELECT tenant_id FROM webhooks');
    expect(hooks.rows).toEqual([{ tenant_id: 'ten_b' }]);
    // The events module runs it as its tenancy teardown hook.
    expect(typeof eventsModule({ secret }).tenantDeleted).toBe('function');
  });

  it('fans out matching events once and delivers them signed with the returned secret', async () => {
    await fanOutWebhooks(db); // starts the cursor at the tail: no history replay
    const { webhook, secret: signing } = await db.transaction((tx) =>
      store.create(tx, {
        tenantId: 'ten_a',
        url: 'https://hooks.example.com/in',
        events: ['reservation.*'],
      }),
    );
    await db.transaction((tx) =>
      store.create(tx, { tenantId: 'ten_b', url: 'https://b.example.com/in', events: ['*'] }),
    );
    await emit('ten_a', 'reservation.placed', 2);
    await emit('ten_a', 'node.connected');
    await emit('ten_c', 'reservation.placed');
    expect(await fanOutWebhooks(db)).toMatchObject({ events: 4, queued: 2 });
    expect(await fanOutWebhooks(db)).toMatchObject({ events: 0, queued: 0 });

    const r = receiver();
    expect(await deliverWebhooks(db, { ...policy, fetch: r.fetch, resolve })).toMatchObject({
      attempted: 2,
      delivered: 2,
    });
    expect(r.received).toHaveLength(2);
    for (const item of r.received) {
      expect(item.verified(signing)).toBe(true);
      expect(item.headers.get(webhookHeaders.webhook)).toBe(webhook.id);
      expect(item.headers.get(webhookHeaders.event)).toBe('reservation.placed');
      expect(item.headers.get(webhookHeaders.delivery)).toMatch(/^dlv_/);
      expect(item.body).toMatchObject({ type: 'reservation.placed', tenantId: 'ten_a' });
    }
    expect(await deliverWebhooks(db, { ...policy, fetch: r.fetch, resolve })).toMatchObject({
      attempted: 0,
    });
    const history = await db.transaction((tx) => store.deliveries(tx, 'ten_a', webhook.id));
    expect(history.map((item) => item.state)).toEqual(['delivered', 'delivered']);
  });

  it('retries with backoff, dead-letters after maxAttempts, and redelivers on request', async () => {
    await fanOutWebhooks(db);
    const { webhook } = await db.transaction((tx) =>
      store.create(tx, { tenantId: 'ten_a', url: 'https://hooks.example.com/in', events: ['*'] }),
    );
    await emit('ten_a', 'reservation.failed');
    await fanOutWebhooks(db);
    let status = 503;
    const r = receiver(() => status);
    const options = { ...policy, fetch: r.fetch, resolve, maxAttempts: 2, backoffSeconds: [0] };
    expect(await deliverWebhooks(db, options)).toMatchObject({ failed: 1, dead: 0 });
    expect(await deliverWebhooks(db, options)).toMatchObject({ dead: 1 });
    const [dead] = await db.transaction((tx) =>
      store.deliveries(tx, 'ten_a', webhook.id, { state: 'dead' }),
    );
    expect(dead).toMatchObject({
      attempts: 2,
      lastStatus: 503,
      lastError: expect.stringMatching(/503/),
    });
    expect(await deliverWebhooks(db, options)).toMatchObject({ attempted: 0 });

    // Default backoff keeps a failed delivery out of the next pass.
    status = 200;
    const again = await db.transaction((tx) => store.redeliver(tx, 'ten_a', dead!.id));
    expect(again).toMatchObject({ state: 'pending', attempts: 0 });
    expect(await deliverWebhooks(db, options)).toMatchObject({ delivered: 1 });
    await expect(
      db.transaction((tx) => store.redeliver(tx, 'ten_b', dead!.id)),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(r.received.map((item) => item.headers.get(webhookHeaders.delivery))).toEqual([
      dead!.id,
      dead!.id,
      dead!.id,
    ]);
  });

  it('backs off failed deliveries by the schedule', async () => {
    await fanOutWebhooks(db);
    await db.transaction((tx) =>
      store.create(tx, { tenantId: 'ten_a', url: 'https://hooks.example.com/in', events: ['*'] }),
    );
    await emit('ten_a', 'x.y');
    await fanOutWebhooks(db);
    const r = receiver(() => 500);
    expect(await deliverWebhooks(db, { ...policy, fetch: r.fetch, resolve })).toMatchObject({
      failed: 1,
    });
    const { rows } = await db.query<{ wait: number }>(
      `SELECT extract(epoch FROM next_attempt_at - compute_now())::int AS wait FROM webhook_deliveries`,
    );
    expect(rows[0]!.wait).toBeGreaterThan(50);
    expect(await deliverWebhooks(db, { ...policy, fetch: r.fetch, resolve })).toMatchObject({
      attempted: 0,
    });
  });

  it('signs with both secrets during a rotation, cancels paused webhooks, refuses non-public hosts', async () => {
    await fanOutWebhooks(db);
    const created = await db.transaction((tx) =>
      store.create(tx, { tenantId: 'ten_a', url: 'https://hooks.example.com/in', events: ['*'] }),
    );
    const rotated = await db.transaction((tx) =>
      store.rotateSecret(tx, 'ten_a', created.webhook.id, 3600),
    );
    expect(rotated.webhook.previousSecretExpiresAt).toBeGreaterThan(Date.now());
    await db.transaction((tx) => store.ping(tx, 'ten_a', created.webhook.id));
    const r = receiver();
    await deliverWebhooks(db, { ...policy, fetch: r.fetch, resolve });
    expect(r.received[0]!.body).toMatchObject({ type: 'webhook.ping' });
    expect(r.received[0]!.verified(rotated.secret)).toBe(true);
    expect(r.received[0]!.verified(created.secret)).toBe(true);

    // A resolved private address is refused at delivery time (DNS rebinding).
    await db.transaction((tx) => store.ping(tx, 'ten_a', created.webhook.id));
    const refused = await deliverWebhooks(db, {
      ...policy,
      fetch: r.fetch,
      resolve: async () => ['10.0.0.9'],
    });
    expect(refused).toMatchObject({ failed: 1 });
    expect(r.received).toHaveLength(1);

    await db.transaction((tx) => store.update(tx, 'ten_a', created.webhook.id, { active: false }));
    const states = await db.query<{ state: string }>(
      'SELECT state FROM webhook_deliveries ORDER BY created_at',
    );
    expect(states.rows.map((row) => row.state)).toEqual(['delivered', 'cancelled']);
  });

  it('keeps tenants apart and bounds webhooks per tenant', async () => {
    const small = webhookStore({ secret, maxPerTenant: 2 });
    const create = (tenantId: string) =>
      db.transaction((tx) =>
        small.create(tx, { tenantId, url: 'https://h.example.com', events: ['*'] }),
      );
    const { webhook } = await create('ten_a');
    await create('ten_a');
    await expect(create('ten_a')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await expect(db.transaction((tx) => small.get(tx, 'ten_b', webhook.id))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      db.transaction((tx) => small.delete(tx, 'ten_b', webhook.id)),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await db.transaction((tx) => small.list(tx, 'ten_b'))).toEqual([]);
    expect(() => webhookStore({ secret: 'short' })).toThrow(/32 characters/);
  });
});

describe('pruneWebhookDeliveries', () => {
  it('deletes settled deliveries past their retention in batches, never pending ones', async () => {
    const store = webhookStore({ secret });
    const { webhook } = await db.transaction((tx) =>
      store.create(tx, {
        tenantId: 'ten_a',
        url: 'https://hooks.example.com/in',
        events: ['*'],
      }),
    );
    const day = 86_400_000;
    const rows: [string, string, number][] = [
      ['d-old', 'delivered', 31 * day],
      ['d-new', 'delivered', 29 * day],
      ['c-old', 'cancelled', 40 * day],
      ['x-old', 'dead', 91 * day],
      ['x-new', 'dead', 31 * day],
      ['p-old', 'pending', 400 * day],
    ];
    for (const [id, state, age] of rows)
      await db.query(
        `INSERT INTO webhook_deliveries (id, webhook_id, tenant_id, event_id, event_type, body, state, created_at)
         VALUES ($1, $2, 'ten_a', $1, 'node.connected', '{}', $3, compute_now() - make_interval(secs => $4::float8 / 1000))`,
        [id, webhook.id, state, age],
      );
    const ids = async () =>
      (await db.query<{ id: string }>('SELECT id FROM webhook_deliveries ORDER BY id')).rows.map(
        (row) => row.id,
      );
    expect(await pruneWebhookDeliveries(db, {}, 2)).toBe(2);
    expect(await pruneWebhookDeliveries(db, {}, 2)).toBe(1);
    expect(await pruneWebhookDeliveries(db)).toBe(0);
    expect(await ids()).toEqual(['d-new', 'p-old', 'x-new']);
    // Shorter periods reach the rest, except the pending delivery.
    expect(await pruneWebhookDeliveries(db, { deliveredDays: 1, deadDays: 1 })).toBe(2);
    expect(await ids()).toEqual(['p-old']);
    await expect(pruneWebhookDeliveries(db, { deliveredDays: 0.5 })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });
});

describe('eventsModule', () => {
  it('declares the §9.2 webhooks group on compute-tenant/{t} and validates input strictly', async () => {
    const module = eventsModule({ secret });
    expect(module.name).toBe('events');
    expect(module.migrations?.map((migration) => migration.name)).toEqual([
      'events/0001_webhooks',
      'events/0002_delivery_retention',
      'events/0003_webhooks_by_tenant',
    ]);
    expect(module.reconcilers?.map((reconciler) => reconciler.name)).toEqual([
      'events.fanout',
      'events.deliver',
      'events.prune',
    ]);
    expect(
      eventsModule({ secret, retention: false }).reconcilers?.map((reconciler) => reconciler.name),
    ).toEqual(['events.fanout', 'events.deliver']);
    expect(() => eventsModule({ secret, retention: { deadDays: 0 } })).toThrow(/deadDays/);
    const api = module.api!({} as never).webhooks;
    for (const name of [
      'create',
      'list',
      'get',
      'update',
      'rotateSecret',
      'delete',
      'ping',
    ] as const) {
      expect(api[name].action).toBe('compute:webhooks:manage');
      expect(api[name].resource({ tenantId: 'ten_a' } as never)).toEqual({
        type: 'tenant',
        id: 'ten_a',
      });
    }
    expect(api.list.kind).toBe('read');
    expect(api.create.kind).toBe('mutation');

    const ctx = { sql: db, clock: systemClock, requestId: 'req_1' } as unknown as MethodContext;
    const input = api.create.validate({
      tenantId: 'ten_a',
      url: 'https://hooks.example.com/in',
      events: ['reservation.*', 'node.connected'],
    });
    const created = await api.create.handler(ctx, input);
    expect(created.secret).toMatch(/^whsec_/);
    const listed = await api.list.handler(ctx, api.list.validate({ tenantId: 'ten_a' }));
    expect(listed.items.map((item) => item.id)).toEqual([created.webhook.id]);
    const updated = await api.update.handler(
      ctx,
      api.update.validate({ tenantId: 'ten_a', webhookId: created.webhook.id, description: 'ops' }),
    );
    expect(updated).toMatchObject({ description: 'ops', version: 2 });
    await api.delete.handler(
      ctx,
      api.delete.validate({ tenantId: 'ten_a', webhookId: created.webhook.id }),
    );

    for (const bad of [
      { tenantId: 'ten_a', url: 'https://h.example.com', events: [] },
      { tenantId: 'ten_a', url: 'https://h.example.com', events: ['Bad Pattern'] },
      { tenantId: 'ten_a', url: 'https://h.example.com', events: ['*'], extra: 1 },
      { tenantId: 'ten a', url: 'https://h.example.com', events: ['*'] },
    ]) {
      let error: unknown;
      try {
        api.create.validate(bad);
      } catch (caught) {
        error = caught;
      }
      expect(isComputeError(error, 'INVALID_INPUT'), JSON.stringify(bad)).toBe(true);
    }
  });
});
