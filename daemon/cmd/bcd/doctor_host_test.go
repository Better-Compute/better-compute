package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

func preflightTree(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for p, content := range files {
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if strings.HasSuffix(p, "/") {
			if err := os.MkdirAll(full, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func byCheck(checks []doctorCheck) map[string]doctorCheck {
	out := map[string]doctorCheck{}
	for _, c := range checks {
		out[c.check] = c
	}
	return out
}

func synced() (bool, string, error) { return true, "synchronized (estimated error 12 µs)", nil }

// A ready GPU host: systemd, cgroup v2 with every controller delegated, KVM, an IOMMU and vfio-pci.
func TestHostPreflightReadyHost(t *testing.T) {
	root := preflightTree(t, map[string]string{
		"/run/systemd/system/":              "",
		"/sys/fs/cgroup/cgroup.controllers": "cpuset cpu io memory hugetlb pids rdma misc\n",
		"/sys/fs/cgroup/cgroup.subtree_control": "cpuset cpu io memory hugetlb pids\n",
		"/dev/kvm":                          "",
		"/sys/class/iommu/dmar0/":           "",
		"/sys/bus/pci/drivers/vfio-pci/":    "",
	})
	inv := &inventory.NodeInventory{
		System: &inventory.SystemSection{Vendor: "Supermicro", Product: "SYS-821GE", ProductUuid: "4c4c4544-0000-1000-8000-abcdef012345"},
		Cpu:    &inventory.CpuSection{Model: "Xeon", Sockets: 2, Cores: 112, Threads: 224, NumaNodes: []*inventory.NumaNode{{Id: 0}, {Id: 1}}},
		Memory: &inventory.MemorySection{TotalBytes: 2 << 40},
		Disks:  &inventory.DisksSection{Disks: []*inventory.Disk{{Name: "nvme0n1"}}},
		Nics:   &inventory.NicsSection{Nics: []*inventory.Nic{{Name: "eth0", Link: inventory.LinkState_LINK_STATE_UP}}},
		Gpus:   &inventory.GpusSection{DriverVersion: "580.65.06", Gpus: []*inventory.Gpu{{Uuid: "GPU-a"}}},
		Os:     &inventory.OsSection{Cgroup: inventory.CgroupVersion_CGROUP_VERSION_V2, Kvm: true, Iommu: true},
	}
	pciGroup(t, root, "12", map[string]string{"0000:3a:00.0": "0x060400", "0000:3b:00.0": "0x030200", "0000:3b:00.1": "0x040300"})
	for _, c := range hostPreflight(root, inv, true, synced) {
		if c.status != "ok" {
			t.Fatalf("a ready host got %s %s: %s", c.status, c.check, c.detail)
		}
	}
	checks := byCheck(hostPreflight(root, inv, true, synced))
	for _, want := range []string{"systemd", "delegation", "vfio", "iommu-groups", "clock"} {
		if checks[want].status != "ok" {
			t.Fatalf("%s = %+v", want, checks[want])
		}
	}
}

// pciGroup puts PCI devices (address → class; NVIDIA for display classes) in one IOMMU group ("" no
// group) of a fake sysfs.
func pciGroup(t *testing.T, root, group string, devices map[string]string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake sysfs needs symlinks")
	}
	groupDir := filepath.Join(root, "sys", "kernel", "iommu_groups", group, "devices")
	for addr, class := range devices {
		dev := filepath.Join(root, "sys", "bus", "pci", "devices", addr)
		vendor := "0x15b3"
		if strings.HasPrefix(class, "0x03") || strings.HasPrefix(class, "0x04") {
			vendor = "0x10de"
		}
		for name, v := range map[string]string{"class": class, "vendor": vendor} {
			if err := os.MkdirAll(dev, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dev, name), []byte(v+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if group == "" {
			continue
		}
		if err := os.MkdirAll(groupDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(dev, filepath.Join(groupDir, addr)); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Dir(groupDir), filepath.Join(dev, "iommu_group")); err != nil {
			t.Fatal(err)
		}
	}
}

// A GPU sharing its IOMMU group with a NIC (a slot behind a switch without ACS) cannot be passed
// through; neither can one the IOMMU does not cover.
func TestHostPreflightIOMMUGroups(t *testing.T) {
	files := map[string]string{"/sys/class/iommu/dmar0/": "", "/sys/bus/pci/drivers/vfio-pci/": ""}
	inv := &inventory.NodeInventory{Gpus: &inventory.GpusSection{Gpus: []*inventory.Gpu{{Uuid: "GPU-a"}, {Uuid: "GPU-b"}}}}

	root := preflightTree(t, files)
	pciGroup(t, root, "12", map[string]string{"0000:3b:00.0": "0x030200", "0000:3b:00.1": "0x040300"})
	pciGroup(t, root, "20", map[string]string{"0000:5e:00.0": "0x030200", "0000:5d:00.0": "0x060400", "0000:5f:00.0": "0x020000", "0000:5f:00.1": "0x020000"})
	c := byCheck(hostPreflight(root, inv, true, nil))["iommu-groups"]
	if c.status != "warn" || !strings.Contains(c.detail, "0000:5e:00.0 (group 20) with 0000:5f:00.0, 0000:5f:00.1") || strings.Contains(c.detail, "3b") ||
		strings.Contains(c.detail, "5d:00.0") {
		t.Fatalf("shared group = %+v", c)
	}

	root = preflightTree(t, files)
	pciGroup(t, root, "", map[string]string{"0000:3b:00.0": "0x030200"})
	if c := byCheck(hostPreflight(root, inv, true, nil))["iommu-groups"]; c.status != "warn" || !strings.Contains(c.detail, "1 of 1 GPUs have no IOMMU group") {
		t.Fatalf("ungrouped = %+v", c)
	}

	// No NVIDIA function on the PCI bus (a paravirtual GPU): said, not hidden.
	if c := byCheck(hostPreflight(preflightTree(t, files), inv, true, nil))["iommu-groups"]; c.status != "warn" || !strings.Contains(c.detail, "no NVIDIA GPU") {
		t.Fatalf("no PCI GPU = %+v", c)
	}
	// No IOMMU: the iommu finding says it; no group check.
	if _, ok := byCheck(hostPreflight(t.TempDir(), inv, true, nil))["iommu-groups"]; ok {
		t.Fatal("group check without an IOMMU")
	}
}

// What a fresh server usually needs: no systemd (a container), cgroup v1, KVM off in firmware, an
// unsynced clock, root-only DMI read unprivileged.
func TestHostPreflightFindsTheUsualProblems(t *testing.T) {
	root := preflightTree(t, map[string]string{
		"/proc/cpuinfo": "processor\t: 0\nflags\t\t: fpu sse2 avx2\n\n",
	})
	inv := &inventory.NodeInventory{
		System: &inventory.SystemSection{Vendor: "Dell Inc.", Product: "PowerEdge R760"},
		Cpu:    &inventory.CpuSection{Model: "Xeon", Sockets: 1, Cores: 32, Threads: 64},
		Memory: &inventory.MemorySection{TotalBytes: 256 << 30},
		Os:     &inventory.OsSection{Cgroup: inventory.CgroupVersion_CGROUP_VERSION_V1},
	}
	unsynced := func() (bool, string, error) { return false, "the kernel reports the clock unsynchronized", nil }
	checks := byCheck(hostPreflight(root, inv, false, unsynced))
	expect := map[string]string{"systemd": "fail", "kvm": "warn", "clock": "fail", "dmi": "warn", "nics": "warn", "disks": "warn", "numa": "warn"}
	for check, status := range expect {
		if checks[check].status != status {
			t.Fatalf("%s = %+v, want %s", check, checks[check], status)
		}
	}
	if !strings.Contains(checks["kvm"].detail, "firmware") {
		t.Fatalf("kvm advice = %q", checks["kvm"].detail)
	}
	if !strings.Contains(checks["dmi"].detail, "root-only") {
		t.Fatalf("dmi advice = %q", checks["dmi"].detail)
	}
}

func TestHostPreflightKVMAdvice(t *testing.T) {
	module := byCheck(hostPreflight(preflightTree(t, map[string]string{"/proc/cpuinfo": "flags\t: fpu vmx ept\n"}), nil, true, nil))
	if !strings.Contains(module["kvm"].detail, "kvm_intel") {
		t.Fatalf("vmx without /dev/kvm: %+v", module["kvm"])
	}
	nested := byCheck(hostPreflight(preflightTree(t, map[string]string{"/proc/cpuinfo": "flags\t: fpu hypervisor\n"}), nil, true, nil))
	if !strings.Contains(nested["kvm"].detail, "nested") {
		t.Fatalf("a VM: %+v", nested["kvm"])
	}
	broken := byCheck(hostPreflight(t.TempDir(), nil, true, func() (bool, string, error) { return false, "", errors.New("no adjtimex") }))
	if broken["clock"].status != "warn" {
		t.Fatalf("clock = %+v", broken["clock"])
	}
}

func TestHostPreflightCgroupControllers(t *testing.T) {
	notDelegated := byCheck(hostPreflight(preflightTree(t, map[string]string{
		"/sys/fs/cgroup/cgroup.controllers":     "cpuset cpu io memory hugetlb pids\n",
		"/sys/fs/cgroup/cgroup.subtree_control": "cpu memory pids\n",
	}), nil, true, nil))
	if c := notDelegated["delegation"]; c.status != "warn" || !strings.Contains(c.detail, "cpuset, io, hugetlb") {
		t.Fatalf("delegation = %+v", c)
	}
	// A controller the kernel lacks is the "cgroups" resource check's to report, not this one's.
	noHugetlb := byCheck(hostPreflight(preflightTree(t, map[string]string{
		"/sys/fs/cgroup/cgroup.controllers":     "cpuset cpu io memory pids\n",
		"/sys/fs/cgroup/cgroup.subtree_control": "cpuset cpu io memory pids\n",
	}), nil, true, nil))
	if c := noHugetlb["delegation"]; c.status != "ok" {
		t.Fatalf("delegation = %+v", c)
	}
	if _, ok := byCheck(hostPreflight(t.TempDir(), nil, true, nil))["delegation"]; ok {
		t.Fatal("delegation reported without cgroup v2")
	}
}
