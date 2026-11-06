# @better-compute/fleet

FleetConfig as code for better-compute: export, plan and apply a tenant's sites, provider accounts, pools, offers, quotas, flavors, sandbox templates and managed Kubernetes clusters from one document.

## Install

```sh
npm install @better-compute/fleet
```

It is also included in the umbrella package as `better-compute/fleet`:

```sh
npm install better-compute
```

## Usage

```ts
import { betterCompute } from 'better-compute';
import { fleetModule } from '@better-compute/fleet';

const compute = betterCompute({
  // database, secret, baseURL, iam, and the modules that own the objects fleet manages ...
  modules: [fleetModule({ driftEvery: '15m' })],
});
```

A FleetConfig document, in the style of Better IAM's `TenantConfig`, describes one tenant's platform objects by name:

- sites
- provider accounts
- pools, with their owner quota and the offers made to other tenants
- VPS flavors
- sandbox templates
- managed Kubernetes clusters with their node pools (`@better-compute/kubernetes`)

```yaml
version: 1
sites:
  - { name: fra, kind: shared, region: eu-central }
providerAccounts:
  - { name: cloud, provider: hetzner-cloud, config: { token: secret://hetzner } }
pools:
  - name: vps-fra
    site: fra
    class: vps-host
    gpuModel: L40S
    ownerQuota: { gpu: 8 }
    offers:
      - { tenant: acme, quota: { vcpu: 64, gpu: 2 }, priority: 5 }
  - { name: burst, site: fra, class: provider, providerAccount: cloud }
flavors:
  - { pool: vps-fra, name: g1.small, vcpu: 2, memoryGiB: 4, diskGiB: 40 }
```

`validateFleetConfig(value)` checks a parsed document. Secrets appear only as `secret://` references, never as values.

## Methods

Every method decides `compute:fleet:admin` on the `fleet` scope (`global`, which resolves only in the root tenant):

- **`fleet.export`** writes the current state as a document. Objects fleet did not create are named by their id.
- **`fleet.plan`** diffs a document against the current state.
  - It returns human-readable `changes` (create, update, delete or unchanged, with the changed fields).
  - It returns the exact `calls` that apply would make, and a `planHash`.
  - Changes that cannot be applied are marked `blocked`. These include sites (they never change and are never deleted), a pool's site, class, sharing, agent or provider account, dangling references, and an offer to the pool's owner.
  - Deletes happen only with `prune: true`:
    - Pools are archived, and live bookings keep running.
    - Flavors are deleted.
    - Offers are withdrawn.
    - A provider account is deleted only once no pool, substrate or cluster uses it.
    - Kubernetes node pools, then clusters, are deleted.
- **`fleet.apply`** runs the plan through the owning modules' own methods (`sites.create`, `pools.*`, `quotas.set`, `flavors.*`, `providerAccounts.*`, `sandboxTemplates.*`, `kubernetesClusters.*`, `kubernetesNodePools.*`). It is a composite method with `transaction: 'manual'`, and runs in two phases:
  1. Each call is decided for the caller with `ctx.check`, with no transaction open. The caller therefore needs each underlying permission as well as `fleet:admin`.
  2. Inside one transaction, fleet re-reads the state and plans again. If the call list changed, the state moved between the phases: nothing is applied and apply fails with `CONFIG_DRIFT` (409). Otherwise every call runs through `ctx.invoke`.

  Pass the reviewed `planHash` to apply exactly the plan that was shown. If the state has moved since then, apply fails with the same drift error.

- **`fleet.status`** reports the last applied document (its `planHash`, who applied it and when) and any drift.

## Kubernetes

With the kubernetes module, `kubernetesClusters` lists the tenant's managed clusters (GKE, EKS, DOKS through `ProviderImpl.kubernetes`) by name, on a pool of the document or an offered pool's id:

```yaml
pools:
  - { name: gke, site: us, class: provider, providerAccount: gcp }
  - name: gpu-substrate
    site: us
    class: vps-host
    policy:
      kubernetes: {}
      substrate:
        kind: kubernetes
        account: gcp # a provider account of the document, by name
        cluster: { create: { location: us-central1 } }
        flavors:
          [{ name: l4, machineType: g2-standard-8, nodes: 2, gpus: { type: nvidia-l4, count: 1 } }]
kubernetesClusters:
  - name: training
    pool: gke
    location: us-central1
    releaseChannel: stable
    authorizedNetworks: [203.0.113.0/24]
    nodePools:
      - { name: system, machineType: e2-standard-4, nodeCount: 1 }
      - name: gpu
        machineType: g2-standard-8
        nodeCount: 0
        autoscaling: { minNodes: 0, maxNodes: 4 }
        accelerators: { type: nvidia-l4, count: 1 }
```

- **Create.** A new cluster is one `kubernetesClusters.create` with its node pools (a standard cluster needs at least one: a create without one is blocked; a live cluster whose last node pool was deleted exports `nodePools: []`). Machine types take every provider form: `e2-standard-4` (GKE), `s-2vcpu-4gb` (DOKS), `m5.large` (EKS). Its admission is `composable`, so `fleet.apply` decides and runs it like every other call; a refused or rolled-back create leaves no projection row behind. A cluster on a pool the same plan creates is `deferred`: the change has no call, the next apply creates it, and the fleet reports it as drift until then.
- **Update.** `releaseChannel` (default `regular`), `authorizedNetworks` (default none), `description` (default none: dropping it clears it) and `version` when the document names it change in place. Node pools are added, and `nodeCount` and `autoscaling` change in place; a resize to a `nodeCount` outside the autoscaling bounds the pool ends with is blocked. A cluster's `pool`, `mode`, `location`, `privateNodes`, `networkId` and `projectId`, and every other node pool field, are blocked: create one under another name.
- **Prune.** Node pools, then clusters, are deleted (at the provider, with what runs on them) before pools are archived. A cluster or node pool being deleted is not deleted again, and blocks a document that still lists it until it is gone. A provider account stays while a cluster runs on it: one of the tenant's own, or another tenant's on a pool it offers (the plan says only that one does, never which).
- **Substrates.** A pool substrate's cluster belongs to its pool (`policy.substrate`) and never appears in `kubernetesClusters`; its name is taken. `policy.substrate.account` may name a provider account of the document; export writes it by name. A change of the substrate's account or cluster (location, private nodes, network, adopted id) is blocked: archive the pool, which tears the substrate down, and create another.
- **Keys.** A cluster's (and an added node pool's) idempotency key counts the clusters of that name there ever were, `fleet:<tenant>:kubernetesCluster:<name>:<n>`, so a cluster created again after a delete never replays the deleted one.
- Without the kubernetes module, clusters are blocked and `export` lists `kubernetes_clusters` as missing. No credential or kubeconfig ever appears in the document, the plan or the drift.

## Drift

Every apply, including one with nothing to change, records the document it applied in `fleet_applied` (migration `fleet/0002_applied`). The `fleet.drift` reconciler re-plans each recorded document every 15 minutes (`fleetModule({ driftEvery })`). A non-empty plan means someone changed the fleet outside fleet:

- It publishes `fleet.drifted` once per distinct drift, with the summary and up to 50 changes.
- It publishes `fleet.converged` when the drift clears on its own.
- `fleet.status` shows the drift as of the last check.

Applying the document again resets it. From the CLI, `better-compute fleet status --fail-on-drift` exits `FLEET_DRIFTED` for monitoring.

## Ids

Created objects get deterministic ids. The idempotency key is `fleet:<tenant>:<kind>:<name>`, and the id is `draftId(prefix, tenant, caller, key)`, so a retried apply converges instead of duplicating. The module's table `fleet_names` (migration `fleet/0001_names`) maps names to ids.

## Documentation

- [Fleet configuration](https://better-compute.com/docs/guides/fleet-config)
- [fleet API reference](https://better-compute.com/docs/reference/api/fleet)

## License

[Apache License 2.0](https://github.com/better-compute/better-compute/blob/main/LICENSE)
