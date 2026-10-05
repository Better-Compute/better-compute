//go:build !fakehw

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
	"github.com/better-compute/better-compute/daemon/internal/nvml"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
	"github.com/better-compute/better-compute/daemon/internal/tpm"
)

// hardwareBackend names the inventory source this binary was built with.
const hardwareBackend = "host"

// devBuild refuses dev-only configuration in production builds.
const devBuild = false

// collectInventory reads the host's inventory from procfs and sysfs (inventory.Collector), the GPUs
// completed by nvidia-smi (MIG, NVLink, topology, ECC, row remapping) when the driver is installed.
func collectInventory() (*inventory.NodeInventory, error) {
	inv, err := inventory.Collector{DMI: dmiSource, PassedThrough: passedThrough(), NICFirmware: inventory.EthtoolFirmware, NVMeHealth: inventory.NVMeHealth}.Collect()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if snap, err := (nvml.SMI{}).Snapshot(ctx); err == nil {
		inv.Gpus = nvml.Enrich(inv.Gpus, snap)
		inventory.Canonicalize(inv)
	}
	if gpusSeen != nil {
		_ = gpusSeen.Remember(inv.Gpus)
	}
	return inv, nil
}

// gpusSeen remembers each GPU while the NVIDIA driver has it, so one passed through to a VM (bound to
// vfio-pci, gone from the driver and nvidia-smi) stays in the inventory and keeps its PCI address for
// the runtimes. bcd node keeps it in its data directory (newHost); bcd hardware and doctor go without.
var (
	gpusSeenMu sync.Mutex
	gpusSeen   *inventory.GPUMemory
)

func rememberGPUs(dataDir string) {
	gpusSeenMu.Lock()
	defer gpusSeenMu.Unlock()
	if path := inventory.GPUMemoryPath(dataDir); dataDir != "" && (gpusSeen == nil || gpusSeen.Path != path) {
		gpusSeen = &inventory.GPUMemory{Path: path}
	}
}

func passedThrough() func(string) *inventory.Gpu {
	gpusSeenMu.Lock()
	defer gpusSeenMu.Unlock()
	if gpusSeen == nil {
		return nil
	}
	return gpusSeen.Lookup
}

// newRuntimes: libvirt-kvm when virsh is installed (a VPS host), its GPUs' PCI addresses from the
// inventory for VFIO; a host without libvirt runs no instances.
func newRuntimes(dataDir, _ string) []runtime.Runtime {
	rememberGPUs(dataDir)
	gpuAddress := func(id string) (string, bool) {
		// The bus ids come from sysfs; no need to wait on nvidia-smi. A GPU already on vfio-pci (a VM
		// restarting) is found by its remembered address.
		inv, err := inventory.Collector{PassedThrough: passedThrough()}.Collect()
		if err != nil || inv == nil || inv.Gpus == nil {
			return "", false
		}
		for _, g := range inv.Gpus.Gpus {
			if g.Uuid == id {
				return pciAddress(g.PciBusId)
			}
		}
		return "", false
	}
	// Each runtime whose tools are installed: libvirt-kvm (virsh) and cloud-hypervisor.
	// One volume store for every runtime (the agent keeps the same directory).
	volumes := &runtime.Volumes{Dir: runtime.VolumeDir(dataDir)}
	var out []runtime.Runtime
	if _, err := exec.LookPath("virsh"); err == nil {
		out = append(out, &runtime.Libvirt{Dir: filepath.Join(dataDir, "libvirt"), GPUAddress: gpuAddress, Volumes: volumes})
	}
	if _, err := exec.LookPath("cloud-hypervisor"); err == nil {
		out = append(out, &runtime.CloudHypervisor{Dir: filepath.Join(dataDir, "cloud-hypervisor"), GPUAddress: gpuAddress, Volumes: volumes})
	}
	return out
}

// newSimHost: simulated machines exist only in fakehw builds.
func newSimHost(string, uint64, func()) (agent.Host, error) {
	return nil, errors.New("bcd sim needs a fakehw build (go build -tags fakehw)")
}

// tpmDevice is the kernel's TPM resource manager: it loads and flushes contexts per open file, so
// bcd's transient keys never collide with another TPM user's.
const tpmDevice = "/dev/tpmrm0"

// nodeKeyTPM keeps node keys in the host's TPM when the kernel's resource manager is there, opened by
// this process (root: bcd node without a helper, bcd join, bcd helper). An unprivileged bcd node
// reaches it only through bcd helper (loadConfig).
func nodeKeyTPM(string) func() (tpm.Keys, error) {
	if _, err := os.Stat(tpmDevice); err != nil {
		return nil
	}
	return func() (tpm.Keys, error) {
		d, err := tpm.OpenDevice(tpmDevice)
		if err != nil {
			return nil, err
		}
		return tpm.DeviceKeys(d), nil
	}
}

// openTPM is the host's TPM for the tpm join attestor.
func openTPM(string) (tpm.Transport, func(), error) {
	d, err := tpm.OpenDevice(tpmDevice)
	if err != nil {
		return nil, nil, err
	}
	return d, func() { _ = d.Close() }, nil
}

// newHost is the machine bcd runs on; a reboot goes through systemd so units stop cleanly.
func newHost(dataDir string) (agent.Host, error) {
	rememberGPUs(dataDir)
	return &agent.RealHost{
		Collect:    collectInventory,
		RebootFunc: func(string) error { return exec.Command("systemctl", "reboot").Run() },
	}, nil
}
