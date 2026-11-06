DNS zones on a provider account (DigitalOcean Domains first), with their [records](/docs/reference/api/dnsRecords). Every call records what the tenant wants and returns at once; the `vps.provider-resources` reconciler converges the provider through `ProviderImpl.dns`. Reading takes `compute:dns:read`, everything else `compute:dns:manage`, on `provider-dns-zone/{id}`. Zones book no quota (at most 50 per tenant) and do not bill.

## create

Makes the zone for a domain (`zone`, lower case, without a final dot) and returns it `pending`. A domain has one live zone per provider account, so two tenants never share one: a second is `CONFLICT`, without saying whose it is. A zone the account already holds and vps did not make goes to `error` unless the account's owner tenant adopts it with `adopt: true`; any other tenant asking to adopt is `ACCESS_DENIED` (reason `adoptNotOwner`). Publishes `providerDnsZone.created`, then `providerDnsZone.ready` or `providerDnsZone.error`.

## list

Returns the tenant's zones in the order they were made (at most 1000), optionally of one pool or project. Deleted ones only with `includeDeleted`.

## get

Returns one zone: its domain, whether it was adopted, its state and, once the provider reported them, the `nameServers` the domain's registrar must delegate to.

## delete

Marks the zone for deletion and returns it `deleting`; the reconciler deletes it at the provider and publishes `providerDnsZone.deleted`. A zone that still holds records is `INVALID_STATE` (reason `zoneNotEmpty`). An adopted zone is only forgotten: it was the account's before and stays at the provider.
