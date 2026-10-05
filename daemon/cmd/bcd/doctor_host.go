package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// Real-host preflight for doctor (PLAN.md §14): what a server must have before bcd can run its
// slices, units and instances there, and the inventory bring-up findings that tell an operator the
// control plane's view of this machine will be weaker (no DMI, no NICs). Paths are read under root
// ("" = the real filesystem) so tests can hand it a fake tree.

// cgroupControllers are the controllers bcd's slices and instance units set limits with.
var cgroupControllers = []string{"cpu", "cpuset", "memory", "io", "pids", "hugetlb"}

func hostPreflight(root string, inv *inventory.NodeInventory, privileged bool, clock func() (synced bool, detail string, err error)) []doctorCheck {
	read := func(p string) string {
		b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(p)))
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(b))
	}
	exists := func(p string) bool {
		_, err := os.Stat(filepath.Join(root, filepath.FromSlash(p)))
		return err == nil
	}
	var out []doctorCheck

	// systemd as init: hold slices, the helper's units and libvirt's scopes are systemd units.
	if exists("/run/systemd/system") {
		out = append(out, doctorCheck{"ok", "systemd", "systemd is the init system"})
	} else {
		out = append(out, doctorCheck{"fail", "systemd", "systemd is not running as init (/run/systemd/system): bcd's hold slices and instance units need it"})
	}

	// cgroup v2 controllers delegated to children at the root. Whether the kernel offers them at all is
	// the "cgroups" resource check (doctor_resources.go); this one says whether children can use them.
	if controllers := read("/sys/fs/cgroup/cgroup.controllers"); controllers != "" {
		have := map[string]bool{}
		for _, c := range strings.Fields(read("/sys/fs/cgroup/cgroup.subtree_control")) {
			have[c] = true
		}
		var missing []string
		for _, c := range cgroupControllers {
			if strings.Contains(" "+controllers+" ", " "+c+" ") && !have[c] {
				missing = append(missing, c)
			}
		}
		if len(missing) > 0 {
			out = append(out, doctorCheck{"warn", "delegation", "not delegated at the cgroup root (cgroup.subtree_control): " + strings.Join(missing, ", ") + "; systemd enables a controller once a unit asks for it, so this usually settles once bcd's slices exist"})
		} else {
			out = append(out, doctorCheck{"ok", "delegation", "the cgroup root delegates " + strings.Join(cgroupControllers, ", ")})
		}
	}

	// Virtualization: say why /dev/kvm is missing, the firmware or the module.
	if !exists("/dev/kvm") {
		flags := " " + read("/proc/cpuinfo") + " "
		switch {
		case strings.Contains(flags, " vmx ") || strings.Contains(flags, " svm "):
			out = append(out, doctorCheck{"warn", "kvm", "the CPU supports virtualization but /dev/kvm is missing: load kvm_intel or kvm_amd (modprobe), and check it is not blacklisted"})
		case strings.Contains(read("/proc/cpuinfo"), "hypervisor"):
			out = append(out, doctorCheck{"warn", "kvm", "this is a VM without nested virtualization: enable nested virtualization on its host to run instances here"})
		default:
			out = append(out, doctorCheck{"warn", "kvm", "no VT-x/AMD-V flags: enable virtualization in the firmware setup (Intel VT-x / AMD SVM)"})
		}
	}

	// GPU passthrough readiness: GPUs, an IOMMU, and the vfio-pci driver.
	if inv != nil && inv.Gpus != nil && len(inv.Gpus.Gpus) > 0 {
		iommu := len(listDir(filepath.Join(root, "sys", "class", "iommu"))) > 0
		vfio := exists("/sys/bus/pci/drivers/vfio-pci") || exists("/sys/module/vfio_pci")
		switch {
		case !iommu:
			// hostChecks already warns about the IOMMU itself.
		case !vfio:
			out = append(out, doctorCheck{"warn", "vfio", "the IOMMU is on but vfio-pci is not loaded: GPU passthrough loads it on first use (modprobe vfio-pci to check it is available)"})
		default:
			out = append(out, doctorCheck{"ok", "vfio", "vfio-pci loaded with an IOMMU: GPUs can be passed to instances"})
		}
	}

	// Clock: certificates, tickets and signed intents all compare times.
	if clock != nil {
		synced, detail, err := clock()
		switch {
		case err != nil:
			out = append(out, doctorCheck{"warn", "clock", "cannot tell whether the clock is synchronized: " + err.Error()})
		case synced:
			out = append(out, doctorCheck{"ok", "clock", detail})
		default:
			out = append(out, doctorCheck{"fail", "clock", detail + ": run an NTP client (systemd-timesyncd or chrony); certificates and signed intents compare times"})
		}
	}

	// What the inventory will be missing (the findings `bcd hardware` prints), except what other
	// checks report already.
	for _, f := range inventory.HostFindings(inv, privileged) {
		if f.Status == "ok" || f.Check == "kvm" || f.Check == "iommu" || f.Check == "cgroup" {
			continue
		}
		out = append(out, doctorCheck{f.Status, f.Check, f.Detail})
	}
	return out
}

func listDir(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// clockStatusDetail renders the kernel's estimate of the clock error.
func clockStatusDetail(synced bool, maxErrorMicros int64) string {
	if !synced {
		return "the kernel reports the clock unsynchronized"
	}
	return fmt.Sprintf("synchronized (estimated error %d µs)", maxErrorMicros)
}
