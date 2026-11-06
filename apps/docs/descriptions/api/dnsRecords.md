The records of a tenant's [DNS zone](/docs/reference/api/dnsZones). Every method names the zone and is decided on it: reading takes `compute:dns:read`, everything else `compute:dns:manage`, on `provider-dns-zone/{zoneId}`. Records book no quota (at most 500 per zone) and do not bill. The provider's ownership marker (`_better-compute`) and its apex NS and SOA records are never touched.

## create

Makes a record (`name` relative to the zone, `@` for the apex; `type` A, AAAA, CNAME, TXT, MX, SRV, CAA or NS, default A) and returns it `pending` until its zone is ready and the provider has it. `data` is checked against the type before anything is written: an A record holds an IPv4 address, an AAAA record an IPv6 one, CNAME, MX, SRV and NS an absolute host name with a final dot. An apex NS or CNAME and the reserved `_better-compute` name are `INVALID_INPUT`; the same name, type and data twice is `CONFLICT`. An A or AAAA record may follow an instance of the tenant instead (`instanceId`, no `data`): its data is a reserved address assigned to the instance, else the instance's first public address; the record waits until there is one and is deleted with the instance. Another tenant's instance is `ACCESS_DENIED`; the instance is also decided as `compute:instances:update`, with the caller's own credential. Publishes `providerDnsRecord.created`, then `providerDnsRecord.ready` or `providerDnsRecord.error`.

## list

Returns the zone's records in the order they were made (at most 1000). Deleted ones only with `includeDeleted`.

## get

Returns one record: its name, `fqdn`, type, data, TTL, the type's own fields and its state.

## update

Changes `data`, `ttlSeconds` and the type's own fields (`priority`, `port`, `weight`, `flags`, `tag`) in place and returns it `updating`; the name and type never change. A record that follows an instance takes no `data`.

## delete

Marks the record for deletion and returns it `deleting`; the reconciler deletes it at the provider and publishes `providerDnsRecord.deleted`. A record whose id the provider has since given to another record is not deleted: the row is finished with a warning in the log.
