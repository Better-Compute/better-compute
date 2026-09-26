# @better-compute/provider-kubernetes

Kubernetes as a capacity source for better-compute (PLAN.md §3.8). bcd runs as a privileged DaemonSet in an existing cluster, joins each node to a pool, and hands the GPUs that compute books to the node's kubelet.

**Compute never schedules pods, and it never runs a Kubernetes control plane.** It books devices; the cluster schedules and runs the workloads. A reservation with `binding: 'kubernetes'` on such a pool makes bcd's device plugin advertise exactly the devices it holds (resource `bcd.dev/gpu`, CDI names `bcd.dev/gpu=<uuid>`) and withdraw them on release. Kubernetes can then schedule those GPUs and no others.

This is the *hosted* mode: bcd runs inside the cluster. The other mode is the `k8s-join` config unit (`policy.kubernetes` with `apiServer`, `caCertSha256` and `joinTokenRef`), in which machines compute provisions join a cluster through kubeadm. That unit is provision's and bcd's, not this package's.

```ts
import { bcdDaemonSetManifests, renderKubernetesManifests } from '@better-compute/provider-kubernetes';

const manifests = bcdDaemonSetManifests({
  image: 'registry.example.com/better-compute/bcd:0.6.0@sha256:…',
  gatewayUrl: 'https://gw.eu-central.example.com',
  siteId: 'site_k8s_prod',
  pins: { servingCaPin, joinSigningPin, joinEncryptionPin }, // pki bootstrapPins()
  controlPlaneUrl: 'https://compute.example.com/api/compute', // or joinEncryptionJwk
  joinTokenSecret: { name: 'bcd-join' },
});
writeFileSync('bcd.json', renderKubernetesManifests(manifests)); // kubectl apply -f bcd.json
```

## Setting a cluster up

1. Create a pool for the cluster's nodes, with `policy.kubernetes = { platformOperated? }` and none of the join settings (the nodes are in the cluster already).
2. Create a join token for the pool with `hosted: 'kubernetes'` (core/0027) and `maxUses` of at least the node count. JoinService lands these nodes at trust `tenant-controlled` unless the pool is `platformOperated: true`. The token decides this, never the node.
3. Store the token in the cluster: `kubectl -n bcd-system create secret generic bcd-join --from-literal=token=bcjt_…`.
4. Apply the manifests.

When all nodes have joined, delete the Secret. A node that has joined keeps its identity in `/var/lib/bcd` and joins again without a token.

## The pod

| | |
| --- | --- |
| `join` (init) | `bcd join` with the token Secret mounted read-only. It runs as root for the hostPath data directory, but has no capabilities, no privilege escalation and a read-only root. On a node that joined before, it succeeds without spending the token. |
| `bcd` | `bcd node`, privileged. It needs devices, cgroups, CDI specs under `/etc/cdi` and `/var/run/cdi`, the kubelet's device-plugin socket under `/var/lib/kubelet`, and `/etc/kubernetes/kubelet.conf` read-only to keep its own Node's `bcd.dev/*` labels (NodeRestriction allows those). It never sees the token. Its liveness probe is `bcd status`. |
| Pod | Host network, no service account token (bcd needs no API access of its own), `system-node-critical`, tolerates every taint by default, and rolls when `config.toml` changes (`bcd.dev/config-sha256`). |

`config.toml` comes from a ConfigMap. It holds the gateway, site, pins and `[host] units = false`, so bcd applies no host units: the cluster's own tooling, such as the NVIDIA GPU operator, owns drivers, MIG and kernel settings. Set `hostUnits: true` to let the pool's host units apply. The join token is never in it.

`bcdDaemonSetManifests` refuses an image not pinned by digest, a non-https gateway or control plane URL, malformed pins and names, resource quantities it can't parse, and a JWK with a private part.

## Options

| field | default | |
| --- | --- | --- |
| `image` | (required) | `registry/repo[:tag]@sha256:<64 hex>` |
| `gatewayUrl`, `siteId`, `pins` | (required) | As the pool's site and the PKI bundle give them. |
| `joinEncryptionJwk` / `controlPlaneUrl` | one required | The JoinService encryption key, or where `bcd join --server` fetches it (the well-known document). It's pinned either way. |
| `joinTokenSecret` | (required) | `{ name, key = 'token' }` |
| `namespace`, `name`, `createNamespace` | `bcd-system`, `bcd`, `true` | |
| `nodeSelector`, `tolerations` | every node, every taint | |
| `priorityClassName` | `system-node-critical` | `null` for none. |
| `imagePullSecrets`, `resources` | none; 100m / 128Mi requests, 512Mi limit | |
| `hostUnits` | `false` | |
| `gatewayServerName`, `logLevel` | none, `info` | |

The contract with bcd is checked on both sides. `scripts/daemon-k8s-contract.mjs` writes `daemon/cmd/bcd/testdata/k8s-daemonset.json`, and bcd's `TestKubernetesDaemonSetContract` parses its `config.toml` and command lines with bcd's own parser and flag sets. Tests: [`tests/provider-kubernetes.test.ts`](../../tests/provider-kubernetes.test.ts).
