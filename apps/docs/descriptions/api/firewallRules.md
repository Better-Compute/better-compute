Firewall rules belong to a [network](/docs/reference/api/networks) and are decided on it: reading them takes `compute:networks:read`, changing them `compute:networks:update`. A rule says which traffic is allowed or denied, from where and to which instances, and the `vps.networks` reconciler applies it at the provider as a firewall named `bc-` and the rule's id. A rule that names instances applies to the machines carrying those instances' network tags (`bc-` and 16 hex digits of the sha256 of the instance id), which the reconciler sets on each instance that owns its machine (applying rules first: a tag set later still matches); a rule that names none applies to every instance on the network. A network has at most 100 rules that are not deleted.

## create

Adds a rule to the network and returns it `pending`.

- `direction` is `ingress` or `egress`. `action` defaults to `allow`, `priority` to 1000 (0 to 65535, lower wins) and `enabled` to `true`; a disabled rule exists at the provider but matches nothing.
- `rules` lists 1 to 20 entries `{ protocol, ports? }` with `protocol` one of `tcp`, `udp`, `icmp` and `all`. `ports` (tcp and udp only) are ports (`"22"`) or ranges (`"8000-8100"`); without them every port is covered.
- An ingress rule must name its `sources`, IPv4 CIDRs, and takes no `destinations`; the whole internet is `0.0.0.0/0`, written out, never implied. An egress rule takes `destinations` (without them, everywhere) and no `sources`. Violations are `INVALID_INPUT`.
- `targets.instanceIds` names instances of the tenant that are on this network and not deleted; any other is `INVALID_INPUT`. Empty targets cover the whole network.
- The name is unique in the network (`CONFLICT`); the name of a deleted rule is free again. A hundred live rules already is `QUOTA_EXCEEDED`. A network being deleted is `INVALID_STATE`.

Publishes `network.rule.ready` once the provider has the rule, or `network.rule.error` with the reason. Decided as `compute:networks:update` on the network.

## list

Returns the network's rules that are not deleted, sorted by name, with their state (`pending`, `ready`, `deleting`, `error`).

## update

Changes the given fields of a rule (`direction`, `action`, `priority`, `rules`, `sources`, `destinations`, `targets`, `enabled`; the name never changes), checks the result as `create` does, bumps `version`, returns the rule `pending` and wakes the reconciler. An empty `sources` or `destinations` list clears it. A rule that changes direction names its other range list again.

## delete

Marks the rule for deletion and returns it `deleting` with `version` bumped; the reconciler removes the firewall at the provider. Deleting a rule that is being deleted returns it unchanged.
