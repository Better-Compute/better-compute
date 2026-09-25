import { afterEach, describe, expect, it } from 'vitest';
import { createComputeClient } from '@better-compute/client';
import { createWebhooksView, deliverySummary, type ComputeRequester } from '@better-compute/console-kit';
import { eventsModule } from '@better-compute/events';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { ACME, BASE_URL, SECRET, options } from './support/server.js';

// console-kit's webhooks view over a real server with the events module: list, create (the secret shown once),
// pause, rotate, ping, deliveries, delete.

let compute: BetterCompute<any, any> | undefined;
afterEach(async () => {
  await compute?.stop().catch(() => undefined);
  compute = undefined;
});

describe('webhooks view', () => {
  it('manages a tenant’s webhooks through the events module', { timeout: 60_000 }, async () => {
    const iam = fakeIam({
      callers: {
        biam_ses_console_webhooks_acme: {
          identityId: 'identity-acme-admin',
          identityKind: 'user',
          tenantId: ACME,
          sessionId: 'session-acme',
          sessionKind: 'user',
          mfa: true,
        },
      },
      allow: [{}],
    });
    compute = betterCompute({
      ...options(pglite(), iam),
      modules: [eventsModule({ secret: SECRET })],
    } as never) as BetterCompute<any, any>;
    await compute.initialize();
    const api = createComputeClient({
      baseURL: BASE_URL,
      token: 'biam_ses_console_webhooks_acme',
      fetch: async (input, init) => compute!.handler(new Request(input, init)),
    }) as unknown as ComputeRequester;

    const view = createWebhooksView(api, { tenantId: ACME });
    await view.refresh();
    expect(view.get().error).toBeUndefined();
    expect(view.get().value?.items).toEqual([]);

    const created = await view.create({
      url: 'https://hooks.example.com/compute',
      events: ['reservation.*', 'node.connected'],
      description: 'on-call',
    });
    expect(created).toMatchObject({ url: 'https://hooks.example.com/compute', active: true });
    // The secret is shown once, then dismissed; the list never carries it.
    expect(view.secret.get()).toEqual({ webhookId: created.id, secret: expect.any(String) });
    expect(JSON.stringify(view.get().value)).not.toContain(view.secret.get()!.secret);
    view.dismissSecret();
    expect(view.secret.get()).toBeUndefined();
    expect(view.get().value?.items.map((row) => row.id)).toEqual([created.id]);

    const paused = await view.setActive(created.id, false);
    expect(paused.active).toBe(false);
    const rotated = await view.rotateSecret(created.id, 3600);
    expect(rotated.previousSecretExpiresAt).toBeGreaterThan(Date.now());
    expect(view.secret.get()?.webhookId).toBe(created.id);

    await view.setActive(created.id, true);
    const ping = await view.ping(created.id);
    expect(ping).toMatchObject({ webhookId: created.id, eventType: expect.stringContaining('ping') });
    const deliveries = await view.deliveries(created.id);
    expect(deliveries.map((row) => row.id)).toContain(ping.id);
    expect(deliverySummary(deliveries).pending + deliverySummary(deliveries).delivered).toBeGreaterThan(0);
    expect(Array.isArray(await view.eventTypes())).toBe(true);

    await view.remove(created.id);
    expect(view.get().value?.items).toEqual([]);
    expect(view.secret.get()).toBeUndefined();
  });

  it('summarizes deliveries and the latest failure', () => {
    const row = (id: string, state: 'pending' | 'delivered' | 'dead', at: number, extra = {}) => ({
      id,
      webhookId: 'wh',
      eventId: `e-${id}`,
      eventType: 'reservation.placed',
      state,
      attempts: 1,
      nextAttemptAt: 0,
      createdAt: at,
      ...extra,
    });
    expect(
      deliverySummary([
        row('a', 'delivered', 1),
        row('b', 'dead', 2, { lastStatus: 500 }),
        row('c', 'pending', 3, { lastError: 'connect ECONNREFUSED' }),
      ]),
    ).toEqual({
      pending: 1,
      delivered: 1,
      dead: 1,
      cancelled: 0,
      lastFailure: { eventType: 'reservation.placed', error: 'connect ECONNREFUSED', at: 3 },
    });
  });
});
