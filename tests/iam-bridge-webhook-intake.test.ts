import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import {
  computeIamEventPatterns,
  createIamWebhookHandler,
  sqlInbox,
  successorsMigration,
} from '@better-compute/iam';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';
import { pglite } from '@better-compute/postgres/pglite';

// Remote-mode event intake, fallback (PLAN.md §12.8): a root subtree webhook from better-iam into compute's inbox,
// verified like better-iam's verifyWebhookSignature and deduped on the audit event id.

interface Delivery {
  id: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

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
  await db.query('DELETE FROM iam_inbox');
});

const post = (delivery: Pick<Delivery, 'body' | 'headers'>) =>
  new Request('https://compute.test/iam/events', {
    method: 'POST',
    headers: delivery.headers,
    body: delivery.body,
  });

describe('createIamWebhookHandler', () => {
  it('takes a real subtree subscription’s deliveries into the inbox, once, and ignores the rest', async () => {
    const deliveries: Delivery[] = [];
    const t = await createEmbeddedTestIam({
      inbox: 'memory',
      iamOptions: {
        events: {
          deliverWebhook: async (delivery: Delivery) => {
            deliveries.push(delivery);
          },
        },
      } as never,
    });
    open.push(t);
    const hook = (await t.iam.api.webhooks.create(t.root.credential, {
      tenantId: t.root.tenantId,
      url: 'https://compute.example.com/iam/events',
      events: [...computeIamEventPatterns],
      scope: 'subtree',
      outcomes: ['allow'],
    })) as { secret: string };
    const handler = createIamWebhookHandler({ secret: hook.secret, inbox: sqlInbox(db) });

    // An agent in a child organization is suspended: the subtree subscription delivers it.
    const agent = await t.iam.api.agents.create(t.acme.owner, {
      tenantId: t.acme.tenantId,
      name: 'Operator',
      model: 'claude-sonnet-5',
    });
    await t.iam.api.agents.suspend(t.acme.owner, { tenantId: t.acme.tenantId, agentId: agent.id });
    await t.dispatch();
    await t.iam.auth.dispatchOutbox();
    const suspended = deliveries.filter((d) => d.headers['x-better-iam-event'] === 'agent:suspend');
    expect(suspended).toHaveLength(1);

    const answer = await handler(post(suspended[0]!));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ accepted: 1 });
    // A redelivery of the same event lands once.
    expect((await handler(post(suspended[0]!))).status).toBe(200);
    const { rows } = await db.query<{
      tenant_id: string;
      action: string;
      body: { resourceId: string };
    }>('SELECT tenant_id, action, body FROM iam_inbox');
    expect(rows).toEqual([
      expect.objectContaining({
        tenant_id: t.acme.tenantId,
        action: 'agent:suspend',
        body: expect.objectContaining({ resourceId: agent.id }),
      }),
    ]);

    // Tampered, stale and unsigned deliveries are refused; an unrelated event is accepted and dropped.
    const delivery = suspended[0]!;
    expect(
      (
        await handler(
          post({ ...delivery, body: delivery.body.replace('agent:suspend', 'agent:delete') }),
        )
      ).status,
    ).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const staleSignature = createHmac('sha256', hook.secret)
      .update(`${stale}.${delivery.body}`)
      .digest('hex');
    expect(
      (
        await handler(
          post({
            body: delivery.body,
            headers: {
              'x-better-iam-timestamp': String(stale),
              'x-better-iam-signature': `v1=${staleSignature}`,
            },
          }),
        )
      ).status,
    ).toBe(401);
    expect((await handler(post({ body: delivery.body, headers: {} }))).status).toBe(401);
    const now = Math.floor(Date.now() / 1000);
    const unrelated = JSON.stringify({
      id: 'evt_x',
      type: 'iam:webhooks:create',
      tenantId: t.root.tenantId,
      outcome: 'allow',
      timestamp: Date.now(),
    });
    const signed = createHmac('sha256', hook.secret).update(`${now}.${unrelated}`).digest('hex');
    const ignored = await handler(
      post({
        body: unrelated,
        headers: {
          'x-better-iam-timestamp': String(now),
          'x-better-iam-signature': `v1=${signed}`,
        },
      }),
    );
    expect(await ignored.json()).toEqual({ accepted: 0 });
    expect((await db.query('SELECT 1 FROM iam_inbox')).rows).toHaveLength(1);
    expect((await handler(new Request('https://compute.test/iam/events'))).status).toBe(405);
  }, 60_000);
});
