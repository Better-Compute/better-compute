package inventory

import (
	"fmt"
	"sort"
	"strings"
)

// Finding is one bring-up observation about what the collector saw on a real host: something that
// will make the control plane's view of the machine weaker or wrong (a missing identifier, a kernel
// feature bcd relies on). `bcd hardware` and `bcd doctor` print them.
type Finding struct {
	// Status is "ok", "warn" or "fail".
	Status string
	// Check is a short name ("dmi", "cgroup", ...).
	Check  string
	Detail string
}

// placeholderUUIDs are product UUIDs boards ship unset; the control plane does not trust them as
// identity, so the hardware key falls back to other identifiers.
var placeholderUUIDs = map[string]bool{
	"00000000-0000-0000-0000-000000000000": true,
	"ffffffff-ffff-ffff-ffff-ffffffffffff": true,
	"03000200-0400-0500-0006-000700080009": true, // common on boards with an unprogrammed SMBIOS
	"00020003-0004-0005-0006-000700080009": true,
}

// IsPlaceholderUUID reports a product UUID that identifies nothing.
func IsPlaceholderUUID(u string) bool { return placeholderUUIDs[strings.ToLower(u)] }

// IsPlaceholderDMI reports a DMI string vendors leave unset.
func IsPlaceholderDMI(s string) bool { return placeholders[strings.ToLower(strings.TrimSpace(s))] }

// HostFindings reviews an inventory collected on this host. privileged says whether the collector ran
// as root: DMI serials and the product UUID are mode 0400 in sysfs, so an unprivileged read leaves
// them empty rather than failing.
func HostFindings(inv *NodeInventory, privileged bool) []Finding {
	var out []Finding
	add := func(status, check, format string, args ...any) {
		out = append(out, Finding{Status: status, Check: check, Detail: fmt.Sprintf(format, args...)})
	}
	if inv == nil {
		return []Finding{{Status: "fail", Check: "inventory", Detail: "nothing collected"}}
	}

	switch s := inv.System; {
	case s == nil:
		add("warn", "dmi", "no DMI/SMBIOS data (/sys/class/dmi/id): a container or a VM without SMBIOS; the node is identified by MACs only")
	case s.ProductUuid == "" && s.Serial == "" && !privileged:
		add("warn", "dmi", "the product UUID and serials are root-only in sysfs and read empty here; run as root (bcd join, bcd helper) to see them")
	case s.ProductUuid == "":
		add("warn", "dmi", "no product UUID: the hardware key leans on serials and MACs")
	case IsPlaceholderUUID(s.ProductUuid):
		add("warn", "dmi", "the product UUID %s is a placeholder the vendor never set: the hardware key falls back to serials and MACs, and a reclaim needs `expect` or approval", s.ProductUuid)
	case s.Serial != "" && IsPlaceholderDMI(s.Serial):
		add("warn", "dmi", "the system serial is a placeholder (%q)", s.Serial)
	default:
		add("ok", "dmi", "%s %s, UUID %s", s.Vendor, s.Product, s.ProductUuid)
	}

	if c := inv.Cpu; c == nil {
		add("fail", "cpu", "/proc/cpuinfo unreadable")
	} else {
		model := c.Model
		if model == "" {
			model = "(no model name)"
		}
		add("ok", "cpu", "%s, %d sockets, %d cores, %d threads, %d NUMA nodes", model, c.Sockets, c.Cores, c.Threads, len(c.NumaNodes))
		if len(c.NumaNodes) == 0 {
			add("warn", "numa", "no /sys/devices/system/node: NUMA-pinned placements cannot be honoured")
		}
	}

	if m := inv.Memory; m == nil {
		add("fail", "memory", "/proc/meminfo unreadable")
	} else {
		pages := []string{}
		for _, p := range m.Hugepages {
			if p.Total > 0 {
				pages = append(pages, fmt.Sprintf("%d×%s", p.Total, humanBytes(p.PageSizeBytes)))
			}
		}
		detail := humanBytes(m.TotalBytes)
		if len(pages) > 0 {
			detail += ", hugepages " + strings.Join(pages, " ")
		}
		if m.Edac != nil && m.Edac.Uncorrectable > 0 {
			add("warn", "memory", "%s; EDAC reports %d uncorrectable errors", detail, m.Edac.Uncorrectable)
		} else {
			add("ok", "memory", "%s", detail)
		}
		// DIMMs come from SMBIOS (root-only) or EDAC; a machine without SMBIOS (a VM) has neither.
		switch {
		case len(m.Dimms) > 0:
			var total uint64
			ecc, types := 0, map[string]bool{}
			for _, d := range m.Dimms {
				total += d.SizeBytes
				if d.Ecc {
					ecc++
				}
				if d.Type != "" {
					types[d.Type] = true
				}
			}
			kinds := make([]string, 0, len(types))
			for t := range types {
				kinds = append(kinds, t)
			}
			sort.Strings(kinds)
			summary := fmt.Sprintf("%d DIMMs, %s %s", len(m.Dimms), humanBytes(total), strings.Join(kinds, "/"))
			if ecc > 0 && ecc < len(m.Dimms) {
				add("warn", "dimms", "%s; only %d of them ECC: the non-ECC modules leave memory errors uncorrected", summary, ecc)
			} else if ecc > 0 {
				add("ok", "dimms", "%s, ECC", summary)
			} else {
				add("ok", "dimms", "%s, no ECC", summary)
			}
		case inv.System != nil && privileged:
			add("warn", "dimms", "the SMBIOS table lists no memory devices (/sys/firmware/dmi/entries/17-*): the DIMM layout is unknown")
		}
	}

	if d := inv.Disks; d == nil || len(d.Disks) == 0 {
		add("warn", "disks", "no physical disks under /sys/block (virtio and USB count; loop, dm and md do not)")
	} else {
		add("ok", "disks", "%d disks", len(d.Disks))
	}

	if n := inv.Nics; n == nil || len(n.Nics) == 0 {
		add("warn", "nics", "no physical NICs under /sys/class/net: the node has no MAC identity and no PXE MAC for metal")
	} else {
		up := 0
		for _, nic := range n.Nics {
			if nic.Link == LinkState_LINK_STATE_UP {
				up++
			}
		}
		add("ok", "nics", "%d physical NICs, %d up", len(n.Nics), up)
	}

	if g := inv.Gpus; g != nil && len(g.Gpus) > 0 {
		add("ok", "gpus", "%d NVIDIA GPUs, driver %s", len(g.Gpus), g.DriverVersion)
	}

	if o := inv.Os; o != nil {
		if o.Cgroup != CgroupVersion_CGROUP_VERSION_V2 {
			add("fail", "cgroup", "cgroup v2 (unified) is not mounted at /sys/fs/cgroup: bcd's hold slices and instance limits need it (boot with systemd.unified_cgroup_hierarchy=1)")
		} else {
			add("ok", "cgroup", "cgroup v2")
		}
		if o.Kvm {
			add("ok", "kvm", "/dev/kvm present")
		} else {
			add("warn", "kvm", "no /dev/kvm: this host runs no VMs (enable VT-x/AMD-V in firmware, load kvm_intel or kvm_amd)")
		}
		if !o.Iommu && inv.Gpus != nil && len(inv.Gpus.Gpus) > 0 {
			add("warn", "iommu", "GPUs without an IOMMU: no GPU passthrough to VMs (intel_iommu=on or amd_iommu=on, and VT-d/AMD-Vi in firmware)")
		}
	}
	return out
}

func humanBytes(b uint64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := uint64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(b)/float64(div), "KMGTPE"[exp])
}
