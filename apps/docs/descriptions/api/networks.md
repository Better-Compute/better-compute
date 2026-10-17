Networks are a tenant's private networks (VPCs) on a provider account, with their subnets and firewall rules ([firewallRules](/docs/reference/api/firewall-rules)). A network belongs to one provider pool, so to that pool's account, and the provider must support tenant networks (Google Cloud does; a provider that does not is `UNSUPPORTED`). The calls record what the tenant wants and return at once. The `vps.networks` reconciler then converges the provider: it creates the VPC, then the subnets and the firewall rules, tags the network's instances, and removes what the tenant deleted, rules first, then subnets, then the network. `state` shows where it is: `pending`, `ready`, `deleting`, `deleted` or `error` (with a `message`). The network's `state` covers the VPC and its subnets (`ready` when all are; `error` with the failing resource in `message`); each subnet and each rule also has its own `state`, and a rule the provider refuses is `error` on the rule without taking the network out of `ready`. The reconciler publishes `network.ready`, `network.error`, `network.subnet.ready`, `network.rule.ready`, `network.rule.error` and `network.deleted`. An `error` is retried by the periodic pass, which runs every five minutes and also re-applies what drifted at the provider (a firewall deleted by hand).

The provider-side name of a network, a subnet and a rule is `bc-` and the resource's own id, lower-cased. A machine on the network carries the tag `bc-` and 16 hex digits of the sha256 of its instance id, so a rule can target single instances.

## create

Records a network on the pool's provider account and returns it `pending`, with no subnets yet.

- The pool must be offered to the tenant, a `provider` pool, and its account's provider must support networks; otherwise the call is `UNSUPPORTED` (`NOT_FOUND` for a pool the tenant cannot see).
- `name` is 1 to 42 characters, `[a-z]([-a-z0-9]*[a-z0-9])?`, unique among the tenant's networks that are not deleted (`CONFLICT` otherwise; the name of a deleted network is free again).
- Decided as `compute:networks:create` on the network it would create (`compute-network`, under the tenant), whose attributes are `providerAccountId`, `poolId` and `projectId`. A refusal leaves nothing behind.

The network id derives from the tenant, the caller and `idempotencyKey`. A retry with the same key returns the same network; the same key with another pool, name, project or description is `CONFLICT`. The caller owns the network. Publishes `network.created`.

## list

Returns the tenant's networks with their subnets, oldest first; `poolId` and `projectId` narrow it, and `includeDeleted: true` adds deleted ones. At most 500 are returned. Decided as `compute:networks:read` on the tenant.

## get

Returns one network with its subnets (`pending`, `ready`, `deleting`, `deleted` or `error`). A network of another tenant is `NOT_FOUND` here, and is refused by the decision (`ACCESS_DENIED`) before that. Decided as `compute:networks:read` on the network.

## update

Changes the network's `description`. The name, pool and account never change, because the provider cannot rename a network. A network being deleted is `INVALID_STATE`. Decided as `compute:networks:update` on the network.

## delete

Marks the network, its subnets and its rules for deletion and returns it `deleting`. The reconciler deletes the rules, then the subnets, then the network, and then the network is `deleted` and publishes `network.deleted`.

- `INVALID_STATE` while instances that are not deleted are on the network, with their ids in `details.instanceIds`: delete or move them first.
- Deleting a network that is being deleted returns it unchanged.

Publishes `network.deleting`. Decided as `compute:networks:delete` on the network.

## addSubnet

Adds a subnet and returns the network with it `pending`.

- `cidr` is an IPv4 range inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16 (RFC 1918), with a prefix from /8 to /29, written as its network address (`10.0.0.0/20`). Anything else is `INVALID_INPUT`.
- It must not overlap another subnet of the network, in any region: that is `CONFLICT`, and the database refuses it too.
- `region` must be a region of the zones the account is configured with (`us-central1` for the zone `us-central1-a`); otherwise `INVALID_INPUT`, with the allowed regions in `details`.
- The name is unique in the network; the name of a deleted subnet is free again.
- A network being deleted is `INVALID_STATE`.

Publishes `network.subnet.ready` once the provider has the subnet. Decided as `compute:networks:update` on the network.

## removeSubnet

Marks a subnet for deletion and returns the network with the subnet `deleting`. `INVALID_STATE` while instances that are not deleted use the subnet, with their ids in `details.instanceIds`. Its range is free for a new subnet at once. Decided as `compute:networks:update` on the network.
