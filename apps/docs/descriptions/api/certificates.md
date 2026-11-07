TLS certificates on a provider account (DigitalOcean first), for the tenant's [load balancers](/docs/reference/api/load-balancers). Every call records what the tenant wants and returns at once; the `vps.provider-resources` reconciler converges the provider through `ProviderImpl.certificates`. Reading takes `compute:certificates:read`, everything else `compute:certificates:manage`, on `provider-certificate/{id}`. Certificates book no quota (at most 100 per tenant) and do not bill.

## create

Makes a certificate and returns it `pending`. `kind: 'managed'` has the provider issue and renew it for `domains`, each of which must be in one of the tenant's own [DNS zones](/docs/reference/api/dns-zones) on the same provider account (`INVALID_INPUT`, reason `domainNotOwned`): the provider issues certificates for any domain the account hosts, which may be another tenant's. `kind: 'custom'` uploads the tenant's own PEMs: `certificate`, `privateKey` and optionally `chain` are references to the tenant's own secrets, `secret://<tenantId>/<id>`, and any other scheme or tenant is `INVALID_INPUT`. The row keeps only the references; they are resolved in the call that uploads the PEMs, by a resolver that refuses every reference the certificate does not name, and never appear in a view, event or log. The name is unique in the tenant (`CONFLICT`); the same `idempotencyKey` returns the same certificate. Publishes `providerCertificate.created`, then `providerCertificate.ready` or `providerCertificate.error`.

## list

Returns the tenant's certificates in the order they were made (at most 1000), optionally of one pool or project. Deleted ones only with `includeDeleted`.

## get

Returns one certificate: its kind, names, state and, once issued or uploaded, `notAfter` and `fingerprint`.

## delete

Marks the certificate for deletion and returns it `deleting`; the reconciler deletes it at the provider and publishes `providerCertificate.deleted`. A certificate a load balancer of the tenant still names is `INVALID_STATE` (reason `inUse`): change or delete that load balancer first. A certificate is immutable; to change one, make another and point the load balancer at it.
