Host config units are what a profile's `hostConfig` and a pool's policy turn into the NodeSpec `host` section; provision validates their settings against the manifests below, and bcd's host converger applies them, level-triggered: drift is repaired at the next pass (at least every 10 minutes). bcd converges them in this order, each seeing what the ones before it did: `kernel-modules`, `sysctl`, `hugepages`, `cpu`, `iommu`, `nvidia-driver`, `fabric-manager`, `gpu-settings`, `mig-layout`, `gpu-sharing`, `container-toolkit`, `k8s-join`. A unit that fails never holds back the others; the host section reports every failure, retried while any is. A unit whose state takes effect only after a reboot reports node condition `RebootRequired`: bcd never reboots on its own. Under `bcd helper`, the node plans each unit and the helper applies it as root, only as a spec signed under the pinned roots asks. With `[host] units = false` (bcd as a Kubernetes DaemonSet) no unit is applied. See [Host configuration](/docs/daemon/host-config).

## nvidia-driver

Installs the driver branch (Ubuntu's server packages, NVIDIA's CUDA repository, DNF module streams, SUSE's G06 packages) and loads it. A different driver already loaded is swapped only while no process holds the GPUs; otherwise the unit reports `RebootRequired`. It keeps `nvidia-persistenced` running where it is installed.

## container-toolkit

Installs the NVIDIA container toolkit, configures containerd and Docker with its runtime (with `cdi`, CDI enabled), and regenerates `/etc/cdi/nvidia.yaml` whenever the driver or the GPU and MIG device list changes.

## mig-layout

Partitions every MIG-capable GPU to the layout: `all-disabled`, `all-<profile>` (as many as fit, e.g. `all-1g.10gb`) or `mixed:<n>x<profile>+<profile>…` (per GPU, e.g. `mixed:3g.40gb+2x2g.20gb`), with a compute instance in each GPU instance. A GPU holding allocations or running compute processes is left as it is until they end (under `bcd helper`, the helper sees that itself, never taking the node's word). A MIG mode change that needs a GPU reset, which fails, reports `RebootRequired`.

## fabric-manager

On NVSwitch systems only (nothing to do elsewhere): installs and runs NVIDIA Fabric Manager; node condition `FabricManagerDown`, which makes the node NoSchedule, while it is not running.

## sysctl

Free-form: each key a sysctl name with a scalar value, written to `/etc/sysctl.d/90-bcd.conf` and set live. A key the kernel does not have yet (its module is not loaded) is retried. Keys that would run programs as root or lower the host's defenses are refused (`kernel.core_pattern`, `kernel.modprobe`, `kernel.usermodehelper.*`, `fs.binfmt_misc.*`, `kernel.randomize_va_space`, `kernel.yama.*`, `user.*` and the like), and a few take only their hardened values: `dev.tty.legacy_tiocsti` and `dev.tty.ldisc_autoload` only 0, `kernel.io_uring_disabled` only 1 or 2, `net.ipv4.ip_unprivileged_port_start` only 1024 and above.

## hugepages

2 MiB pages are allocated at runtime; 1 GiB pages at runtime when the kernel finds the memory, else through the boot loader (`hugepagesz=1G hugepages=N`) with `RebootRequired`. With `perNuma` the counts are per NUMA node. 1 GiB pages are mounted at `/dev/hugepages1G` (a systemd mount unit), 2 MiB pages at systemd's `/dev/hugepages`.

## kernel-modules

Modules loaded now and at every boot (`/etc/modules-load.d/bcd.conf`) with their options (`/etc/modprobe.d/bcd.conf`). A loaded module whose options differ is reloaded only when nothing uses it; otherwise they apply when it next loads. Sandbox hosts load `kvm_intel` or `kvm_amd`, `vhost_net`, `tun` and, for GPU passthrough, `vfio-pci`. Options that turn off DMA isolation for passed-through devices (`vfio` `enable_unsafe_noiommu_mode`, `vfio_iommu_type1` `allow_unsafe_interrupts`) are refused.

## k8s-join

Joins the machine to a Kubernetes cluster as a worker with a bootstrap token fetched through the secret broker, only to clusters root pins in `[kubernetes] allowed_clusters` under `bcd helper`. See [Kubernetes](/docs/daemon/kubernetes).

## gpu-sharing

`mps` runs the MPS control daemon (`bcd-mps.service`, each client limited to 100/`replicas` percent of the SMs, node condition `MPSDown` while it is down); `timeslice` stops it.

## cpu

Sets the frequency governor on every CPU that has one, and isolates CPUs from the scheduler for pinned vCPUs (`isolcpus`, `nohz_full`, `rcu_nocbs` through the boot loader, `RebootRequired` until the kernel shows them isolated). CPU 0 is never isolated.

## iommu

Turns the IOMMU on for GPUs passed through to VMs and sandboxes (`intel_iommu=on` or `amd_iommu=on`, and `iommu=pt` unless `passthrough` is false) through the boot loader, with `RebootRequired` until an IOMMU is active.

## gpu-settings

Caps each GPU's board power (applied again whenever it drifts; outside a GPU's range the unit fails) and sets the ECC mode, which changes at the GPU's next reset (`RebootRequired` until then).
