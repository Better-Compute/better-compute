package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/config"
)

// resourceChecks: what enforcing PLAN.md §3.8 needs from the host (root prefixes /sys; tests point it
// at a fake tree):
//   - cgroup v2 with the cpuset, cpu and memory controllers, for hold slices; hugetlb for their
//     hugepage limits;
//   - the hugepage pools, which hugepage-backed instances and holds draw from;
//   - vfio-pci, which GPU passthrough rebinds devices to;
//   - systemd ≥ 247 for cloud-hypervisor's confined units (their AllowedCPUs and bind mounts).
func resourceChecks(root string, systemd int, cloudHypervisor bool) []doctorCheck {
	var out []doctorCheck
	path := func(p string) string { return filepath.Join(root, p) }
	if raw, err := os.ReadFile(path("sys/fs/cgroup/cgroup.controllers")); err != nil {
		out = append(out, doctorCheck{"fail", "cgroups", "no cgroup v2 (/sys/fs/cgroup/cgroup.controllers): holds with limits cannot be confined"})
	} else {
		have := map[string]bool{}
		for _, c := range strings.Fields(string(raw)) {
			have[c] = true
		}
		var missing []string
		for _, c := range []string{"cpuset", "cpu", "memory"} {
			if !have[c] {
				missing = append(missing, c)
			}
		}
		switch {
		case len(missing) > 0:
			out = append(out, doctorCheck{"fail", "cgroups", "cgroup v2 lacks " + strings.Join(missing, ", ") + ": holds with limits cannot be confined"})
		case !have["hugetlb"]:
			out = append(out, doctorCheck{"warn", "cgroups", "cgroup v2 has no hugetlb controller: a hold's hugepage limits are not enforced"})
		default:
			out = append(out, doctorCheck{"ok", "cgroups", "cgroup v2 with cpuset, cpu, memory and hugetlb"})
		}
	}
	var pools []string
	for _, size := range []string{"2048kB", "1048576kB"} {
		dir := path("sys/kernel/mm/hugepages/hugepages-" + size)
		total, err1 := readCount(filepath.Join(dir, "nr_hugepages"))
		free, err2 := readCount(filepath.Join(dir, "free_hugepages"))
		if err1 != nil || err2 != nil || total == 0 {
			continue
		}
		label := "2 MiB"
		if size == "1048576kB" {
			label = "1 GiB"
		}
		pools = append(pools, fmt.Sprintf("%d of %d %s pages free", free, total, label))
	}
	if len(pools) > 0 {
		out = append(out, doctorCheck{"ok", "hugepages", strings.Join(pools, "; ")})
	} else {
		out = append(out, doctorCheck{"ok", "hugepages", "no hugepage pool: hugepage-backed flavors and hugepage limits are refused here"})
	}
	if entries, err := os.ReadDir(path("sys/class/iommu")); err == nil && len(entries) > 0 {
		if _, err := os.Stat(path("sys/bus/pci/drivers/vfio-pci")); err != nil {
			out = append(out, doctorCheck{"warn", "vfio", "vfio-pci is not loaded (modprobe vfio-pci): GPU passthrough cannot rebind devices"})
		} else {
			out = append(out, doctorCheck{"ok", "vfio", "vfio-pci loaded"})
		}
	}
	if cloudHypervisor {
		switch {
		case systemd == 0:
			out = append(out, doctorCheck{"warn", "systemd", "systemd's version is unknown: cloud-hypervisor's confined units need systemd 247 or newer"})
		case systemd < 247:
			out = append(out, doctorCheck{"fail", "systemd", fmt.Sprintf("systemd %d: cloud-hypervisor's confined units need 247 or newer", systemd)})
		default:
			out = append(out, doctorCheck{"ok", "systemd", fmt.Sprintf("systemd %d", systemd)})
		}
	}
	return out
}

func readCount(path string) (uint64, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 64)
}

var systemdVersionLine = regexp.MustCompile(`^systemd (\d+)`)

// systemdVersion is `systemctl --version`'s, or 0 when it cannot be read.
func systemdVersion() int {
	out, err := exec.Command("systemctl", "--version").Output()
	if err != nil {
		return 0
	}
	if m := systemdVersionLine.FindSubmatch(out); m != nil {
		n, _ := strconv.Atoi(string(m[1]))
		return n
	}
	return 0
}

// libvirtHost is what helperRuntimeChecks reads of a libvirt host (tests replace it).
type libvirtHost struct {
	// inGroup reports whether the user belongs to the group (errors: unknown user or group).
	inGroup func(user, group string) (bool, error)
	// primaryGroup is a user's primary group's name.
	primaryGroup func(user string) (string, error)
	// qemuConf is /etc/libvirt/qemu.conf.
	qemuConf func() ([]byte, error)
	// userExists reports a local user.
	userExists func(name string) bool
}

var dynamicOwnershipOff = regexp.MustCompile(`(?m)^\s*dynamic_ownership\s*=\s*0\s*$`)

// helperRuntimeChecks: under [helper] bcd node is unprivileged. libvirt-kvm goes through the helper
// (root validates every definition), so the node's user must NOT be in the root-equivalent libvirt
// group; libvirt must not relabel files (dynamic_ownership = 0), and QEMU's user reaches the node's
// files through the node's group. cloud-hypervisor is not offered.
func helperRuntimeChecks(cfg *config.Config, lookPath func(string) (string, error), host libvirtHost) []doctorCheck {
	if cfg.Helper.Socket == "" || cfg.Helper.User == "" {
		return nil
	}
	var out []doctorCheck
	if _, err := lookPath("virsh"); err == nil {
		node := cfg.Helper.User
		switch in, err := host.inGroup(node, "libvirt"); {
		case err != nil && !strings.Contains(err.Error(), "unknown group"):
			out = append(out, doctorCheck{"fail", "libvirt", err.Error()})
		case in:
			out = append(out, doctorCheck{"fail", "libvirt", node + " is in the libvirt group, which is root-equivalent: under [helper] libvirt goes through the helper, so remove it (gpasswd -d " + node + " libvirt)"})
		default:
			out = append(out, doctorCheck{"ok", "libvirt", "libvirt goes through bcd helper; " + node + " reads its read-only socket only"})
		}
		if conf, err := host.qemuConf(); err != nil || !dynamicOwnershipOff.Match(conf) {
			out = append(out, doctorCheck{"fail", "libvirt", "/etc/libvirt/qemu.conf lacks dynamic_ownership = 0: libvirt would chown the node's files, which the node could race to a root file"})
		}
		qemu := ""
		for _, name := range []string{"libvirt-qemu", "qemu"} {
			if host.userExists(name) {
				qemu = name
				break
			}
		}
		group, gerr := host.primaryGroup(node)
		switch {
		case qemu == "":
			out = append(out, doctorCheck{"warn", "libvirt", "no libvirt-qemu or qemu user: QEMU's user is unknown"})
		case gerr != nil:
			out = append(out, doctorCheck{"fail", "libvirt", gerr.Error()})
		default:
			if in, err := host.inGroup(qemu, group); err != nil || !in {
				out = append(out, doctorCheck{"fail", "libvirt", qemu + " is not in group " + group + ": QEMU cannot open the node's disks (usermod -aG " + group + " " + qemu + ")"})
			}
		}
	}
	if _, err := lookPath("cloud-hypervisor"); err == nil {
		out = append(out, doctorCheck{"warn", "cloud-hypervisor", "not offered under [helper]: its VMMs need bcd node to run as root"})
	}
	return out
}

// userInGroup reports whether the named user is a member of the named group.
func userInGroup(name, group string) (bool, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return false, err
	}
	g, err := user.LookupGroup(group)
	if err != nil {
		return false, err
	}
	gids, err := u.GroupIds()
	if err != nil {
		return false, err
	}
	return slices.Contains(gids, g.Gid) || u.Gid == g.Gid, nil
}

// realLibvirtHost reads this host.
var realLibvirtHost = libvirtHost{
	inGroup: userInGroup,
	primaryGroup: func(name string) (string, error) {
		u, err := user.Lookup(name)
		if err != nil {
			return "", err
		}
		g, err := user.LookupGroupId(u.Gid)
		if err != nil {
			return "", err
		}
		return g.Name, nil
	},
	qemuConf:   func() ([]byte, error) { return os.ReadFile("/etc/libvirt/qemu.conf") },
	userExists: func(name string) bool { _, err := user.Lookup(name); return err == nil },
}

// hostResourceChecks runs resourceChecks against this host.
func hostResourceChecks() []doctorCheck {
	_, err := exec.LookPath("cloud-hypervisor")
	return resourceChecks("/", systemdVersion(), err == nil)
}
