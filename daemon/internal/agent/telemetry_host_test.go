package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/runtime"
	"github.com/better-compute/better-compute/daemon/internal/telemetry"
)

// The OTLP export carries the host's memory and hugepage pools and the instances its runtimes hold.
func TestHostAndInstanceMetrics(t *testing.T) {
	var fake *runtime.Fake
	h := newHarness(t, func(o *Options) {
		fake = &runtime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}
		o.Runtimes = []runtime.Runtime{fake}
	})
	write := func(abs, content string) {
		p := h.host.Path(abs)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("/proc/meminfo", "MemTotal:       2113536000 kB\nMemFree:        1000 kB\nMemAvailable:   1048576000 kB\n")
	write("/sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages", "64\n")
	write("/sys/kernel/mm/hugepages/hugepages-1048576kB/free_hugepages", "48\n")
	write("/sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages", "0\n")
	write("/sys/kernel/mm/hugepages/hugepages-2048kB/free_hugepages", "0\n")
	_ = fake.Leak("foreign-vm", runtime.StateRunning)

	byName := map[string]telemetry.Metric{}
	for _, m := range h.agent.metrics(context.Background()) {
		byName[m.Name] = m
	}
	value := func(name string, attrs map[string]string) int64 {
		t.Helper()
		m, ok := byName[name]
		if !ok {
			t.Fatalf("no %s in %v", name, byName)
		}
	points:
		for _, p := range m.Points {
			for k, v := range attrs {
				if p.Attrs[k] != v {
					continue points
				}
			}
			return *p.Int
		}
		t.Fatalf("%s has no point %v: %+v", name, attrs, m.Points)
		return 0
	}
	if value("bcd.host.memory.total", nil) != 2113536000*1024 || value("bcd.host.memory.available", nil) != 1048576000*1024 {
		t.Fatal("host memory")
	}
	if value("bcd.host.hugepages.total", map[string]string{"page.size": "1073741824"}) != 64 ||
		value("bcd.host.hugepages.free", map[string]string{"page.size": "1073741824"}) != 48 ||
		value("bcd.host.hugepages.total", map[string]string{"page.size": "2097152"}) != 0 {
		t.Fatal("hugepages")
	}
	if value("bcd.instances", map[string]string{"runtime": "libvirt-kvm", "state": runtime.StateRunning}) != 1 {
		t.Fatal("instances")
	}
	if _, ok := byName["bcd.instance.memory"]; !ok {
		t.Fatal("no bcd.instance.memory")
	}
	if value("bcd.instance.vcpu", map[string]string{"instance.id": "foreign-vm", "managed": "false"}) < 0 {
		t.Fatal("vcpu")
	}
	// The fake reports usage for running domains (runtime.UsageReader).
	if _, ok := byName["bcd.instance.memory.used"]; !ok {
		t.Fatalf("no bcd.instance.memory.used in %v", byName)
	}
	if m := byName["bcd.instance.cpu.time"]; !m.Sum || len(m.Points) != 1 || m.Points[0].Attrs["instance.id"] != "foreign-vm" {
		t.Fatalf("cpu time = %+v", m)
	}
}
