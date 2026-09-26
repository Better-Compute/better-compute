package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
