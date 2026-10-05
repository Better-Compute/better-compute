package inventory

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

var fixedNow = func() time.Time { return time.Unix(1_800_000_000, 0) }

// A capture replays as the same machine: every section hashes the same from the copy.
func TestCaptureReplaysTheSameInventory(t *testing.T) {
	src := fakeRoot(t)
	dst := t.TempDir()
	seen, err := Capture(dst, CaptureOptions{Src: src})
	if err != nil {
		t.Fatal(err)
	}
	want, _ := SectionHashes(seen)
	replayed, err := Collector{Root: dst, Hostname: func() string { return "gpu-01" }}.Collect()
	if err != nil {
		t.Fatal(err)
	}
	got, _ := SectionHashes(replayed)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("replayed hashes differ:\n got %v\nwant %v", got, want)
	}
	// The disk's transport and the NIC's driver come from symlinks: they survived.
	if replayed.Disks.Disks[0].Transport != DiskTransport_DISK_TRANSPORT_NVME || replayed.Nics.Nics[0].Driver != "mlx5_core" {
		t.Fatalf("links lost: %+v %+v", replayed.Disks.Disks[0], replayed.Nics.Nics[0])
	}
}

// Redacted, the machine keeps its shape and loses its identifiers, the same way every time.
func TestCaptureRedactsIdentifiers(t *testing.T) {
	src := fakeRoot(t)
	collect := func() *NodeInventory {
		dst := t.TempDir()
		if _, err := Capture(dst, CaptureOptions{Src: src, Redact: true}); err != nil {
			t.Fatal(err)
		}
		inv, err := Collector{Root: dst, Now: fixedNow}.Collect()
		if err != nil {
			t.Fatal(err)
		}
		return inv
	}
	a, b := collect(), collect()
	if !reflect.DeepEqual(mustHashes(t, a), mustHashes(t, b)) {
		t.Fatal("redaction is not deterministic")
	}
	if a.System.Serial == "S123" || a.System.BoardSerial == "B456" || a.System.ProductUuid == "4c4c4544-0000-1000-8000-abcdef012345" {
		t.Fatalf("system identifiers kept: %+v", a.System)
	}
	if len(a.System.ProductUuid) != 36 || a.System.Vendor != "Supermicro" || a.System.Product != "SYS-821GE-TNHR" {
		t.Fatalf("system shape lost: %+v", a.System)
	}
	if nic := a.Nics.Nics[0]; nic.Mac == "b8:3f:d2:00:00:01" || !strings.HasPrefix(nic.Mac, "02:") || len(nic.Mac) != 17 {
		t.Fatalf("mac = %q", nic.Mac)
	}
	if d := a.Disks.Disks[0]; d.Serial == "S64HNE0T" || !strings.HasPrefix(d.Wwn, "eui.") || d.Wwn == "eui.0025388b91c3a1b2" {
		t.Fatalf("disk = %+v", d)
	}
	for _, g := range a.Gpus.Gpus {
		if g.Uuid == "GPU-aaaa" || g.Uuid == "GPU-bbbb" || g.Name != "NVIDIA H100 80GB HBM3" {
			t.Fatalf("gpu = %+v", g)
		}
	}
	if a.Os.Hostname == "gpu-01" || !strings.HasPrefix(a.Os.Hostname, "host-") {
		t.Fatalf("hostname = %q", a.Os.Hostname)
	}
}

func TestPlaceholderDMIValuesStay(t *testing.T) {
	if redactValue("sys/class/dmi/id/product_serial", "S123") == "S123" {
		t.Fatal("serial kept")
	}
	if !placeholders["to be filled by o.e.m."] {
		t.Fatal("placeholder list")
	}
}

func TestGPUsHookFillsAnEmptyGPUSection(t *testing.T) {
	hook := &GpusSection{DriverVersion: "580.88", Gpus: []*Gpu{{Uuid: "GPU-wsl", PciBusId: "00000000:F1:00.0", Name: "NVIDIA GeForce RTX 5090"}}}
	inv, err := Collector{Root: t.TempDir(), Hostname: func() string { return "h" }, GPUs: func() *GpusSection { return hook }}.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if inv.Gpus == nil || len(inv.Gpus.Gpus) != 1 || inv.Gpus.Gpus[0].Uuid != "GPU-wsl" {
		t.Fatalf("gpus = %+v", inv.Gpus)
	}
	// procfs GPUs win: the hook is a fallback, never a second source.
	called := false
	inv, err = Collector{Root: fakeRoot(t), GPUs: func() *GpusSection { called = true; return hook }}.Collect()
	if err != nil || called || len(inv.Gpus.Gpus) != 2 {
		t.Fatalf("hook consulted with procfs GPUs present: %v %v", called, err)
	}
}

func mustHashes(t *testing.T, inv *NodeInventory) map[string]string {
	t.Helper()
	h, err := SectionHashes(inv)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for k, v := range h {
		out[k] = string(v)
	}
	return out
}
