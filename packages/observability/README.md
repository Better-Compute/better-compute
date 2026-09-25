# @better-compute/observability

Observability for better-compute (PLAN.md §14), modelled on better-iam's `metrics` and `observe` modules. It is browser-safe, with no Node.js imports, so `server`, `gateway`, the workers and tools can all depend on it.

- **`createMetrics({ maxSeries })`** is a Prometheus registry of counters, gauges and histograms, under the `better_compute_` prefix.
  - It refuses labels that would identify a tenant or a person.
  - Each metric holds at most `maxSeries` label sets (default 2000); new ones past that fold into one `(other)` series.
  - Values that come from callers become `(invalid)` when overlong or `(unknown)` when empty.
  - `expose()` renders text format 0.0.4.
- **`metricsHandler({ registry, bearerToken, timingSafeEqual })`** serves `GET /metrics` to `Authorization: Bearer <token>`. It compares the SHA-256 digests of the two tokens with the constant-time function you pass in.
- **`standardMetrics(registry)`** defines the §14 series once, so every package records the same names and labels:
  - commands: `command_latency_seconds{kind,lane}`, `commands_swept_total{to}`;
  - work and reconciliation: `work_queue_depth{kind}`, `reconcile_duration_seconds{reconciler}`, `generation_lag_nodes`;
  - placement and fleet: `booking_conflicts_total`, `pool_gpus{state}`, `node_connectivity{state}`;
  - IAM: `iam_calls_total{op,outcome}`, `iam_call_duration_seconds{op}`, `resolver_lookups_total{result}`, `iam_inbox_spill_total`;
  - usage and health: `usage_dead_letters_total`, `clock_offset_seconds`;
  - also gateway, backlog, certificate and security series.
- **`meteredIamPort(port, metrics)`** is an IamPort that records `iam_calls_total` and `iam_call_duration_seconds` for every call.
- **`createObserver({ onSpan, metrics })`** times work as a `ComputeSpan` (`{ kind, name, tenantId?, outcome, code?, status?, requestId?, durationMs }`), shaped like better-iam's `IamSpan`.
  - It fans each span out to hooks that can never affect the work.
  - It feeds `spans_total{kind,name,outcome,code}` and `span_duration_seconds{kind}`.
  - Names the caller controls, such as an unknown route or invalid input, collapse to `(invalid)` or `(unknown)`.
- **Host-side instrumentation**, so modules need no metrics code of their own. Labels are bounded: ids, method names, error codes, catalog families.
  - `meteredAttestor(attestor, registry)` counts verifications as `admitted`, `deferred-<kind>`, `refused` or an error code, and times them.
  - `meteredGatewayServices(compute.gatewayServices, registry)` covers Join, Renew and Secret by outcome.
  - `meteredProvider(provider, registry)` covers every ProviderImpl call by provider, method and outcome.
  - `gatewayCollector(registry, () => gateways)` samples sessions by role, stream headroom, draining, lease held and commands in flight at every scrape, through `registry.collect(fn)`.
  - `databaseCollector(standardMetrics(registry), { sql, laneOf?, certificates? })` polls compute's tables every 15 s (`start()`/`stop()`, or `refresh()`) for the deployment-wide series: `work_queue_depth{kind}`, `backlog{queue}` (pending commands, the IAM inbox, unrecorded usage, pending webhooks, each outbox sink's cursor), `node_connectivity{state}`, `generation_lag_nodes`, `pool_gpus{state}`, `cert_expiry_seconds{kind}` (each node's newest certificate, by role, plus host certificates), `clock_offset_seconds` and `command_latency_seconds{kind,lane}` (commands settled since the last poll; needs `commands.created_at`). Run it in one process (the worker) so the histogram counts each command once.
  - `eventCounter(registry)` counts outbox events by family, through `eventsModule({ countEvent })`.
- **`parseTraceparent` / `formatTraceparent` / `childTraceparent`** handle W3C Trace Context, stored on commands and steps.

## License

[Apache License 2.0](LICENSE)
