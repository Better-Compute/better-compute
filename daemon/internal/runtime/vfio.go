package runtime

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// VFIO binding for passthrough GPUs (PLAN.md §3.6): libvirt's managed hostdevs rebind a device
// themselves; cloud-hypervisor opens /dev/vfio/<group> and needs every endpoint of the group bound to
// vfio-pci first (a GPU's audio function shares its group: VFIO refuses a group with a device still
// on a host driver). Bridges in the group stay on their driver (VFIO allows pcieport). When the
// instance goes, the devices go back to the driver the kernel picks for them.

// SysfsVFIO binds and releases PCI devices through sysfs under Root ("" or "/": the real one).
type SysfsVFIO struct {
	Root string
	// probed runs after a write to drivers_probe (tests: plays the kernel's rebind).
	probed func(dev string)
}

func (v SysfsVFIO) path(p string) string {
	if v.Root == "" {
		return p
	}
	return filepath.Join(v.Root, p)
}

func (v SysfsVFIO) write(p, value string) error {
	err := os.WriteFile(v.path(p), []byte(value), 0o644)
	if err == nil && v.probed != nil && p == "/sys/bus/pci/drivers_probe" {
		v.probed(value)
	}
	return err
}

// driver is the driver a device is bound to ("" when none).
func (v SysfsVFIO) driver(addr string) string {
	link, err := os.Readlink(v.path("/sys/bus/pci/devices/" + addr + "/driver"))
	if err != nil {
		return ""
	}
	return filepath.Base(link)
}

// bridge reports a PCI bridge (class 0x0604): left on its driver.
func (v SysfsVFIO) bridge(addr string) bool {
	raw, err := os.ReadFile(v.path("/sys/bus/pci/devices/" + addr + "/class"))
	return err == nil && strings.HasPrefix(strings.TrimSpace(string(raw)), "0x0604")
}

// groupDevices are the devices of addr's IOMMU group.
func (v SysfsVFIO) groupDevices(addr string) ([]string, error) {
	entries, err := os.ReadDir(v.path("/sys/bus/pci/devices/" + addr + "/iommu_group/devices"))
	if err != nil {
		return nil, fmt.Errorf("%s has no IOMMU group (is the IOMMU on?): %w", addr, err)
	}
	var out []string
	for _, e := range entries {
		if pciAddress.MatchString(e.Name()) {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

// Bind puts every endpoint of addr's IOMMU group on vfio-pci (a no-op for those already there).
func (v SysfsVFIO) Bind(addr string) error {
	if !pciAddress.MatchString(addr) {
		return fmt.Errorf("%q is not a PCI address", addr)
	}
	devices, err := v.groupDevices(addr)
	if err != nil {
		return err
	}
	for _, dev := range devices {
		if v.bridge(dev) || v.driver(dev) == "vfio-pci" {
			continue
		}
		base := "/sys/bus/pci/devices/" + dev
		if err := v.write(base+"/driver_override", "vfio-pci"); err != nil {
			return fmt.Errorf("override %s's driver: %w", dev, err)
		}
		if current := v.driver(dev); current != "" {
			// A GPU the host driver still uses refuses to unbind (or blocks): holds and VMs never
			// share a GPU (the devices converger checks), so nothing of ours runs on it.
			if err := v.write(base+"/driver/unbind", dev); err != nil {
				return fmt.Errorf("unbind %s from %s: %w", dev, current, err)
			}
		}
		if err := v.write("/sys/bus/pci/drivers_probe", dev); err != nil {
			return fmt.Errorf("probe %s for vfio-pci: %w", dev, err)
		}
		if got := v.driver(dev); got != "vfio-pci" {
			return fmt.Errorf("%s is on %q, not vfio-pci (is the vfio-pci module loaded?)", dev, got)
		}
	}
	return nil
}

// Release takes addr's IOMMU group off vfio-pci and lets the kernel probe it again (the GPU driver
// takes it back). Best effort per device; the first error is returned.
func (v SysfsVFIO) Release(addr string) error {
	if !pciAddress.MatchString(addr) {
		return fmt.Errorf("%q is not a PCI address", addr)
	}
	devices, err := v.groupDevices(addr)
	if err != nil {
		return err
	}
	var first error
	for _, dev := range devices {
		if v.bridge(dev) {
			continue
		}
		base := "/sys/bus/pci/devices/" + dev
		errs := []error{v.write(base+"/driver_override", "\n")}
		if v.driver(dev) == "vfio-pci" {
			errs = append(errs, v.write(base+"/driver/unbind", dev))
		}
		errs = append(errs, v.write("/sys/bus/pci/drivers_probe", dev))
		if err := errors.Join(errs...); err != nil && first == nil {
			first = fmt.Errorf("release %s: %w", dev, err)
		}
	}
	return first
}
