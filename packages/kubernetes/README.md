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

## License

Apache-2.0
