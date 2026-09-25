# @better-compute/events

Event delivery for better-compute (PLAN.md §9.3, v0.3). Compute writes CloudEvents-style events (`{id, type, tenantId, subject, time, sequence, data}`) to its outbox in the same transaction as the change they describe. This package delivers them to tenants in two ways:

- **Webhooks.** Each tenant can register up to 20 subscriptions, each with event-type patterns (`*`, `reservation.*`, `node.connected`).
  - Deliveries are signed the way better-iam signs its webhooks. `X-Better-Compute-Signature: v1=<hex>` is an HMAC-SHA256 over `${timestamp}.${body}`, and `X-Better-Compute-Timestamp` gives the timestamp in epoch seconds.
  - Receivers check both with `verifyWebhookSignature`, which allows 5 minutes of clock skew.
  - `X-Better-Compute-Delivery` stays the same across retries, so receivers can dedupe on it.
  - Failed deliveries retry with backoff (1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h). After 8 attempts a delivery is dead, and `webhooks.redeliver` puts it back in the queue.
  - `webhooks.rotateSecret` can keep the old secret signing alongside the new one for up to a day.
  - Signing secrets are sealed at rest with AES-256-GCM, under a key derived from the deployment secret.
  - Webhook URLs must be `https` and public. Each delivery re-resolves the host and refuses private, loopback and link-local addresses, so a URL can't be used for SSRF.
- **SSE `GET /watch`.** `handleWatch(request, { sql, authorize })` streams one tenant's events. Each event's `id:` is its outbox cursor, so `Last-Event-ID` resumes exactly after the last event received. Without one, the stream starts at the tail. `?types=` filters event types.

The outbox is read with the xmin cursor (§8.4): only transactions older than the snapshot's xmin, in `(txid, seq)` order. As a result, no event can commit behind a reader.

```ts
import { eventsModule, handleWatch } from 'better-compute/events';

const compute = betterCompute({ ..., modules: [eventsModule({ secret: process.env.EVENTS_SECRET! })] });
// The host mounts GET /watch; authorize decides compute:events:read on compute-tenant/{t}.
const watch = (request: Request) => handleWatch(request, { sql, authorize: authorizeWatch });
```

The module owns the tables `webhooks`, `webhook_deliveries` and `event_cursors` (migrations `events/0001_webhooks` and `events/0002_delivery_retention`). It runs three reconcilers:

- `events.fanout`, every 1 s, turns outbox events into deliveries. Its cursor is anchored when the control plane starts, so nothing committed before the first pass is missed and history is never replayed.
- `events.deliver`, every 2 s, sends them. A webhook's deliveries go out one at a time in commit order, while different webhooks are served in parallel.
- `events.prune`, hourly, deletes delivery history past its retention: delivered and cancelled deliveries after 30 days, dead letters after 90 (`eventsModule({ retention: { deliveredDays, deadDays } })`, or `retention: false` to keep everything). Pending deliveries are never deleted.

## Event catalog

`eventCatalog` lists the event families the control plane and its modules publish: `site.*`, `pool.*`, `reservation.*`, `node.*` (with the inventory and metal families), `command.settled`, `instance.*`, `workflow.*`, `rollout.*`, `tunnel.*`, `security.*` and more. Each family names its subject and the module that publishes it.

- `webhooks.create` and `update` refuse a pattern that no family can match, such as `nodes.*`, instead of letting it silently match nothing.
- `eventsModule({ extraEvents })` adds a plugin's families; `extraEvents: false` accepts any pattern.
- `webhooks.eventTypes` lists the catalog.
- `eventsModule({ countEvent })` is called once per event the fan-out reads, with its family. Pass `eventCounter(registry)` from `@better-compute/observability` to get `better_compute_events_total{family,module}`.

A test runs the control-plane simulator and checks that every outbox topic belongs to the catalog, so the catalog can't drift from the code unnoticed.

## Webhook methods

Every method decides `compute:webhooks:manage` on `compute-tenant/{t}`:

- `create` → `{ webhook, secret }` (the secret is shown once)
- `list`, `get`
- `update` (url, events, description, active; pausing a webhook cancels its pending deliveries)
- `rotateSecret`
- `delete`
- `ping` (queues a `webhook.ping` delivery)
- `deliveries` (history, filterable by state)
- `redeliver`
- `eventTypes` (the event catalog)

## License

[Apache License 2.0](LICENSE)
