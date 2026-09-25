import { afterEach, describe, expect, it } from 'vitest';
import { isComputeError } from '@better-compute/core';
import {
  eventCatalog,
  eventFamilyOf,
  eventsModule,
  isKnownEventPattern,
} from '@better-compute/events';
import {
  closeFixtures,
  computeFixture,
  createControlPlaneSim,
  type ControlPlaneSim,
} from '@better-compute/testing';

// The event catalog (PLAN.md §9.3): subscriptions are checked against the families the control plane publishes,
// and every topic a real run writes to the outbox belongs to a family (the catalog does not drift from the code).

let rig: ControlPlaneSim | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
  await closeFixtures();
});

describe('eventCatalog', () => {
  it('accepts patterns that can match a published event and refuses the rest', () => {
    for (const pattern of [
      '*',
      'node.*',
      'node.adopted',
      'node.gpu.*',
      'node.gpu.added',
      'reservation.active',
      'security.*',
    ])
      expect(isKnownEventPattern(pattern), pattern).toBe(true);
    for (const pattern of ['nodes.*', 'node', 'reservations.active', 'gpu.added', 'webhook.*.x'])
      expect(isKnownEventPattern(pattern), pattern).toBe(false);
    expect(isKnownEventPattern('plugin.acme.*')).toBe(false);
    expect(
      isKnownEventPattern('plugin.acme.*', [
        ...eventCatalog,
        { type: 'plugin.acme.*', subject: 'acme/{id}', module: 'acme', description: 'Acme' },
      ]),
    ).toBe(true);
    expect(eventFamilyOf('node.gpu.added')?.module).toBe('inventory');
    expect(eventFamilyOf('node.adopted')?.module).toBe('server');
    expect(eventFamilyOf('nodes.adopted')).toBeUndefined();
  });

  it('refuses unknown subscriptions in webhooks.create and update, and lists the catalog', async () => {
    const fixture = await computeFixture({
      modules: [eventsModule({ secret: 'better-compute-events-catalog-secret-0123456789' })],
    });
    const { compute, tenants, iam } = fixture;
    iam.allow({ token: tenants.root.token });
    const root = { token: tenants.root.token };
    const input = { tenantId: tenants.root.id, url: 'https://hooks.example.test/x' };
    await expect(
      compute.api.webhooks.create(root, { ...input, events: ['node.adopted', 'nodes.*'] }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isComputeError(error, 'INVALID_INPUT') && /nodes\.\*/.test((error as Error).message),
    );
    const { webhook } = await compute.api.webhooks.create(root, { ...input, events: ['node.*'] });
    await expect(
      compute.api.webhooks.update(root, {
        tenantId: tenants.root.id,
        webhookId: webhook.id,
        // A family the catalog does not know (`reservation.<anything>` is the reservation family).
        events: ['reservatoin.active'],
      }),
    ).rejects.toSatisfy((error: unknown) => isComputeError(error, 'INVALID_INPUT'));
    const listed = await compute.api.webhooks.eventTypes(root, { tenantId: tenants.root.id });
    expect(listed.items.map((family) => family.type)).toEqual(
      eventCatalog.map((family) => family.type),
    );
  });
});

describe('the catalog against a real run', () => {
  it('covers every topic the control plane wrote to the outbox', async () => {
    rig = await createControlPlaneSim({ seed: 'events-catalog', nodes: 2 });
    const { compute, tenants, api } = rig;
    await rig.run(3 * 60_000);
    const reservation = await api(() =>
      compute.api.reservations.create({ token: tenants.acme.token }, {
        tenantId: tenants.acme.id,
        poolId: rig!.poolId,
        devices: [{ class: 'gpu', count: 8 }],
        duration: '1h',
        idempotencyKey: 'catalog',
      } as never),
    );
    await rig.run(30_000);
    await api(() =>
      compute.api.reservations.release({ token: tenants.acme.token }, {
        tenantId: tenants.acme.id,
        reservationId: reservation.id,
      } as never),
    );
    await rig.run(30_000);
    const { rows } = await rig.database.query<{ topic: string }>(
      'SELECT DISTINCT topic FROM outbox ORDER BY topic',
    );
    const topics = rows.map((row) => row.topic);
    expect(topics.length).toBeGreaterThan(8);
    expect(topics.filter((topic) => !eventFamilyOf(topic))).toEqual([]);
  }, 300_000);
});
