Kubernetes clusters are managed Kubernetes clusters (Google Kubernetes Engine, Standard and Autopilot) on a provider account, served by the `@better-compute/kubernetes` module. The provider runs the control plane; better-compute never runs one itself. A cluster belongs to one provider pool, so to that pool's account, and the account's provider must provide managed Kubernetes (a provider that does not is `UNSUPPORTED`). Two hosting models use the same calls: a platform account's pool offered to the tenant (the cluster lives in the platform's cloud project), or a pool on the tenant's own account (the cluster lives in the tenant's project). The calls record what the tenant wants and return at once; the `kubernetes.clusters` reconciler then creates the cluster at the provider, its node pools once the control plane is up, applies changes in place and deletes what the tenant deleted. `state` shows where it is: `pending`, `provisioning`, `ready` (the control plane and every node pool are ready), `updating`, `deleting`, `deleted` or `error` (with a `message`). The reconciler publishes `kubernetes.cluster.ready` the first time, `kubernetes.cluster.updated` when it is ready again after a change or the provider moved it to another version (a release-channel upgrade), `kubernetes.cluster.error` and `kubernetes.cluster.deleted`. Clusters still converging are looked at every 30 seconds; ready and failed ones are refreshed every five minutes, which retries an error and picks up what changed at the provider.

The provider-side name of a cluster is `bc-k-` and 24 characters of its id, and it carries the label `better-compute-cluster` with the cluster id. A cluster bills `kubernetes.cluster.hours` (one per hour, to the tenant) from the moment the provider first accepted it until it is deleted, on pools whose billing mode is `metered` or `platform-fee`. Its nodes are not metered here: the provider bills them to the account, and on a platform account they reach the tenant through the account's cost pass-through rules.

## create

Records a cluster and returns it `pending`, with its node pools.

- The pool must be visible to the tenant (its own, or offered to it), a `provider` pool, and its account's provider must provide managed Kubernetes; otherwise `UNSUPPORTED` (`NOT_FOUND` for a pool the tenant cannot see).
- `location` is a zone the account is configured with (a zonal cluster) or the region of one (a regional cluster); anything else is `INVALID_INPUT` with the allowed zones and regions in `details`.
- `mode`: `standard` takes 1 to 10 `nodePools` (created with the cluster); `autopilot` takes none (`INVALID_INPUT` otherwise), the provider runs its nodes. Node pool fields are as for [kubernetesNodePools.create](/docs/reference/api/kubernetes-node-pools); a node pool's `zones` must be zones of the cluster's region (and of the account).
- `releaseChannel` defaults to `regular`; `version` (a minor such as `1.33` or a full version) pins the control plane, otherwise the channel's default applies. `authorizedNetworks` lists at most 50 IPv4 CIDRs that may reach the control-plane endpoint (empty: any address; requests are still authenticated). `privateNodes: true` gives nodes no public addresses.
- `networkId` names a tenant network ([networks](/docs/reference/api/networks)) on the same account that has been provisioned and has a `ready` subnet in the cluster's region; the nodes use it and that subnet (the first by name when there are several). Another tenant's network, or one on another account, is `INVALID_INPUT`; one not provisioned yet is `INVALID_STATE`.
- `name` is 1 to 40 characters, `[a-z]([-a-z0-9]*[a-z0-9])?`, unique among the tenant's clusters that are not deleted (`CONFLICT` otherwise; a deleted cluster's name is free again).
- A tenant that already has 10 clusters that are not deleted (the module's `maxClustersPerTenant`; one being deleted still counts) is `QUOTA_EXCEEDED`, with the cap in `details.limit`.
- Decided as `compute:kubernetes:create` on the cluster it would create (`compute-kubernetes-cluster`, under the tenant), whose attributes are `providerAccountId`, `poolId`, `projectId`, `mode` and `location`. A refusal leaves nothing behind. After the decision the tenant's offer is checked as for `instances.create` (a suspended offer or an excluded region refuses), and the tenant's budgets unless the pool's billing mode is `none`.

The cluster id derives from the tenant, the caller and `idempotencyKey`. A retry with the same key returns the same cluster; the same key with any other field changed is `CONFLICT`. The caller owns the cluster. Publishes `kubernetes.cluster.created`.

## list

Returns the tenant's clusters with their node pools, oldest first; `poolId` and `projectId` narrow it, and `includeDeleted: true` adds deleted ones. At most 500 are returned. Decided as `compute:kubernetes:read` on the tenant.

## get

Returns one cluster with its node pools, its `endpoint` and the `kubernetesVersion` and `nodeVersion` the provider last reported. A cluster of another tenant is `NOT_FOUND` here, and is refused by the decision (`ACCESS_DENIED`) before that. Decided as `compute:kubernetes:read` on the cluster.

## update

Changes the control-plane `version`, the `releaseChannel`, the `authorizedNetworks` or the `description`; name at least one (`INVALID_INPUT` otherwise). The first three change in place at the provider: a `ready` or failed cluster goes `updating` and back to `ready` once the provider has them (`kubernetes.cluster.updated`). The description is better-compute's alone and changes nothing at the provider. Every update bumps `version`. A cluster being deleted is `INVALID_STATE`. A version the provider refuses (a downgrade, one it does not offer) shows as `error` with its message. Decided as `compute:kubernetes:update` on the cluster.

## delete

Marks the cluster and its node pools for deletion and returns it `deleting`. The reconciler deletes the cluster at the provider (its node pools go with it); the cluster and its pools are then `deleted`, its authorization row is removed and `kubernetes.cluster.deleted` is published. Deleting a cluster that is being deleted returns it unchanged. Publishes `kubernetes.cluster.deleting`. Decided as `compute:kubernetes:delete` on the cluster.

## credentials

Returns a short-lived kubeconfig for the caller: `{ kubeconfig, expiresAt, role }`, where `kubeconfig` is YAML text with one cluster (the control-plane endpoint and its CA), one user with a bearer token, one context and `current-context` set.

- `role` is `view` (the default), `edit` or `admin`, bound to Kubernetes' built-in `view`, `edit` and `cluster-admin` roles. The call is decided as `compute:kubernetes:connect` on the cluster; `edit` also needs `compute:kubernetes:update` and `admin` `compute:kubernetes:delete` on it, decided with the caller's own credential (`ACCESS_DENIED` otherwise).
- The provider mints the token for a Kubernetes service account derived from the caller and the role (`bc-u-`, 16 hex digits of a hash of the identity, `-view`/`-edit`/`-admin`), so each role keeps its own account and a later `view` kubeconfig never narrows an `admin` one the caller holds.
- `ttlSeconds` is 600 to 86400 (default 3600, the module's `credentialTtlSeconds`).
- The cluster must be `ready` (or `updating` after it was ready once); otherwise `INVALID_STATE`.
- The token is never stored, logged or published. Publishes `kubernetes.cluster.credentials-issued` with the role, subject, identity, ttl and expiry.

## versions

Returns the Kubernetes versions the provider offers in a location of a pool visible to the tenant: `defaultVersion`, `validVersions`, and per release channel its default and valid versions. The pool and location are checked as for `create`. Decided as `compute:kubernetes:read` on the tenant.
