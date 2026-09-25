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
import type { Observer } from './spans.js';
import type { StandardMetrics } from './standard.js';

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
    /** Per background loop (dispatch, lease, liveness, specs, status). */
    loops?: Record<
      string,
      { consecutiveFailures: number; failures: number; lastOkMs: number | null }
    >;
  };
  sessions(): readonly { role: unknown; inFlight: number; upgradeRequired: boolean }[];
}

/** Samples gateways at every scrape: sessions by role, stream headroom, draining, lease held, commands in flight. */
export function gatewayCollector(
  registry: MetricsRegistry,
  gateways: () => readonly SampledGateway[],
  options: {
    now?: () => number;
    /** Also fills the standard `gateway_sessions{role}` (this process's sessions over all its gateways). */
    metrics?: Pick<StandardMetrics, 'gatewaySessions'>;
  } = {},
): void {
  const now = options.now ?? Date.now;
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
  const loopFailing = registry.gauge(
    'gateway_loop_consecutive_failures',
    'Failed runs of a gateway loop since its last clean one (alert on a stuck loop)',
    ['gateway', 'loop'],
  );
  const loopFailures = registry.gauge(
    'gateway_loop_failures',
    'Failed runs of a gateway loop since start',
    ['gateway', 'loop'],
  );
  const loopAge = registry.gauge(
    'gateway_loop_last_ok_age_seconds',
    'Seconds since a gateway loop last ran cleanly (-1 before its first clean run)',
    ['gateway', 'loop'],
  );
  const seenRoles = new Set<string>();
  registry.collect(() => {
    const totals = new Map<string, number>();
    for (const gateway of gateways()) {
      for (const session of gateway.sessions()) {
        const role = labelValue(String(session.role));
        totals.set(role, (totals.get(role) ?? 0) + 1);
      }
    }
    if (options.metrics) {
      // Roles seen before and gone now read 0 rather than their last count.
      for (const role of seenRoles)
        if (!totals.has(role)) options.metrics.gatewaySessions.set({ role }, 0);
      for (const [role, count] of totals) {
        options.metrics.gatewaySessions.set({ role }, count);
        seenRoles.add(role);
      }
    }
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
      for (const [name, loop] of Object.entries(status.loops ?? {})) {
        const labels = { gateway: id, loop: labelValue(name) };
        loopFailing.set(labels, loop.consecutiveFailures);
        loopFailures.set(labels, loop.failures);
        loopAge.set(
          labels,
          loop.lastOkMs === null ? -1 : Math.max(0, (now() - loop.lastOkMs) / 1000),
        );
      }
    }
  });
}

/** Samples revocation feeds (pki `createRevocationFeed`) at every scrape: polls failed in a row, per feed name. */
export function revocationFeedCollector(
  registry: MetricsRegistry,
  feeds: () => Readonly<Record<string, { readonly consecutiveFailures: number }>>,
): void {
  const failing = registry.gauge(
    'revocation_feed_consecutive_failures',
    'Revocation feed polls failed in a row: revoked certificates keep their sessions while it fails',
    ['feed'],
  );
  registry.collect(() => {
    for (const [name, feed] of Object.entries(feeds()))
      failing.set({ feed: labelValue(name) }, feed.consecutiveFailures);
  });
}

/** One placement attempt as capacity reports it (`capacityModule({ onPlacement })`), typed structurally. */
export interface PlacementObservationLike {
  placer: string;
  outcome: string;
  conflicts: number;
  seconds: number;
}

/**
 * Capacity's `onPlacement` observer feeding the §14 series: `placements_total{outcome}`,
 * `booking_conflicts_total` (replans forced by a booking conflict) and `placement_seconds{placer}`.
 *
 * ```ts
 * capacityModule({ onPlacement: placementObserver(standardMetrics(registry), registry) })
 * ```
 */
export function placementObserver(
  metrics: Pick<StandardMetrics, 'placements' | 'bookingConflicts'>,
  registry?: MetricsRegistry,
): (observation: PlacementObservationLike) => void {
  const duration = registry
    ? once(registry, 'placement.seconds', () =>
        registry.histogram('placement_seconds', 'One placement attempt, by placer', ['placer']),
      )
    : undefined;
  return (observation) => {
    metrics.placements.inc({ outcome: labelValue(observation.outcome) });
    if (observation.conflicts > 0) metrics.bookingConflicts.inc(undefined, observation.conflicts);
    duration?.observe({ placer: labelValue(observation.placer) }, observation.seconds);
  };
}

/** One reconciler run, as the server runtime reports it (`worker.observe.onRun`), typed structurally. */
export interface ReconcileRunLike {
  reconciler: string;
  /** The work key: never a metric label (unbounded). */
  key?: string;
  outcome: 'done' | 'sync-again' | 'error';
  durationMs: number;
  code?: string;
}

/** One CommandSweeper pass (`worker.observe.onSweep`). */
export interface CommandSweepLike {
  expired: number;
  failed: number;
}

/**
 * The runtime's worker hooks feeding `reconcile_duration_seconds{reconciler}` and `commands_swept_total{to}`,
 * and, with an observer, a `reconcile` span per run:
 *
 * ```ts
 * betterCompute({ worker: { observe: runtimeObserver(standardMetrics(registry), observer) } })
 * ```
 */
export function runtimeObserver(
  metrics: Pick<StandardMetrics, 'reconcileDuration' | 'commandsSwept'>,
  observer?: Pick<Observer, 'report'>,
): { onRun(run: ReconcileRunLike): void; onSweep(swept: CommandSweepLike): void } {
  return {
    onRun(run) {
      const reconciler = labelValue(run.reconciler);
      metrics.reconcileDuration.observe({ reconciler }, Math.max(0, run.durationMs) / 1000);
      observer?.report({
        kind: 'reconcile',
        name: reconciler,
        outcome: run.outcome === 'error' ? 'error' : 'ok',
        ...(run.code === undefined ? {} : { code: run.code }),
        durationMs: run.durationMs,
      });
    },
    onSweep(swept) {
      if (swept.expired > 0) metrics.commandsSwept.inc({ to: 'expired' }, swept.expired);
      if (swept.failed > 0) metrics.commandsSwept.inc({ to: 'failed' }, swept.failed);
    },
  };
}

/**
 * A counter of outbox events by family (the event catalog's families bound the label): pass the returned function
 * as `eventsModule({ countEvent })`, which calls it once per event its fan-out reads.
 */
export function eventCounter(
  registry: MetricsRegistry,
  metrics?: Pick<StandardMetrics, 'securityEvents'>,
): (family: string, module: string, type?: string) => void {
  const events = registry.counter('events_total', 'Outbox events by catalog family', [
    'family',
    'module',
  ]);
  return (family, module, type) => {
    events.inc({ family: labelValue(family), module: labelValue(module) });
    // Security events by exact type (a bounded set the control plane defines): `security_events_total{type}`.
    if (metrics && type?.startsWith('security.'))
      metrics.securityEvents.inc({ type: labelValue(type) });
  };
}

/**
 * The resolver's `onLookup` feeding `resolver_lookups_total{result}` (hit, miss, timeout, unavailable, scope,
 * fallback): `bridge.resolveResource(fallback, { onLookup: resolverLookupCounter(metrics) })`.
 */
export function resolverLookupCounter(
  metrics: Pick<StandardMetrics, 'resolverLookups'>,
): (result: string) => void {
  return (result) => metrics.resolverLookups.inc({ result: labelValue(result) });
}
