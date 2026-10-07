# @better-compute/observability

Bounded Prometheus metrics, `ComputeSpan` observers, host-side instrumentation and W3C trace context for better-compute.

## Install

```sh
npm install @better-compute/observability
```

It is also included in the umbrella package as `better-compute/observability`:

```sh
npm install better-compute
```

## Usage

```ts
import { timingSafeEqual } from 'node:crypto';
import {
  createMetrics,
  createObserver,
  metricsHandler,
  standardMetrics,
} from '@better-compute/observability';

const registry = createMetrics({ maxSeries: 2000 });
const metrics = standardMetrics(registry);
const observer = createObserver({ metrics: registry, onSpan: (span) => console.log(span) });

// Times the work, reports a ComputeSpan and feeds spans_total / span_duration_seconds.
await observer.span('operation', 'reservations.create', () => createReservation());
metrics.workQueueDepth.set({ kind: 'reconcile' }, 3);

// GET /metrics for scrapers that present `Authorization: Bearer <token>` (at least 16 characters).
const handleMetrics = metricsHandler({
  registry,
  bearerToken: process.env.METRICS_TOKEN!,
  timingSafeEqual,
});
const response = await handleMetrics(request); // a Fetch API Request
```

The package is modelled on better-iam's `metrics` and `observe` modules. It is browser-safe, with no Node.js imports (the constant-time comparison is injected), so `server`, `gateway`, the workers and tools can all depend on it.

## Registry and spans

- **`createMetrics({ maxSeries })`** is a Prometheus registry of counters, gauges and histograms, under the `better_compute_` prefix.
  - It refuses labels that would identify a tenant or a person.
  - Each metric holds at most `maxSeries` label sets (default 2000); new ones past that fold into one `(other)` series.
  - Values that come from callers become `(invalid)` when overlong or `(unknown)` when empty.
  - `expose()` renders text format 0.0.4.
- **`metricsHandler({ registry, bearerToken, timingSafeEqual })`** serves `GET /metrics` to `Authorization: Bearer <token>`. It compares the SHA-256 digests of the two tokens with the constant-time function you pass in.
- **`standardMetrics(registry)`** defines the standard series once, so every package records the same names and labels:
  - commands: `command_latency_seconds{kind,lane}`, `commands_swept_total{to}`;
  - work and reconciliation: `work_queue_depth{kind}`, `reconcile_duration_seconds{reconciler}`, `generation_lag_nodes`;
  - placement and fleet: `booking_conflicts_total`, `pool_gpus{state}`, `node_connectivity{state}`;
  - IAM: `iam_calls_total{op,outcome}`, `iam_call_duration_seconds{op}`, `resolver_lookups_total{result}`, `iam_inbox_spill_total`;
  - usage and health: `usage_dead_letters_total`, `clock_offset_seconds`;
  - tenants: `tenant_states{state}` (suspended, deleted), `tenant_teardowns_pending`;
  - sandboxes: `sandbox_ready_seconds{source}` (create to running; `source` is `warm` or `cold`, so the counts give the warm-pool hit ratio), `sandbox_expiry_lag_seconds`, `sandbox_warm_instances{state}`, `sandbox_warm_deficit`, `sandbox_warm_refills_total`;
  - also gateway, backlog, certificate and security series.
- **`meteredIamPort(port, metrics)`** is an IamPort that records `iam_calls_total` and `iam_call_duration_seconds` for every call.
- **`createObserver({ onSpan, metrics })`** times work as a `ComputeSpan` (`{ kind, name, tenantId?, outcome, code?, status?, requestId?, durationMs }`), shaped like better-iam's `IamSpan`.
  - It fans each span out to hooks that can never affect the work.
  - It feeds `spans_total{kind,name,outcome,code}` and `span_duration_seconds{kind}`.
  - Names the caller controls, such as an unknown route or invalid input, collapse to `(invalid)` or `(unknown)`.
- **`metricCatalog()`** lists every metric family the package defines (name, kind, help, labels, buckets and the function that defines it), by running each definer against a recording registry.

## Host-side instrumentation

Modules need no metrics code of their own. Labels are bounded: ids, method names, error codes, catalog families.

- `meteredAttestor(attestor, registry)` counts verifications as `admitted`, `deferred-<kind>`, `refused` or an error code, and times them.
- `meteredGatewayServices(compute.gatewayServices, registry)` covers Join, Renew and Secret by outcome.
- `meteredProvider(provider, registry)` covers every ProviderImpl call by provider, method and outcome.
- `gatewayCollector(registry, () => gateways)` samples sessions by role, stream headroom, draining, lease held and commands in flight at every scrape, through `registry.collect(fn)`.
- `revocationFeedCollector(registry, () => feeds)` samples each revocation feed's consecutive poll failures.
- `placementObserver(standardMetrics(registry), registry)` is capacity's `onPlacement`: it feeds `placements_total{outcome}`, `booking_conflicts_total` and `placement_seconds{placer}`.
- `runtimeObserver(metrics, observer?)` is the worker's `observe` hooks: it feeds `reconcile_duration_seconds{reconciler}` and `commands_swept_total{to}`, and reports a `reconcile` span per run.
- `databaseCollector(standardMetrics(registry), { sql, laneOf?, certificates? })` polls compute's tables every 15 s (`start()`/`stop()`, or `refresh()`) for the deployment-wide series:
  - `work_queue_depth{kind}`, `node_connectivity{state}`, `generation_lag_nodes`, `pool_gpus{state}`;
  - `backlog{queue}`: pending commands, the IAM inbox, unrecorded usage, pending webhooks and each outbox sink's cursor. Pending webhooks and `outbox_dead_letters` are backlogs too;
  - `tenant_states{state}` and `tenant_teardowns_pending`, once the tenancy table exists;
  - the sandbox series, once vps has migrated (the histograms and refills, like command latency, only in the lease holder);
  - `cert_expiry_seconds{kind}`: each node's newest certificate, by role, plus host certificates;
  - `clock_offset_seconds`;
  - `command_latency_seconds{kind,lane}` for commands settled since the last poll (needs `commands.created_at`).

  It may run in every worker: only the holder of the `leases` row `metrics:command-latency` (`latencyLease`) observes the histogram, so each command counts once. `stop()` hands the row over at once.

- `eventCounter(registry)` counts outbox events by family, through `eventsModule({ countEvent })`.
- `usageFlushCounter(metrics)` and `resolverLookupCounter(metrics)` feed `usage_dead_letters_total` and `resolver_lookups_total{result}` from the IAM bridge's hooks.

## Node telemetry and tracing

- **`nodeTelemetryModule({ otlpEndpoint?, intervalSeconds?, headersRef?, resourceAttributes?, roles? })`** tells each bcd node where to export its own OTLP metrics, through `NodeSpec.telemetry`; a node gets no telemetry part when no endpoint results. A pool's `policy.telemetry` overrides the defaults field by field. Nodes export straight to the collector, never over the session or into PostgreSQL. `telemetryProblem(spec)` validates a spec, and `nodeTelemetryFindings(sql)` reports pools whose policy cannot be used.
- **`parseTraceparent` / `formatTraceparent` / `childTraceparent`** handle W3C Trace Context, stored on commands and steps.

## Documentation

- [Observability](https://better-compute.com/docs/operations/observability)
- [Metrics reference](https://better-compute.com/docs/reference/metrics)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
