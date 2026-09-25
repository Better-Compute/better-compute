// Instrumentation a host wraps around the extensions and services it wires (PLAN.md §14), so modules need no
// metrics code of their own: attestors (admitted, deferred, refused), the gateway services (Join, Renew, Secret),
// providers (every ProviderImpl call), a gateway's sessions, and the outbox's event families. Every label is a
// bounded set: attestor and provider ids, method names, error codes, event families.

import {
  isComputeError,
  type AttestorVerifier,
  type ProviderContext,
  type ProviderDefinition,
  type ProviderImpl,
} from '@better-compute/core';
import { labelValue, type MetricsRegistry } from './registry.js';

const outcomeOf = (error: unknown): string =>
  isComputeError(error) ? (error as { code: string }).code : 'error';

/** One family per wrapper kind, created once per registry. */
const families = new WeakMap<MetricsRegistry, Map<string, unknown>>();
function once<T>(registry: MetricsRegistry, key: string, make: () => T): T {
  let byKey = families.get(registry);
  if (!byKey) families.set(registry, (byKey = new Map()));
  if (!byKey.has(key)) byKey.set(key, make());
  return byKey.get(key) as T;
}

/** An AttestorVerifier whose verifications are counted by outcome and timed. */
export function meteredAttestor(
  attestor: AttestorVerifier,
  registry: MetricsRegistry,
): AttestorVerifier {
  const verifications = once(registry, 'attestor.total', () =>
    registry.counter('attestor_verifications_total', 'Attestor verifications by outcome', [
      'attestor',
      'outcome',
    ]),
  );
  const duration = once(registry, 'attestor.seconds', () =>
    registry.histogram('attestor_verification_seconds', 'Attestor verification time', ['attestor']),
  );
  const id = labelValue(attestor.id);
  return Object.freeze({
    ...attestor,
    async verify(evidence, context) {
      const stop = duration.startTimer({ attestor: id });
      try {
        const result = await attestor.verify(evidence, context);
        const deferred = (result as { deferred?: unknown }).deferred;
        verifications.inc({
          attestor: id,
          outcome: typeof deferred === 'string' ? `deferred-${labelValue(deferred)}` : 'admitted',
        });
        return result;
      } catch (error) {
        verifications.inc({
          attestor: id,
          outcome: isComputeError(error, 'ACCESS_DENIED') ? 'refused' : outcomeOf(error),
        });
        throw error;
      } finally {
        stop();
      }
    },
  } as AttestorVerifier);
}

/** Anything with async methods: `GatewayServices`, `ProviderImpl`. */
type AsyncMethods = Record<string, unknown>;

function meterMethods<T extends object>(
  target: T,
  methods: readonly string[],
  record: (method: string, outcome: string, seconds: number) => void,
): T {
  const wrapped: AsyncMethods = Object.create(Object.getPrototypeOf(target) as object);
  for (const key of Reflect.ownKeys(target))
    (wrapped as Record<PropertyKey, unknown>)[key] = (target as Record<PropertyKey, unknown>)[key];
  for (const method of methods) {
    const original = (target as AsyncMethods)[method];
    if (typeof original !== 'function') continue;
    wrapped[method] = async (...args: unknown[]) => {
      const started = performance.now();
      try {
        const result = await (original as (...a: unknown[]) => Promise<unknown>).apply(
          target,
          args,
        );
        record(method, 'ok', (performance.now() - started) / 1000);
        return result;
      } catch (error) {
        record(method, outcomeOf(error), (performance.now() - started) / 1000);
        throw error;
      }
    };
  }
  return wrapped as T;
}

/** The gateway services (`compute.gatewayServices`) with Join, Renew and Secret counted and timed. */
export function meteredGatewayServices<
  T extends { join: unknown; renew: unknown; secret: unknown },
>(services: T, registry: MetricsRegistry): T {
  const calls = once(registry, 'gatewayServices.total', () =>
    registry.counter('gateway_service_calls_total', 'Join, Renew and Secret calls by outcome', [
      'method',
      'outcome',
    ]),
  );
  const duration = once(registry, 'gatewayServices.seconds', () =>
    registry.histogram('gateway_service_seconds', 'Join, Renew and Secret time', ['method']),
  );
  return meterMethods(services, ['join', 'renew', 'secret'], (method, outcome, seconds) => {
    calls.inc({ method, outcome });
    duration.observe({ method }, seconds);
  });
}

const providerMethods = [
  'listOffers',
  'create',
  'get',
  'delete',
  'power',
  'reinstall',
  'rescue',
  'bootstrap',
];

/** A provider whose clients count and time every call (`list` is left as is: it is an iterator). */
export function meteredProvider<C>(
  provider: ProviderDefinition<C>,
  registry: MetricsRegistry,
): ProviderDefinition<C> {
  const calls = once(registry, 'provider.total', () =>
    registry.counter('provider_calls_total', 'Provider API calls by outcome', [
      'provider',
      'method',
      'outcome',
    ]),
  );
  const duration = once(registry, 'provider.seconds', () =>
    registry.histogram(
      'provider_call_seconds',
      'Provider API call time',
      ['provider', 'method'],
      [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    ),
  );
  const id = labelValue(provider.id);
  return Object.freeze({
    ...provider,
    async create(config: C, context: ProviderContext) {
      const impl = await provider.create(config, context);
      return meterMethods<ProviderImpl>(impl, providerMethods, (method, outcome, seconds) => {
        calls.inc({ provider: id, method, outcome });
        duration.observe({ provider: id, method }, seconds);
      });
    },
  }) as ProviderDefinition<C>;
}

/** The part of a gateway the collector samples (`createGateway()`'s result satisfies it). */
export interface SampledGateway {
  status(): {
    id: string;
    sessions: number;
    maxStreams: number;
    draining: boolean;
    leaseEpoch: number | null;
  };
  sessions(): readonly { role: unknown; inFlight: number; upgradeRequired: boolean }[];
}

/** Samples gateways at every scrape: sessions by role, stream headroom, draining, lease held, commands in flight. */
export function gatewayCollector(
  registry: MetricsRegistry,
  gateways: () => readonly SampledGateway[],
): void {
  const sessions = registry.gauge('gateway_open_sessions', 'Open agent sessions by role', [
    'gateway',
    'role',
  ]);
  const headroom = registry.gauge(
    'gateway_stream_headroom',
    'Streams this gateway can still admit',
    ['gateway'],
  );
  const draining = registry.gauge(
    'gateway_draining',
    'Whether the gateway is draining (1) or not (0)',
    ['gateway'],
  );
  const lease = registry.gauge(
    'gateway_lease_held',
    'Whether the gateway holds its lease (1) or is fenced (0)',
    ['gateway'],
  );
  const inFlight = registry.gauge(
    'gateway_commands_in_flight',
    'Commands dispatched and not yet settled',
    ['gateway'],
  );
  const upgrade = registry.gauge('gateway_sessions_upgrade_required', 'Sessions told to upgrade', [
    'gateway',
  ]);
  registry.collect(() => {
    for (const gateway of gateways()) {
      const status = gateway.status();
      const id = labelValue(status.id);
      const byRole = new Map<string, number>();
      let flying = 0;
      let upgrading = 0;
      for (const session of gateway.sessions()) {
        const role = labelValue(String(session.role));
        byRole.set(role, (byRole.get(role) ?? 0) + 1);
        flying += session.inFlight;
        if (session.upgradeRequired) upgrading++;
      }
      for (const [role, count] of byRole) sessions.set({ gateway: id, role }, count);
      headroom.set({ gateway: id }, Math.max(0, status.maxStreams - status.sessions));
      draining.set({ gateway: id }, status.draining ? 1 : 0);
      lease.set({ gateway: id }, status.leaseEpoch === null ? 0 : 1);
      inFlight.set({ gateway: id }, flying);
      upgrade.set({ gateway: id }, upgrading);
    }
  });
}

/**
 * A counter of outbox events by family (the event catalog's families bound the label): pass the returned function
 * as `eventsModule({ countEvent })`, which calls it once per event its fan-out reads.
 */
export function eventCounter(registry: MetricsRegistry): (family: string, module: string) => void {
  const events = registry.counter('events_total', 'Outbox events by catalog family', [
    'family',
    'module',
  ]);
  return (family, module) => events.inc({ family: labelValue(family), module: labelValue(module) });
}
