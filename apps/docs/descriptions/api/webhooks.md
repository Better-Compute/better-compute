Per-tenant subscriptions that POST every matching committed event to an HTTPS endpoint, signed with a secret only the tenant and Better Compute know, with at-least-once delivery, retries with backoff, dead letters and redelivery. The events module hosts this group, and every method decides `compute:webhooks:manage` on `compute-tenant/{tenantId}`. See [Webhooks](/docs/guides/events/webhooks).

## create

Creates an active webhook for a URL and 1 to 20 event type patterns; returns the webhook and its signing secret, which is shown this once.

- A pattern is an exact event type, a family such as `reservation.*`, or `*`; a pattern that matches nothing in the event catalog is `INVALID_INPUT` (see `eventTypes`), unless the deployment is configured to accept any pattern.
- The URL must be absolute, use `https`, carry no credentials and not point at a private, loopback or other non-public address; otherwise `INVALID_INPUT`.
- A tenant has at most 20 webhooks by default; one more is `QUOTA_EXCEEDED`.
- The webhook receives events committed after it was created; earlier history is not replayed. The method takes no idempotency key, so a retry creates a second webhook.

## list

Lists the tenant's webhooks, oldest first, without their secrets.

## get

Returns one webhook of the tenant by id, without its secret.

`NOT_FOUND` when the webhook is not the tenant's.

## update

Changes a webhook's URL, event patterns, description or `active` flag and increments its version; returns the webhook.

- URL and patterns are checked as in `create` (`INVALID_INPUT`).
- Setting `active` to `false` pauses the webhook and cancels its pending deliveries.
- `NOT_FOUND` when the webhook is not the tenant's.

## rotateSecret

Replaces a webhook's signing secret with a new one; returns the webhook and the new secret, shown this once.

- With `keepPreviousSeconds` (0 to 86,400, default 0), the old secret keeps signing deliveries alongside the new one until then, so receivers can switch without rejecting any; with 0 the old secret stops at once.
- `NOT_FOUND` when the webhook is not the tenant's.

## delete

Deletes a webhook together with its delivery queue and history; returns `deleted: true`.

`NOT_FOUND` when the webhook is not the tenant's.

## ping

Queues a `webhook.ping` delivery to the webhook, due now; returns the delivery.

The ping is a delivery only: it is not written to the outbox, so `events.list` does not show it. A ping to a paused webhook is cancelled when the delivery worker picks it up. `NOT_FOUND` when the webhook is not the tenant's.

## deliveries

Lists a webhook's deliveries newest first, optionally filtered by `state` (`pending`, `delivered`, `dead` or `cancelled`), with attempts, the next attempt time and the last status or error.

`limit` is at most 200 (50 by default). `NOT_FOUND` when the webhook is not the tenant's.

## redeliver

Puts a delivery back in the queue, due now, with its attempt count reset; returns the delivery.

- Meant for `dead`, `cancelled` or `delivered` deliveries, for example once a failing endpoint is fixed.
- The delivery keeps its id, so the `X-Better-Compute-Delivery` header carries the same value as before.
- `NOT_FOUND` when the delivery is not the tenant's or its webhook is paused.

## eventTypes

Returns the event catalog that webhook patterns are checked against: the built-in event families plus any plugin families the deployment configured, each with its type, subject, publishing module and description.

Decided like the rest of the group, with `compute:webhooks:manage` on `compute-tenant/{tenantId}`. The method comes from the events module and is not in core's API catalog, so it has no phase.
