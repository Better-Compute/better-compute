//go:build !fakehw

package main

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
	"github.com/better-compute/better-compute/daemon/internal/nvml"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// hardwareBackend names the inventory source this binary was built with.
const hardwareBackend = "host"

// devBuild refuses dev-only configuration in production builds.
const devBuild = false

// collectInventory reads the host's inventory from procfs and sysfs (inventory.Collector), the GPUs
// completed by nvidia-smi (MIG, NVLink, topology, ECC, row remapping) when the driver is installed.
func collectInventory() (*inventory.NodeInventory, error) {
	inv, err := inventory.Collector{}.Collect()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if snap, err := (nvml.SMI{}).Snapshot(ctx); err == nil {
		inv.Gpus = nvml.Enrich(inv.Gpus, snap)
		inventory.Canonicalize(inv)
	}
	return inv, nil
}

// newRuntimes: libvirt-kvm when virsh is installed (a VPS host), its GPUs' PCI addresses from the
// inventory for VFIO; a host without libvirt runs no instances.
func newRuntimes(dataDir, _ string) []runtime.Runtime {
	gpuAddress := func(id string) (string, bool) {
		// The bus ids come from sysfs; no need to wait on nvidia-smi.
		inv, err := inventory.Collector{}.Collect()
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

// newHost is the machine bcd runs on; a reboot goes through systemd so units stop cleanly.
func newHost(string) (agent.Host, error) {
	return &agent.RealHost{
		Collect:    collectInventory,
		RebootFunc: func(string) error { return exec.Command("systemctl", "reboot").Run() },
	}, nil
}
