package hostconfig

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// IOMMU is the `iommu` unit: the IOMMU on, for GPUs passed through to VMs and sandboxes with VFIO
// (the runtimes bind each instance's GPUs to vfio-pci; that needs IOMMU groups). The kernel
// arguments (intel_iommu=on or amd_iommu=on by CPU vendor, and iommu=pt so the host's own DMA is
// not translated unless passthrough is false) apply from the next boot: until /sys/class/iommu
// shows an IOMMU the unit reports that the node needs a reboot, and it never reboots. Removing
// the unit removes the arguments. Load vfio-pci with the kernel-modules unit.
type IOMMU struct{}

// IOMMUClass lists the active IOMMUs (dmar0, ivhd0, ...).
const IOMMUClass = "/sys/class/iommu"

type iommuSettings struct {
	// Passthrough adds iommu=pt (default true): only devices given to guests are translated.
	Passthrough *bool `json:"passthrough"`
}

func (IOMMU) Name() string { return "iommu" }

// cpuVendor reads the CPU vendor from /proc/cpuinfo (GenuineIntel, AuthenticAMD, ...).
func cpuVendor(sys System) (string, error) {
	info, err := sys.ReadFile("/proc/cpuinfo")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(info), "\n") {
		if k, v, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(k) == "vendor_id" {
			return strings.TrimSpace(v), nil
		}
	}
	return "", nil
}

func (u IOMMU) Plan(_ context.Context, sys System, settings json.RawMessage) ([]converge.Action, error) {
	var s iommuSettings
	if err := decode(u.Name(), settings, &s); err != nil {
		return nil, err
	}
	vendor, err := cpuVendor(sys)
	if err != nil {
		return nil, err
	}
	var args []string
	switch vendor {
	case "GenuineIntel":
		args = append(args, "intel_iommu=on")
	case "AuthenticAMD", "HygonGenuine":
		args = append(args, "amd_iommu=on")
	case "":
		// Arm and others enable their SMMU by default: only the passthrough mode is an argument.
	default:
		return nil, converge.Terminal(fmt.Errorf("iommu: no IOMMU arguments known for CPU vendor %q", vendor))
	}
	if s.Passthrough == nil || *s.Passthrough {
		args = append(args, "iommu=pt")
	}
	actions, err := planBootArgs(sys, u.Name(), strings.Join(args, " "))
	if err != nil {
		return nil, err
	}
	active, err := sys.ReadDir(IOMMUClass)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if len(active) == 0 {
		actions = append(actions, fail(needsReboot("iommu: the IOMMU is on from the next boot (%s): reboot the node; check the firmware enables VT-d or AMD-Vi", strings.Join(args, " "))))
	}
	return actions, nil
}

// Clean removes the arguments.
func (u IOMMU) Clean(_ context.Context, sys System) ([]converge.Action, error) {
	return planBootArgs(sys, u.Name(), "")
}
