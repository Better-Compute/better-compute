package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/config"
)

func TestResourceChecks(t *testing.T) {
	root := t.TempDir()
	write := func(p, content string) {
		t.Helper()
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	find := func(checks []doctorCheck, name string) doctorCheck {
		for _, c := range checks {
			if c.check == name {
				return c
			}
		}
		return doctorCheck{}
	}

	// Nothing there: no cgroup v2 fails; no pools is fine; no IOMMU says nothing about vfio.
	bare := resourceChecks(root, 252, false)
	if c := find(bare, "cgroups"); c.status != "fail" {
		t.Fatalf("cgroups = %+v", c)
	}
	if c := find(bare, "hugepages"); c.status != "ok" || !strings.Contains(c.detail, "no hugepage pool") {
		t.Fatalf("hugepages = %+v", c)
	}
	if c := find(bare, "vfio"); c.check != "" {
		t.Fatalf("vfio without an IOMMU: %+v", c)
	}

	write("sys/fs/cgroup/cgroup.controllers", "cpuset cpu io memory pids\n")
	write("sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages", "64\n")
	write("sys/kernel/mm/hugepages/hugepages-1048576kB/free_hugepages", "60\n")
	write("sys/class/iommu/dmar0/.keep", "")
	checks := resourceChecks(root, 245, true)
	if c := find(checks, "cgroups"); c.status != "warn" || !strings.Contains(c.detail, "hugetlb") {
		t.Fatalf("cgroups = %+v", c)
	}
	if c := find(checks, "hugepages"); c.detail != "60 of 64 1 GiB pages free" {
		t.Fatalf("hugepages = %+v", c)
	}
	if c := find(checks, "vfio"); c.status != "warn" {
		t.Fatalf("vfio = %+v", c)
	}
	if c := find(checks, "systemd"); c.status != "fail" {
		t.Fatalf("systemd = %+v", c)
	}

	write("sys/fs/cgroup/cgroup.controllers", "cpuset cpu io memory hugetlb pids\n")
	write("sys/bus/pci/drivers/vfio-pci/bind", "")
	for _, c := range resourceChecks(root, 252, true) {
		if c.status != "ok" {
			t.Errorf("%+v", c)
		}
	}
}

func TestHelperRuntimeChecks(t *testing.T) {
	cfg := &config.Config{}
	both := func(string) (string, error) { return "/usr/bin/x", nil }
	groups := map[string]bool{} // "user:group"
	host := libvirtHost{
		inGroup:      func(u, g string) (bool, error) { return groups[u+":"+g], nil },
		primaryGroup: func(string) (string, error) { return "bcd", nil },
		qemuConf:     func() ([]byte, error) { return []byte("# user = \"qemu\"\ndynamic_ownership = 0\n"), nil },
		userExists:   func(name string) bool { return name == "libvirt-qemu" },
	}
	if got := helperRuntimeChecks(cfg, both, host); got != nil {
		t.Fatalf("without [helper]: %v", got)
	}
	cfg.Helper.Socket, cfg.Helper.User = "/run/bcd/helper.sock", "bcd"
	statuses := func(got []doctorCheck) string {
		var s []string
		for _, c := range got {
			s = append(s, c.check+":"+c.status)
		}
		return strings.Join(s, " ")
	}
	// Set up as the installer does: QEMU in the node's group, no relabelling, the node not in libvirt.
	groups["libvirt-qemu:bcd"] = true
	if got := statuses(helperRuntimeChecks(cfg, both, host)); got != "libvirt:ok cloud-hypervisor:warn" {
		t.Fatalf("set up: %s", got)
	}
	// The root-equivalent group, relabelling on, QEMU outside the node's group: each fails.
	groups["bcd:libvirt"], groups["libvirt-qemu:bcd"] = true, false
	host.qemuConf = func() ([]byte, error) { return []byte("#dynamic_ownership = 0\n"), nil }
	got := helperRuntimeChecks(cfg, both, host)
	if statuses(got) != "libvirt:fail libvirt:fail libvirt:fail cloud-hypervisor:warn" ||
		!strings.Contains(got[0].detail, "root-equivalent") || !strings.Contains(got[1].detail, "dynamic_ownership") || !strings.Contains(got[2].detail, "usermod") {
		t.Fatalf("misconfigured: %v", got)
	}
}
