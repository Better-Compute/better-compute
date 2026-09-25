## UNAUTHENTICATED

The request carries no credential, or IAM does not accept the one it carries.

Send a valid IAM session or API key. An expired key or a revoked session answers the same way; the message does not say which.

## ACCESS_DENIED

IAM decided the call's `action @ resource` and denied it.

Callers outside the input tenant (and outside the root tenant) are refused before any database access. Grant the action in IAM, or call as an identity that holds it. See [Actions and resources](/docs/guides/iam/actions-and-resources).

## CONFIRMATION_REQUIRED

The caller is an agent acting for a person, and that person must confirm the request first.

`details` carries `confirmationId`, the `action` and `resource`, and `expiresAt` when IAM set one. Nothing was changed. Once the person confirms, retry with the same `idempotencyKey`. See [Delegated confirmation](/docs/guides/iam/delegated-confirmation).

## NOT_FOUND

The route, or the object the input names, does not exist or is not visible to the caller.

Lookups are scoped to the input `tenantId`, so an id that belongs to another tenant is not found.

## INVALID_INPUT

The body failed validation: a missing or unknown field, a wrong type, or a value outside its constraints.

Unknown fields are refused, never ignored. The Input table of each method in the [API reference](/docs/reference/api) lists every accepted field.

## INVALID_STATE

The object exists but is in a state that does not allow the call, such as uncordoning a node being deleted or extending a released reservation.

Read the object again and act on its current state. Retrying unchanged fails the same way.

## CONFLICT

The call raced a concurrent change, or reuses an `idempotencyKey` for a different request, or names something that already exists.

A concurrent change is safe to retry after reading the object again. A reused key with a different body is not: send a new key for a new request.

## CAPACITY_UNAVAILABLE

No placement satisfies the request now: there are not enough free GPUs, or none that match its constraints, in the pools it may use.

Retry later, relax the constraints, or book a later window. See [Placement](/docs/guides/capacity/placement).

## QUOTA_EXCEEDED

The request would take the tenant or project past a quota, or past a per-tenant limit such as the number of webhooks.

Release something, or raise the quota with `quotas.set`. See [Quotas and usage](/docs/guides/capacity/quotas-and-usage).

## SPEND_LIMIT_REACHED

An IAM budget covering this request is spent, and the pool refuses new work when a budget is exceeded.

`details` names the budget (`budgetId`, `name`) when IAM reports it. See [Billing and usage](/docs/guides/iam/billing-and-usage).

## UNSUPPORTED

The request is valid, but the driver, provider or deployment it lands on cannot do it: a provider with no power control, an instance that cannot be resized in place, or a deployment with no SSH CA.

## UPGRADE_REQUIRED

The peer speaks a protocol version older than the server's minimum.

A daemon below `proto_min` is welcomed but receives only `daemon.upgrade` until it runs a supported version. See [Protocol](/docs/daemon/protocol).

## RATE_LIMITED

Too many requests of this kind, from the caller or to a provider behind the call.

Wait `retryAfterMs` when the error carries it, then retry. The TypeScript client does this once when created with `retryRateLimited` (waits up to 5 seconds by default).

## DRIVER_ERROR

A driver, a node command or a site agent failed, or answered with something compute cannot trust: a BMC operation that failed, an unattested result, or firmware and BIOS settings that did not take.

The message names the step; `details` may carry the driver's own code (`driverCode`).

## PROVIDER_ERROR

A VPS or bare-metal provider's API refused or failed the call.

The message carries the provider's reason. Background work such as instance bootstraps retries it; a direct call does not.

## INVALID_CONFIG

The deployment is configured wrongly, for example an option out of range or a module that needs another one.

This describes the server, not the request, so it answers 500. Fix the configuration and restart.

## NOT_IMPLEMENTED

The method or feature is planned for a later phase and not built in this release.

`details` names the `feature` and the `phase` that delivers it. See the [roadmap](/docs/reference/roadmap).

## CSRF_REJECTED

A POST lacks `content-type: application/json` or the `X-Better-Compute: 1` header, or a cookie-authenticated request has no `Origin`.

Browsers cannot send that header cross-site without a preflight, so it stops cross-site request forgery. Clients built on the SDK send it.

## UNTRUSTED_ORIGIN

A cookie-authenticated request, or a tunnel's WebSocket upgrade, came from an `Origin` other than the deployment's own.

## METHOD_NOT_ALLOWED

The HTTP method is not accepted on this path.

API methods are `POST` only; `GET` serves `/health` and `/.well-known/better-compute`; tunnels need a WebSocket upgrade.

## PAYLOAD_TOO_LARGE

The request body is larger than the server accepts.

## INTERNAL_ERROR

An unexpected failure on the server.

The server logs it with the request id (`x-request-id`); quote that id when reporting it.

## MISSING_DEPENDENCY

An optional package or service the deployment needs for this call is not installed or not configured, such as PGlite for an embedded database or a remote IAM endpoint.

Like `INVALID_CONFIG`, it describes the deployment, so it answers 500.

## CONFIG_DRIFT

The fleet changed after the plan was made, so `fleet.apply` refused a plan whose `planHash` no longer matches.

Plan again and review the new plan. `--fail-on-drift` in the CLI uses the same code. See [Fleet configuration](/docs/guides/fleet-config).

## UNAVAILABLE

A dependency the request needs is unreachable for now: the secret store's KMS, a node's gateway, or remote IAM.

Nothing was changed. Retry after `retryAfterMs`.

## TENANT_SUSPENDED

The IAM tenant is suspended, so its mutations are refused, or deleted, so every call is refused.

`details` carries the `tenantId` and its `state`. A suspension or deletion also covers the tenant's descendants, and root-tenant callers are exempt. Reads still work in a suspended tenant. See [Tenancy](/docs/guides/iam/tenancy).
