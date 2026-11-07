Reserved public addresses on a provider account (DigitalOcean reserved IPv4 and IPv6 first), assigned to the account's [instances](/docs/reference/api/instances). Every call records what the tenant wants and returns at once; the `vps.provider-resources` reconciler converges the provider through `ProviderImpl.addresses`. Reading takes `compute:addresses:read`, everything else `compute:addresses:manage`, on `provider-address/{id}`. An address books one `addresses` quota on the pool and bills `vps.address.hours` from `ready` until deleted. A DigitalOcean reserved IP carries no name or tag, so the row is the ownership record: one address is recorded by at most one live row, and it keeps the provider's fingerprint from the reserve where there is one (a reserved IPv6's reservation time; a reserved IPv4 has none). An address released at the provider outside better-compute (gone, mismatched, or handed to a later reserve) goes to `error` for good: never re-adopted, assigned or released, and its delete makes no provider call.

## create

Reserves an address (`family` `ipv4` or `ipv6`) in a region the account uses and returns it `pending`, booking one `addresses`. The name is unique in the tenant (`CONFLICT`); no room, or no quota row, is `QUOTA_EXCEEDED`. The same `idempotencyKey` returns the same address. With `prefix` (an IPv4 CIDR or the provider's id of a BYOIP prefix on the account) the address is drawn from the account's own address space instead of the provider's pool: IPv4 only (`INVALID_INPUT`), only for the provider account's owner tenant (`ACCESS_DENIED`, reason `byoipNotOwner`), and on DigitalOcean only with the account's `previews` enabled; a prefix that is not the account's, not active or in another region sends the address to `error`. A reserve whose answer was lost is never sent again (it could reserve a second address): the address goes to `error` saying so, and an operator checks the account. Publishes `providerAddress.created`, then `providerAddress.ready` with its `address`, or `providerAddress.error`.

## list

Returns the tenant's addresses in the order they were made (at most 1000), optionally of one pool or project. Deleted ones only with `includeDeleted`.

## get

Returns one address: the IP, its state, the instance it is wanted on and `assignmentState` (`none`, `pending`, `ready`, `deleting`, `error` with `assignmentMessage`).

## assign

Puts the address on an instance of the tenant on the same provider account and region and returns it with `assignmentState: 'pending'`; the reconciler assigns it and publishes `providerAddress.assigned`. Another tenant's instance is `ACCESS_DENIED`, another region `INVALID_INPUT`, an address on another instance `CONFLICT` (unassign it first). The reconciler never takes an address over from a machine it did not put it on. An address whose reservation is gone (`error`, lost) is `INVALID_STATE`. Also decided as `compute:instances:update` on the instance, with the caller's own credential.

## unassign

Takes the address off its instance and keeps it reserved; the reconciler unassigns it and publishes `providerAddress.unassigned`. An unassigned address is returned as it is.

## delete

Marks the address for deletion and returns it `deleting`; the reconciler releases it at the provider, refunds its quota and publishes `providerAddress.deleted`. An assigned address is `INVALID_STATE` (unassign it first). An address whose IP the provider has since handed to another reservation is not released: the row is finished with a warning in the log.
