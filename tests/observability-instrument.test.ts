import { afterEach, describe, expect, it } from 'vitest';
import { ComputeError, defineAttestor, field, manifest } from '@better-compute/core';
import { eventsModule } from '@better-compute/events';
import {
  createMetrics,
  eventCounter,
  gatewayCollector,
  meteredAttestor,
  meteredGatewayServices,
  meteredProvider,
} from '@better-compute/observability';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { defineProvider } from '@better-compute/vps';

// Host-side instrumentation (PLAN.md §14): attestors, gateway services, providers, gateways and outbox event
// families measured from the outside, with bounded labels only.

afterEach(closeFixtures);

const context = {} as never;

describe('meteredAttestor', () => {
  it('counts admitted, deferred and refused verifications and times them', async () => {
    const registry = createMetrics();
    let mode: 'admit' | 'defer' | 'refuse' | 'break' = 'admit';
    const attestor = meteredAttestor(
      defineAttestor({
        id: 'cloud-iid',
        version: '1.0.0',
        roles: ['node'],
        async verify() {
          if (mode === 'refuse') throw new ComputeError('ACCESS_DENIED', 'Join refused');
          if (mode === 'break') throw new ComputeError('INTERNAL_ERROR', 'boom');
          if (mode === 'defer') return { deferred: 'approval', joinRequestId: 'jr_1' } as never;
          return { tenantId: 'ten_1', role: 'node' };
        },
      }),
      registry,
    );
    expect(attestor).toMatchObject({ id: 'cloud-iid', extension: 'attestor', roles: ['node'] });
    const evidence = { attestor: 'cloud-iid', payload: new Uint8Array() };
    await attestor.verify(evidence, context);
    mode = 'defer';
    await attestor.verify(evidence, context);
    mode = 'refuse';
    await expect(attestor.verify(evidence, context)).rejects.toThrow('Join refused');
    mode = 'break';
    await expect(attestor.verify(evidence, context)).rejects.toThrow('boom');
    const value = (outcome: string) =>
      registry.value('attestor_verifications_total', { attestor: 'cloud-iid', outcome });
    expect([
      value('admitted'),
      value('deferred-approval'),
      value('refused'),
      value('INTERNAL_ERROR'),
    ]).toEqual([1, 1, 1, 1]);
    expect(registry.expose()).toContain(
      'better_compute_attestor_verification_seconds_count{attestor="cloud-iid"} 4',
    );
  });
});

describe('meteredGatewayServices and meteredProvider', () => {
  it('counts calls by method and error code', async () => {
    const registry = createMetrics();
    const services = meteredGatewayServices(
      {
        join: async () => ({ ok: true }),
        renew: async () => {
          throw new ComputeError('INVALID_INPUT', 'stale proof');
        },
        secret: async () => ({}),
      },
      registry,
    );
    await services.join();
    await expect(services.renew()).rejects.toThrow('stale proof');
    expect(registry.value('gateway_service_calls_total', { method: 'join', outcome: 'ok' })).toBe(
      1,
    );
    expect(
      registry.value('gateway_service_calls_total', { method: 'renew', outcome: 'INVALID_INPUT' }),
    ).toBe(1);

    const provider = meteredProvider(
      defineProvider({
        id: 'acme-cloud',
        version: '1.0.0',
        provides: ['vps'],
        config: manifest({ region: field.string().default('x') }),
        create: () => ({
          listOffers: async () => [],
          create: async () => {
            throw new ComputeError('RATE_LIMITED', 'slow down');
          },
          get: async () => undefined,
          delete: async () => {},
        }),
      }),
      registry,
    );
    const impl = await provider.create({ region: 'x' }, context);
    expect(await impl.listOffers({})).toEqual([]);
    await expect(
      impl.create({ offerId: 'a', image: 'b', userData: '', name: 'n' }, context),
    ).rejects.toThrow('slow down');
    expect(
      registry.value('provider_calls_total', {
        provider: 'acme-cloud',
        method: 'listOffers',
        outcome: 'ok',
      }),
    ).toBe(1);
    expect(
      registry.value('provider_calls_total', {
        provider: 'acme-cloud',
        method: 'create',
        outcome: 'RATE_LIMITED',
      }),
    ).toBe(1);
  });
});

describe('gatewayCollector', () => {
  it('samples sessions, headroom, draining, lease and in-flight commands at each scrape', () => {
    const registry = createMetrics();
    let sessions = [
      { role: 1, inFlight: 2, upgradeRequired: false },
      { role: 1, inFlight: 1, upgradeRequired: true },
      { role: 2, inFlight: 0, upgradeRequired: false },
    ];
    gatewayCollector(registry, () => [
      {
        status: () => ({
          id: 'gw_1',
          sessions: sessions.length,
          maxStreams: 10,
          draining: false,
          leaseEpoch: 3,
        }),
        sessions: () => sessions,
      },
    ]);
    let text = registry.expose();
    expect(text).toContain('better_compute_gateway_open_sessions{gateway="gw_1",role="1"} 2');
    expect(text).toContain('better_compute_gateway_stream_headroom{gateway="gw_1"} 7');
    expect(text).toContain('better_compute_gateway_commands_in_flight{gateway="gw_1"} 3');
    expect(text).toContain('better_compute_gateway_lease_held{gateway="gw_1"} 1');
    sessions = sessions.slice(0, 1);
    text = registry.expose();
    expect(text).toContain('better_compute_gateway_stream_headroom{gateway="gw_1"} 9');
  });
});

describe('eventCounter', () => {
  it("counts the outbox's events by catalog family through the events fan-out", async () => {
    const registry = createMetrics();
    const fixture = await computeFixture({
      clock: 'sim',
      modules: [
        eventsModule({
          secret: 'better-compute-events-metrics-secret-0123456789',
          countEvent: eventCounter(registry),
        }),
      ],
    });
    const { compute, tenants, iam } = fixture;
    iam.allow({ token: tenants.root.token });
    const root = { token: tenants.root.token };
    const site = await compute.api.sites.create(root, {
      tenantId: tenants.root.id,
      kind: 'shared',
      region: 'eu',
      idempotencyKey: 'metrics-site',
    });
    await compute.api.pools.create(root, {
      tenantId: tenants.root.id,
      siteId: site.id,
      class: 'metal-host',
      gpuModel: 'H100',
      idempotencyKey: 'metrics-pool',
    } as never);
    await fixture.advance(2_000);
    await compute.jobs['events.fanout']!.tick();
    expect(registry.value('events_total', { family: 'site.*', module: 'server' })).toBe(1);
    expect(registry.value('events_total', { family: 'pool.*', module: 'capacity' })).toBe(1);
  });
});
