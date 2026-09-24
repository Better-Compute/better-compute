import { afterEach, describe, expect, it } from 'vitest';
import { eventsModule, verifyWebhookSignature, webhookHeaders } from '@better-compute/events';
import { closeFixtures, computeFixture } from '@better-compute/testing';

// The events module inside the real control plane (PLAN.md §9.3, v0.3 webhooks): webhooks receive the events the
// W5a runtime publishes through its outbox — here the operator's own site, pool and join-token events — signed
// with the webhook's secret, in commit order, and only for the tenant that owns the webhook.

afterEach(closeFixtures);

interface Received {
  url: string;
  type: string;
  body: string;
  headers: Headers;
}

function receiver() {
  const received: Received[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? '');
    received.push({
      url: String(input),
      type: headers.get(webhookHeaders.event) ?? '',
      body,
      headers,
    });
    return new Response('ok', { status: 200 });
  };
  return { received, fetch: fetch as typeof globalThis.fetch };
}

describe('events module on the W5a runtime', () => {
  it("delivers the runtime's outbox events to the owning tenant's webhooks, signed and in order", async () => {
    const { received, fetch } = receiver();
    const fixture = await computeFixture({
      clock: 'sim',
      modules: [
        eventsModule({
          secret: 'better-compute-events-spine-secret-0123456789',
          fetch,
          // hooks.example.test resolves to a public address (the SSRF guard checks it before every send).
          delivery: { resolve: async () => ['93.184.216.34'] },
        }),
      ],
    });
    const { compute, tenants, iam } = fixture;
    iam.allow({ token: tenants.root.token });
    iam.allow({ token: tenants.acme.token, action: 'compute:webhooks:manage' });
    const root = { token: tenants.root.token };
    const acme = { token: tenants.acme.token };

    const rootHook = await compute.api.webhooks.create(root, {
      tenantId: tenants.root.id,
      url: 'https://hooks.example.test/root',
      events: ['site.*', 'pool.*', 'security.*'],
    });
    const acmeHook = await compute.api.webhooks.create(acme, {
      tenantId: tenants.acme.id,
      url: 'https://hooks.example.test/acme',
      events: ['*'],
    });

    const site = await compute.api.sites.create(root, {
      tenantId: tenants.root.id,
      kind: 'shared',
      region: 'eu-west-1',
      idempotencyKey: 'events-site',
    });
    const pool = await compute.api.pools.create(root, {
      tenantId: tenants.root.id,
      siteId: site.id,
      class: 'metal-host',
      gpuModel: 'H100',
      idempotencyKey: 'events-pool',
    } as never);
    await compute.api.joinTokens.create(root, {
      tenantId: tenants.root.id,
      poolId: pool.id,
      ttlSeconds: 3600,
      idempotencyKey: 'events-token',
    });

    for (let pass = 0; pass < 5; pass++) {
      await fixture.advance(2_000);
      await compute.jobs['events.fanout']!.tick();
      await compute.jobs['events.deliver']!.tick();
    }

    const toRoot = received.filter((item) => item.url.endsWith('/root'));
    expect(toRoot.map((item) => item.type)).toEqual([
      'site.created',
      'pool.created',
      'security.join-token.created',
    ]);
    for (const item of toRoot) {
      expect(
        verifyWebhookSignature({
          secret: rootHook.secret,
          signature: item.headers.get(webhookHeaders.signature)!,
          timestamp: item.headers.get(webhookHeaders.timestamp)!,
          body: item.body,
          now: fixture.clock.now(),
        }),
      ).toBe(true);
      // Another webhook's secret does not verify it.
      expect(
        verifyWebhookSignature({
          secret: acmeHook.secret,
          signature: item.headers.get(webhookHeaders.signature)!,
          timestamp: item.headers.get(webhookHeaders.timestamp)!,
          body: item.body,
          now: fixture.clock.now(),
        }),
      ).toBe(false);
      expect(JSON.parse(item.body)).toMatchObject({ tenantId: tenants.root.id });
    }
    expect(JSON.parse(toRoot[0]!.body)).toMatchObject({
      type: 'site.created',
      subject: `site/${site.id}`,
    });
    // Acme subscribed to everything but owns none of these events.
    expect(received.filter((item) => item.url.endsWith('/acme'))).toEqual([]);

    const deliveries = await compute.api.webhooks.deliveries(root, {
      tenantId: tenants.root.id,
      webhookId: rootHook.webhook.id,
    });
    expect(deliveries.items.map((delivery) => delivery.state)).toEqual([
      'delivered',
      'delivered',
      'delivered',
    ]);
  });
});
