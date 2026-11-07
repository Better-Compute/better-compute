# @better-compute/kubernetes

Managed Kubernetes clusters for better-compute: GKE Standard and Autopilot, and Amazon EKS (managed node groups, and
EKS Auto Mode for `autopilot`; see [provider-aws](../provider-aws#managed-kubernetes-eks)), on the provider accounts
`@better-compute/vps` manages. The provider runs the control plane;
better-compute never runs one itself. It records what the tenant wants, converges it through
`ProviderImpl.kubernetes`, issues short-lived kubeconfigs and meters cluster hours.

Two hosting models use the same API:

- **Platform-hosted**: a root (platform) account's provider pool offered to tenants, as for platform-issued VMs.
  Clusters live in the platform's cloud project.
- **Bring your own**: a pool on the tenant's own provider account. Clusters live in the tenant's project.

## Install

```sh
npm install @better-compute/kubernetes
```

## Usage

```ts
import { betterCompute } from '@better-compute/server';
import { vps } from '@better-compute/vps';
import { kubernetes } from '@better-compute/kubernetes';
import { gcpProvider } from '@better-compute/provider-gcp';

const providers = [gcpProvider()];
const compute = betterCompute({
  // database, secret, baseURL, iam, ...
  modules: [
    vps({ providers }),
    // The same provider definitions: this module builds its own clients from the same accounts.
    kubernetes({ providers, credentialTtlSeconds: 3600, maxClustersPerTenant: 10 }),
  ],
});

const cluster = await compute.api.kubernetesClusters.create(credential, {
  tenantId,
  poolId, // a provider pool visible to the tenant, whose provider implements `kubernetes`
  name: 'training',
  mode: 'standard',
  location: 'us-central1',
  nodePools: [
    {
      name: 'gpu',
      machineType: 'g2-standard-8',
      nodeCount: 1,
      accelerators: { type: 'nvidia-l4', count: 1 },
    },
  ],
  idempotencyKey: 'training-1',
});
// … once it is ready:
const { kubeconfig } = await compute.api.kubernetesClusters.credentials(credential, {
  tenantId,
  clusterId: cluster.id,
  role: 'view', // 'edit' needs compute:kubernetes:update, 'admin' compute:kubernetes:delete
});
```

## What it adds

- **API groups** `kubernetesClusters` (`create`, `list`, `get`, `update`, `delete`, `credentials`, `versions`) and
  `kubernetesNodePools` (`create`, `list`, `update`, `delete`), on the IAM resource kind `kubernetes-cluster`
  (actions `compute:kubernetes:create|read|update|delete|connect`).
- **Reconcilers**: `kubernetes.clusters` (per cluster; a 30 s sweep of clusters still converging and a 5 min refresh
  of ready and failed ones) and `kubernetes.usage` (every 5 minutes).
- **Events** `kubernetes.cluster.*` (`created`, `ready`, `updated`, `error`, `deleting`, `deleted`,
  `credentials-issued`) and `kubernetes.nodepool.*` (`created`, `ready`, `error`, `deleted`), subject
  `kubernetes-cluster/{id}`.
- **Migration** `kubernetes/0001_clusters`: `kubernetes_clusters`, `kubernetes_node_pools`, and the `kubernetes`
  usage source kind.
- **Tenancy**: a deleted tenant's clusters are deleted at the provider (`tenantDeleted`).

## Credentials

`credentials` never stores, logs or publishes a token. The provider creates (or reuses) a Kubernetes service account
for the caller and role, `bc-u-<16 hex of the identity's sha256>-<view|edit|admin>`, binds it to the built-in
`view`, `edit` or `cluster-admin` role and mints a bound token (600 s to a day). One account per role keeps a later
`view` request from narrowing an `admin` kubeconfig the caller already holds.

## Metering

`kubernetes.cluster.hours`: one per cluster per hour from the moment the provider first accepted it until it is
deleted, billed to the cluster's tenant (pools in billing mode `metered` and `platform-fee`; `none` records nothing).
Windows are `kubernetes` usage sources, tagged with the pool, provider, region, project and
`source: kubernetes-<mode>`.

**Node costs are not metered here.** The provider bills a cluster's nodes (and GKE's own cluster fee) to the cloud
account. On a platform-hosted cluster they reach the tenant through the account's provider cost pass-through rules
(`providerAccounts` `billing.passThrough`); on a tenant's own account the tenant pays its provider directly.

## Pool substrates

A pool can be backed by a managed cluster on any provider whose `ProviderImpl.kubernetes` exists (GKE today; EKS
and DOKS plug in the same way). The pool declares it in its policy; the `kubernetes.substrates` reconciler does the
rest:

```ts
import { kubernetesSubstrateAgent } from '@better-compute/provider-kubernetes';

kubernetes({
  providers,
  // What runs bcd on the cluster: the DaemonSet options except what the pool decides.
  substrate: { agent: kubernetesSubstrateAgent({ image, gatewayUrl, pins, controlPlaneUrl }) },
});

await compute.api.pools.create(credential, {
  tenantId,
  siteId,
  class: 'metal-host',
  gpuModel: 'L4',
  policy: {
    kubernetes: { platformOperated: true }, // DaemonSet mode: no k8s-join settings; device plugin only
    substrate: {
      kind: 'kubernetes',
      account: providerAccountId, // one of the pool owner's accounts
      cluster: { create: { location: 'us-central1', version: '1.34' } }, // or { adopt: '<provider cluster id>' }
      flavors: [
        { name: 'gpu', machineType: 'g2-standard-8', nodes: 2, gpus: { type: 'nvidia-l4', count: 1 } },
        { name: 'gpu-spot', machineType: 'g2-standard-8', nodes: 4, gpus: { type: 'nvidia-l4', count: 1 }, spot: true },
      ],
      allowSpot: true,
      upgrades: 'drain', // version bumps wait for the pool's bookings to end
      drainTimeout: '24h',
    },
  },
  idempotencyKey: 'l4-pool',
});
```

- **Cluster.** `create`: an ordinary `kubernetesClusters` cluster (`substratePoolId` set) with one node pool per
  flavor, labelled `better-compute.dev/substrate-pool=<pool id>` (Spot ones also `better-compute.dev/capacity=spot`).
  Changing `version`, `releaseChannel` or `authorizedNetworks` in the policy upgrades it in place; an operator's
  `kubernetesClusters.update` does too. `adopt`: an existing cluster, read with `getCluster` and never created,
  changed or deleted; only the node pools its flavors add are, named `bc-<last 6 of the pool id>-<flavor>`
  (`substrateNodePoolName`; flavor names of at most 30 characters) so a flavor can never resize or delete one of the
  tenant's own pools of the same name (ProviderKubernetes cannot list pools). One substrate per cluster. Account, mode, location
  and private nodes never change in place (the substrate goes `error`); a flavor's shape never does either (give
  the new shape another name). Direct `kubernetesClusters.delete` and `kubernetesNodePools` changes are refused.
- **Isolated workers.** `create.networkId` puts the nodes on a network of the pool owner (same account, a ready
  subnet in the cluster's region); `create.privateNodes: true` gives them no public addresses and needs a
  `networkId`: bcd then reaches its gateway through that network's NAT, which the operator runs (better-compute
  has no NAT resource). Both are part of the substrate's identity (never changed in place).
- **bcd.** Once the cluster is ready, each run mints a 600 s `admin` credential (`ProviderKubernetes.credentials`,
  service account `bc-substrate`), held in memory for that run only, lists the substrate's Nodes and server-side
  applies bcd (Namespace, ConfigMap, DaemonSet with the substrate node selector, device plugin only). The
  credential is never sealed or stored, not even through `SecretStore`: a fresh one each run is cheaper than a
  stored one is safe. Every applied object carries `better-compute.dev/substrate-pool=<pool id>`. On an adopted
  cluster each object is read first, and one of the same name without that label (a `bcd-system` the tenant made)
  makes the substrate `error`: nothing is applied over it. The Node list is paged (100 per answer).
- **Join token.** A hosted `kubernetes` join token, with one use per Node whose bcd is not connected, and its
  Secret exist only while nodes are still to join; then the token is revoked and the Secret deleted. A Node
  replaced by an upgrade, a scale-down or a Spot reclaim gets a new one. A Secret deleted or replaced on the cluster
  meanwhile is restored with a new token. Compute books the nodes' GPUs like any `binding: 'kubernetes'` pool's.
- **Owned nodes.** The substrate owns only the pool nodes one of its own hosted tokens admitted (every token it
  mints is recorded, `kubernetes_substrate_tokens`; each node is classified once from JoinService's
  `node.joined` / `node.reclaimed` audit row). Machines joined into the pool some other way (a tenant's join
  token, another attestor, nodes there before the pool had a substrate) never count as the cluster's joined Nodes,
  never go NoSchedule for its drains or teardown, never hold them up and are never retired by it. A node that
  joined with the hosted token but never connected counts as joined for 10 minutes
  (`substrateFirstConnectGraceSeconds`), then is retired (`kubernetes.substrate.node-removed { reason:
  'never-connected' }`), so its replacement Node gets a token.
- **Upgrades.** By default (`upgrades: 'surge'`) a `version` change reaches the provider at once: its surge upgrade
  replaces the Nodes, and the bookings on a replaced Node end as below. With `upgrades: 'drain'` the pool's nodes
  first go NoSchedule `substrate-upgrade` (no new bookings; running ones keep going), and the version is pushed
  once their bookings ended, or once the drain took `drainTimeout` (e.g. `24h`; absent, it waits). Other settings
  (`releaseChannel`, `authorizedNetworks`) are pushed at once. The reason goes once the cluster runs the version.
  Events `draining { version, bookings }` and `upgrading { version, drained }`. The provider, not better-compute,
  picks which Node it replaces next, so `disruptionBudget` does not apply. With `upgrades: 'drain'`,
  `kubernetesClusters.update` refuses a version change on the substrate's cluster (`INVALID_STATE`): change
  `policy.substrate.cluster.create.version`, so the drain is kept.
- **Removed Nodes.** A connected pool node is matched once to its Kubernetes Node by the Node name bcd reports
  (inventory `kubernetes.nodeName`, else `os.hostname`), only when that is exactly a listed Node's name; its uid is
  recorded too (`kubernetes_substrate_nodes`). A node that matches no Node (an EKS hostname that is not the Node
  name) is never taken for gone. A matched node that is not connected and whose Node is gone from the cluster's full
  Node list, or listed under its name with another uid (EKS reuses IP-based names), is removed: its reservations end
  through capacity's `endNodeReservations` (bound ones released with their quota refunded once, Spot ones as
  `preempted`; unbound ones back to `pending` and placed elsewhere), and it is retired (`retired`, certificates
  revoked, NoSchedule `substrate-node-removed`). Its replacement joins as a new node.
- **Teardown.** Archiving the pool or removing `policy.substrate` revokes the token, cordons the substrate's own
  nodes (`substrate-teardown`), waits for their bookings to end (nothing is force-released), removes bcd from the
  cluster (only objects carrying its label), then deletes a created cluster (an adopted one stays, with only the
  substrate's node pools deleted), and retires those nodes. On an adopted cluster it also revokes the identity its
  credentials were minted for (`ProviderKubernetes.revokeCredentials`: service account `bc-substrate` and its
  cluster-admin binding). There a refused credential, a failed delete or a failed revoke keeps the substrate
  `deleting` with the message (retried every 2 minutes) until it succeeds; only a cluster the provider no longer
  has counts as nothing to remove. A driver without `revokeCredentials` lets teardown finish and leaves a message
  on the deleted substrate (doctor: `kubernetes.substrate-credentials-left`). A deleted tenant's substrate clusters
  are torn down through their substrate (its pools are archived), never marked deleted behind its back.
  Bookings are waited for however long they run, future ones included (no timeout applies to teardown).
- **Secrets.** No credential or join token is stored, logged or published; rows keep the token's id only.
- **Read.** `kubernetesSubstrates.get({ tenantId, poolId })` (`compute:kubernetes:read`, the pool owner's tenant):
  mode, cluster id, state and message, Nodes listed and joined, and a drain's `upgrade { version, since }`. Never a
  token id or a credential.
- **Wake-ups.** A substrate runs when its cluster or one of its node pools changes state, besides its own 10 s poll
  while converging and the 30 s sweep.
- **Doctor.** `selfCheck` reports `kubernetes.substrate-agent-missing` (pools declare `policy.substrate` but
  `kubernetes({ substrate })` is not configured), `kubernetes.substrate-error` (substrates in error, by pool) and
  `kubernetes.substrate-credentials-left` (torn-down substrates whose adopted cluster keeps `bc-substrate`).
- **Events** `kubernetes.substrate.*` (`created`, `ready`, `error`, `token-issued`, `token-revoked`, `node-removed`,
  `draining`, `upgrading`, `deleting`, `deleted`), subject `pool/{id}`. Migrations `kubernetes/0002_substrates`, `kubernetes/0003_substrate_nodes` and
  `kubernetes/0004_substrate_ownership`. Adopted clusters bill no
  `kubernetes.cluster.hours`.

## License

Apache-2.0
