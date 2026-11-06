Load balancers on a provider account (DigitalOcean regional and global first). Every call records what the tenant wants and returns at once; the `vps.provider-resources` reconciler converges the provider through `ProviderImpl.loadBalancers`. Reading takes `compute:load-balancers:read`, everything else `compute:load-balancers:manage`, on `provider-load-balancer/{id}`. A load balancer books one `loadBalancers` quota on the pool (no quota row grants none) and bills `vps.load-balancer.hours` from `ready` until deleted.

What a load balancer reaches is computed from the tenant's own rows and sent to the provider as explicit machine ids, never a tag, so it never reaches another tenant's machine. A `regional` one targets the tenant's instances in its pool and region (`targets: { pool: true }`) or named instances of the tenant (`targets: { instanceIds }`); a `global` one targets the tenant's regional load balancers (`targets: { loadBalancerIds }`). An instance counts once it has a machine and until it is being deleted. Deleting an instance updates its load balancers at once; one that gains a machine is added by the periodic pass, within five minutes.

## create

Makes a load balancer with its `forwarding` rules (1 to 15; an `https` or `http2` entry names a `certificateId` of the tenant on the same account, or an `https` one passes TLS through with `tlsPassthrough`), an optional `healthCheck`, `stickySessions`, `sourceRanges` and `redirectHttpToHttps`, and (global only) the `domains` it serves. It returns `pending`, booking one `loadBalancers`; no room, or no quota row, is `QUOTA_EXCEEDED`. Another tenant's instance is `ACCESS_DENIED`, another region or account `INVALID_INPUT`, another tenant's certificate or load balancer `NOT_FOUND`. Named instances are also decided as `compute:instances:update` on each, with the caller's own credential. The provider is asked once the certificates it names are ready. Publishes `providerLoadBalancer.created`, then `providerLoadBalancer.ready` with its `address`, or `providerLoadBalancer.error`.

## list

Returns the tenant's load balancers in the order they were made (at most 1000), optionally of one pool or project. Deleted ones only with `includeDeleted`.

## get

Returns one load balancer: its settings, targets, `address` (and `addressV6`) once assigned, and its state.

## update

Replaces each part given (`forwarding`, `healthCheck`, `targets`, `stickySessions`, `sourceRanges`, `redirectHttpToHttps`, `domains`) in place and returns it `updating` until the provider has applied it; publishes `providerLoadBalancer.updated` with what `changed`. The scope, region and pool never change: make another load balancer.

## delete

Marks the load balancer for deletion and returns it `deleting`; the reconciler deletes it at the provider, refunds its quota and publishes `providerLoadBalancer.deleted`. A regional load balancer a global one of the tenant targets is `INVALID_STATE` (reason `inUse`).
