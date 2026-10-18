// The §14 metric set, defined once so every package records the same names, labels and buckets. None carries
// a tenant label.

import type { Credential, Decision, IamPort } from '@better-compute/core';
import type { MetricsRegistry } from './registry.js';

export function standardMetrics(registry: MetricsRegistry) {
  return {
    gatewaySessions: registry.gauge('gateway_sessions', 'Open daemon sessions on this gateway', [
      'role',
    ]),
    gatewayHandshakes: registry.counter('gateway_handshakes_total', 'Session handshakes', [
      'outcome',
    ]),
    commandLatency: registry.histogram(
      'command_latency_seconds',
      'Command enqueue to terminal result',
      ['kind', 'lane'],
      [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2.5, 5, 10, 30, 60],
    ),
    commandsSwept: registry.counter('commands_swept_total', 'Commands the CommandSweeper moved', [
      'to',
    ]),
    workQueueDepth: registry.gauge('work_queue_depth', 'Due work_queue rows', ['kind']),
    reconcileDuration: registry.histogram('reconcile_duration_seconds', 'One reconciler run', [
      'reconciler',
    ]),
    generationLag: registry.gauge(
      'generation_lag_nodes',
      'Nodes whose observed generation is behind',
    ),
    placements: registry.counter('placements_total', 'Placement attempts', ['outcome']),
    bookingConflicts: registry.counter(
      'booking_conflicts_total',
      'Booking conflicts that forced a replan',
    ),
    poolGpus: registry.gauge('pool_gpus', 'GPUs by state across pools', ['state']),
    nodeConnectivity: registry.gauge('node_connectivity', 'Nodes by connectivity', ['state']),
    backlog: registry.gauge('backlog', 'Rows waiting in a queue table', ['queue']),
    usageDeadLetters: registry.counter('usage_dead_letters_total', 'Usage events dead-lettered'),
    iamInboxSpill: registry.counter(
      'iam_inbox_spill_total',
      'IAM events spilled because the inbox was down',
    ),
    iamCalls: registry.counter('iam_calls_total', 'IamPort calls', ['op', 'outcome']),
    iamCallDuration: registry.histogram(
      'iam_call_duration_seconds',
      'IamPort call latency (each op takes ≥1 IAM lock acquisition)',
      ['op'],
    ),
    resolverLookups: registry.counter('resolver_lookups_total', 'Authz resolver lookups', [
      'result',
    ]),
    tenantStates: registry.gauge(
      'tenant_states',
      'IAM tenants compute refuses (§12.8), by state: suspended, deleted',
      ['state'],
    ),
    tenantTeardownsPending: registry.gauge(
      'tenant_teardowns_pending',
      'Deleted tenants whose teardown has not finished (a module still releasing)',
    ),
    sandboxReady: registry.histogram(
      'sandbox_ready_seconds',
      'Sandbox create to its instance first running (§3.7), by source: a warm claim or a cold create; the counts give the warm-pool hit ratio',
      ['source'],
      [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
    ),
    sandboxExpiryLag: registry.histogram(
      'sandbox_expiry_lag_seconds',
      'How late a sandbox was expired after its expiresAt',
      [],
      [1, 5, 15, 30, 60, 120, 300, 900],
    ),
    sandboxWarmInstances: registry.gauge(
      'sandbox_warm_instances',
      'Unclaimed warm-pool instances, by instance state',
      ['state'],
    ),
    sandboxWarmDeficit: registry.gauge(
      'sandbox_warm_deficit',
      'Warm instances missing below the templates’ warm.min, summed over live templates',
    ),
    sandboxWarmRefills: registry.counter(
      'sandbox_warm_refills_total',
      'Warm-pool instances created to refill templates',
    ),
    certExpiry: registry.gauge('cert_expiry_seconds', 'Seconds until the soonest expiry', ['kind']),
    clockOffset: registry.gauge('clock_offset_seconds', 'Process clock minus compute_now()'),
    securityEvents: registry.counter('security_events_total', 'Security events recorded', ['type']),
  };
}
export type StandardMetrics = ReturnType<typeof standardMetrics>;

type Op = Exclude<keyof IamPort, 'rootTenantId' | 'capabilities'>;

/**
 * An IamPort that records `iam_calls_total{op,outcome}` and `iam_call_duration_seconds{op}` (§14). Outcomes:
 * `ok`, `denied` (ACCESS_DENIED/CONFIRMATION_REQUIRED), `error`. Behaves exactly like `inner` otherwise.
 */
export function meteredIamPort(inner: IamPort, metrics: StandardMetrics): IamPort {
  const wrap =
    <A extends unknown[], R>(op: Op, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const stop = metrics.iamCallDuration.startTimer({ op });
      try {
        const result = await fn(...args);
        metrics.iamCalls.inc({ op, outcome: 'ok' });
        return result;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        metrics.iamCalls.inc({
          op,
          outcome:
            code === 'ACCESS_DENIED' || code === 'CONFIRMATION_REQUIRED' ? 'denied' : 'error',
        });
        throw error;
      } finally {
        stop();
      }
    };
  return {
    ...(inner.rootTenantId === undefined ? {} : { rootTenantId: inner.rootTenantId }),
    authenticate: wrap('authenticate', (credential: Credential) => inner.authenticate(credential)),
    require: wrap('require', (credential: Credential, decision: Decision) =>
      inner.require(credential, decision),
    ),
    authorize: wrap('authorize', (credential: Credential, decision: Decision) =>
      inner.authorize(credential, decision),
    ),
    authorizeMany: wrap('authorizeMany', inner.authorizeMany.bind(inner)),
    requestConfirmation: wrap('requestConfirmation', inner.requestConfirmation.bind(inner)),
    billingCheck: wrap('billingCheck', inner.billingCheck.bind(inner)),
    recordUsage: wrap('recordUsage', inner.recordUsage.bind(inner)),
    featureEnabled: wrap('featureEnabled', inner.featureEnabled.bind(inner)),
    capabilities: () => inner.capabilities(),
    // Optional members pass through unmetered: dropping them would silently change behaviour
    // (tunnels without a re-authorizer refuse to mount; admissions would decide on stale rows).
    ...(inner.authorizeSession ? { authorizeSession: inner.authorizeSession.bind(inner) } : {}),
    ...(inner.refreshResource ? { refreshResource: inner.refreshResource.bind(inner) } : {}),
    // Billing members (meters, prices, quotes, spend): metered when the inner port has them.
    ...(inner.ensureMeters
      ? { ensureMeters: wrap('ensureMeters', inner.ensureMeters.bind(inner)) }
      : {}),
    ...(inner.listMeters ? { listMeters: wrap('listMeters', inner.listMeters.bind(inner)) } : {}),
    ...(inner.setPrice ? { setPrice: wrap('setPrice', inner.setPrice.bind(inner)) } : {}),
    ...(inner.listPrices ? { listPrices: wrap('listPrices', inner.listPrices.bind(inner)) } : {}),
    ...(inner.quote ? { quote: wrap('quote', inner.quote.bind(inner)) } : {}),
    ...(inner.spend ? { spend: wrap('spend', inner.spend.bind(inner)) } : {}),
  };
}
