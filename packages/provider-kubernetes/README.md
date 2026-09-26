# @better-compute/provider-kubernetes

Kubernetes as a capacity source for better-compute (PLAN.md §3.8). bcd runs as a privileged DaemonSet in an existing cluster, joins each node to a pool, and hands the GPUs that compute books to the node's kubelet.

**Compute never schedules pods, and it never runs a Kubernetes control plane.** It books devices; the cluster schedules and runs the workloads. A reservation with `binding: 'kubernetes'` on such a pool makes bcd's device plugin advertise exactly the devices it holds (resource `bcd.dev/gpu`, CDI names `bcd.dev/gpu=<uuid>`) and withdraw them on release. Kubernetes can then schedule those GPUs and no others, but **only if bcd is the only way to a GPU on the node** (see [GPU isolation](#gpu-isolation)). Another device plugin, or a runtime that hands out GPUs by environment variable, lets any pod take every GPU.

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
2. Create a join token for the pool with `hosted: 'kubernetes'` (core/0027), `maxUses` equal to the node count and a short TTL (an hour covers a rollout). JoinService lands these nodes at trust `tenant-controlled` unless the pool is `platformOperated: true`. The token decides this, never the node.
3. Store the token in the cluster: `kubectl -n bcd-system create secret generic bcd-join --from-literal=token=bcjt_…`.
4. Configure the GPU stack as [GPU isolation](#gpu-isolation) says, then apply the manifests.
5. **When every node has joined, revoke the token and delete the Secret.** A DaemonSet cannot use one single-use token per node, so the token is multi-use; anyone who reads the Secret while it is live can join a machine to the pool. A node that has joined keeps its identity in `/var/lib/bcd` and joins again without a token. The token volume is optional, so its pods still start after the Secret is gone. For nodes added later, mint a new token and Secret, and remove both again.

## GPU isolation

bcd hands a pod exactly the GPUs its reservation holds, and it can only enforce that when nothing else hands out GPUs on the node. With the NVIDIA GPU operator, its defaults are unsafe here: its own device plugin advertises every GPU, and its container runtime gives an unprivileged pod any GPU it names in `NVIDIA_VISIBLE_DEVICES`. Required:

- **`devicePlugin.enabled=false`**: bcd's device plugin (or its DRA driver) is the only source of GPUs for the kubelet.
- **`accept-nvidia-visible-devices-envvar-when-unprivileged = false`** in the NVIDIA container toolkit's `config.toml` (the GPU operator's `toolkit` env `ACCEPT_NVIDIA_VISIBLE_DEVICES_ENVVAR_WHEN_UNPRIVILEGED=false`): devices arrive by CDI only.
- CDI specs with `--device-name-strategy=uuid`, so bcd's device plugin answers `nvidia.com/gpu=<uuid>`. Without that spec it answers `bcd.dev/gpu=<uuid>` plus `NVIDIA_VISIBLE_DEVICES`, which is safe only with the setting above.

The generated DaemonSet carries these requirements in its `bcd.dev/requires` annotation, so they travel with the manifests.

bcd checks the first two on every pass. If the kubelet can also allocate `nvidia.com/*` devices (pod-resources), or a toolkit `config.toml` (`/etc/nvidia-container-runtime/` or the operator's `/usr/local/nvidia/toolkit/.config/nvidia-container-runtime/`) accepts `NVIDIA_VISIBLE_DEVICES` from unprivileged pods (the key true, or absent: the toolkit's default), it offers no GPUs at all. It finds the applicable toolkit config through the container runtime's configuration (`containerRuntime`, the runtime's `BinaryName`), and a runtime or toolkit config it cannot read counts as exposure too, so both are mounted read-only and must exist (`containerRuntime`, `nvidiaToolkit`). It stops its device plugins, deletes its DRA ResourceSlice, and reports the node condition `ForeignGpuExposure`, naming what to close.

## Host paths and Pod Security

bcd keeps its node key and journal in the hostPath `/var/lib/bcd` (files 0600, owned by root). Any pod allowed to mount host paths as root can read them, and with the key it can act as the node. Restrict host paths for everything else: label workload namespaces with Pod Security Admission `baseline` or `restricted` (both forbid hostPath and privileged pods). Only `bcd-system`, which the manifests label `pod-security.kubernetes.io/enforce: privileged`, and your platform's own system namespaces should run privileged. The pod runs without `hostPID` and with no service account token.

## The pod

| | |
| --- | --- |
| `join` (init) | `bcd join` with the token Secret mounted read-only. It runs as root for the hostPath data directory, but has no capabilities, no privilege escalation and a read-only root. On a node that joined before, it succeeds without spending the token. |
| `bcd` | `bcd node`, privileged. It needs devices, cgroups, CDI specs under `/etc/cdi` and `/var/run/cdi`, of the kubelet's state only `device-plugins` (read-write), `pod-resources` (read-only; connecting to its socket needs no write) and, with `gpuApi: 'dra'`, `plugins_registry` and `plugins/gpu.bcd.dev` (never `/var/lib/kubelet` itself, which holds every pod's volumes, secrets and tokens), and the kubelet's credentials read-only (`kubeletCredentials`: by default `/etc/kubernetes/kubelet.conf` and `/var/lib/kubelet/pki`). Nothing else of the host's `/etc/kubernetes` is mounted: on a control-plane node that holds `admin.conf` and the cluster CA's keys. It has no service account, and NodeRestriction confines the kubelet's credentials to its own Node and that Node's pods. It never sees the token. Its liveness probe is `bcd status`. |
| Pod | Host network, no service account token (bcd needs no API access of its own), `system-node-critical`, tolerates every taint by default, and rolls when `config.toml` changes (`bcd.dev/config-sha256`). |

**What the cluster needs:**
- The image carries `kubectl`. bcd labels its own Node and reaps pods of released devices with the kubelet's kubeconfig, and it touches only `bcd.dev/*` labels.
- The NVIDIA GPU operator, if any, configured as [GPU isolation](#gpu-isolation) requires.
- The device plugins start once the kubelet's `/var/lib/kubelet/device-plugins/kubelet.sock` exists. The pod-resources socket under `/var/lib/kubelet` tells bcd which pods hold which devices.

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
| `containerRuntime` | `containerd` (`/etc/containerd/config.toml`) | `k3s`, `rke2`, `cri-o` (`/etc/crio/crio.conf` and `crio.conf.d`), or `{ files, dirs }`, e.g. to add containerd's `conf.d`. Mounted read-only as `File`/`Directory` and never created: every path must exist on every selected node, because hosted bcd withdraws all GPUs when it cannot read the runtime's configuration. |
| `nvidiaToolkit` | `gpu-operator` (`/usr/local/nvidia/toolkit/.config`) | `packages` (`/etc/nvidia-container-runtime`), or `{ files, dirs }` for another `toolkit.installDir`. Read-only, must exist. |
| `nvidiaRuntimeClass` | `nvidia` | The RuntimeClass that gives bcd's own container the driver's utilities (`nvidia-smi`, NVML; `NVIDIA_VISIBLE_DEVICES=all` with the `utility` capability only). `null` when the image carries them. Workload pods are unaffected. |
| `gpuApi` | device plugin | `dra` for bcd's DRA driver (`[kubernetes] gpu_api`). |
| `kubeletCredentials` | kubeadm's: `/etc/kubernetes/kubelet.conf`, `/var/lib/kubelet/pki` | `{ kubeconfig, certificateDirs }` of another distribution (k3s: `/var/lib/rancher/k3s/agent/kubelet.kubeconfig`, `/var/lib/rancher/k3s/agent`). The kubeconfig lands where bcd reads it, and the directories at their own paths, all read-only. A directory that holds more than the kubelet's certificates (`/etc/kubernetes`, its `pki`, `/var/lib/kubelet`) is refused. |
| `gatewayServerName`, `logLevel` | none, `info` | |

The contract with bcd is checked on both sides. `scripts/daemon-k8s-contract.mjs` writes `daemon/cmd/bcd/testdata/k8s-daemonset.json`, and bcd's `TestKubernetesDaemonSetContract` parses its `config.toml` and command lines with bcd's own parser and flag sets. Tests: [`tests/provider-kubernetes.test.ts`](../../tests/provider-kubernetes.test.ts).
