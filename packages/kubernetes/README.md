# @better-compute/kubernetes

Managed Kubernetes clusters for better-compute: GKE Standard and Autopilot (and later other providers' managed
Kubernetes) on the provider accounts `@better-compute/vps` manages. The provider runs the control plane;
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
  changed or deleted; only the node pools its flavors add are. One substrate per cluster. Account, mode, location
  and private nodes never change in place (the substrate goes `error`); a flavor's shape never does either (give
  the new shape another name). Direct `kubernetesClusters.delete` and `kubernetesNodePools` changes are refused.
- **bcd.** Once the cluster is ready, each run mints a 600 s `admin` credential (`ProviderKubernetes.credentials`,
  service account `bc-substrate`), held in memory for that run only, lists the substrate's Nodes and server-side
  applies bcd (Namespace, ConfigMap, DaemonSet with the substrate node selector, device plugin only).
- **Join token.** A hosted `kubernetes` join token, with one use per Node whose bcd is not connected, and its
  Secret exist only while nodes are still to join; then the token is revoked and the Secret deleted. A Node
  replaced by an upgrade, a scale-down or a Spot reclaim gets a new one. Compute books the nodes' GPUs like any
  `binding: 'kubernetes'` pool's.
- **Upgrades.** By default (`upgrades: 'surge'`) a `version` change reaches the provider at once: its surge upgrade
  replaces the Nodes, and the bookings on a replaced Node end as below. With `upgrades: 'drain'` the pool's nodes
  first go NoSchedule `substrate-upgrade` (no new bookings; running ones keep going), and the version is pushed
  once their bookings ended, or once the drain took `drainTimeout` (e.g. `24h`; absent, it waits). Other settings
  (`releaseChannel`, `authorizedNetworks`) are pushed at once. The reason goes once the cluster runs the version.
  Events `draining { version, bookings }` and `upgrading { version, drained }`. The provider, not better-compute,
  picks which Node it replaces next, so `disruptionBudget` does not apply.
- **Removed Nodes.** A pool node maps to its Kubernetes Node by the OS hostname bcd reports. One that is not
  connected and whose Node is gone from the cluster's full Node list (a scale-down, a Spot reclaim, a repair) gets
  NoSchedule `substrate-node-removed`, and its reservations end through capacity's `endNodeReservations`: bound ones
  are released with their quota refunded once (Spot ones as `preempted`), unbound ones go back to `pending` and are
  placed elsewhere. It stops counting as joined. If the Node comes back and bcd reconnects, the reason goes.
- **Teardown.** Archiving the pool or removing `policy.substrate` revokes the token, cordons the pool's nodes
  (`substrate-teardown`), waits for their bookings to end (nothing is force-released), removes bcd from the
  cluster, then deletes a created cluster (an adopted one stays).
- **Secrets.** No credential or join token is stored, logged or published; rows keep the token's id only.
- **Read.** `kubernetesSubstrates.get({ tenantId, poolId })` (`compute:kubernetes:read`, the pool owner's tenant):
  mode, cluster id, state and message, Nodes listed and joined, and a drain's `upgrade { version, since }`. Never a
  token id or a credential.
- **Wake-ups.** A substrate runs when its cluster or one of its node pools changes state, besides its own 10 s poll
  while converging and the 30 s sweep.
- **Doctor.** `selfCheck` reports `kubernetes.substrate-agent-missing` (pools declare `policy.substrate` but
  `kubernetes({ substrate })` is not configured) and `kubernetes.substrate-error` (substrates in error, by pool).
- **Events** `kubernetes.substrate.*` (`created`, `ready`, `error`, `token-issued`, `token-revoked`, `node-removed`,
  `draining`, `upgrading`, `deleting`, `deleted`), subject `pool/{id}`. Migration `kubernetes/0002_substrates`. Adopted clusters bill no
  `kubernetes.cluster.hours`.

## License

Apache-2.0
