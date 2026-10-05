package inventory

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func healthPage(critical, used byte, media uint64) []byte {
	p := make([]byte, 512)
	p[0], p[5] = critical, used
	binary.LittleEndian.PutUint64(p[160:], media)
	return p
}

func TestParseNVMeHealth(t *testing.T) {
	s := parseNVMeHealth(healthPage(0, 3, 0))
	if s == nil || !s.Healthy || *s.WearPercent != 3 || *s.MediaErrors != 0 {
		t.Fatalf("new drive = %+v", s)
	}
	// Temperature alone is transient; spare, reliability and read-only are not.
	if s := parseNVMeHealth(healthPage(0x02, 3, 0)); !s.Healthy {
		t.Fatal("a hot drive read unhealthy")
	}
	for _, bit := range []byte{0x01, 0x04, 0x08, 0x10, 0x20} {
		if s := parseNVMeHealth(healthPage(bit|0x02, 3, 0)); s.Healthy {
			t.Fatalf("critical warning %#x read healthy", bit)
		}
	}
	if s := parseNVMeHealth(healthPage(0, 255, 42)); *s.WearPercent != 255 || *s.MediaErrors != 42 {
		t.Fatalf("worn = %+v", s)
	}
	huge := healthPage(0, 0, 1)
	huge[168] = 1
	if s := parseNVMeHealth(huge); *s.MediaErrors != ^uint64(0) {
		t.Fatalf("128-bit count = %d", *s.MediaErrors)
	}
	if parseNVMeHealth(make([]byte, 100)) != nil {
		t.Fatal("short page parsed")
	}
}

func TestCollectorNVMeHealth(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake sysfs needs symlinks")
	}
	root := t.TempDir()
	mk := func(p string) string {
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(full, 0o755); err != nil {
			t.Fatal(err)
		}
		return full
	}
	// As the kernel lays it out: the namespace's device link names its controller.
	ns := mk("/sys/devices/pci0000:00/0000:01:00.0/nvme/nvme3/nvme3n1")
	if err := os.Symlink("../../nvme3", filepath.Join(ns, "device")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ns, "size"), []byte("1000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../devices/pci0000:00/0000:01:00.0/nvme/nvme3/nvme3n1", filepath.Join(mk("/sys/block"), "nvme3n1")); err != nil {
		t.Fatal(err)
	}
	var asked []string
	health := func(ctrl string) *SmartStatus {
		asked = append(asked, ctrl)
		return parseNVMeHealth(healthPage(0x04, 97, 0))
	}
	inv, _ := Collector{Root: root, NVMeHealth: health}.Collect()
	if d := inv.Disks.Disks[0]; d.Transport != DiskTransport_DISK_TRANSPORT_NVME || d.Smart == nil || d.Smart.Healthy || len(asked) != 1 || asked[0] != "nvme3" {
		t.Fatalf("disk = %+v, asked %v", d, asked)
	}
	var f *Finding
	for _, x := range HostFindings(inv, true) {
		if x.Check == "disks" {
			f = &x
		}
	}
	if f == nil || f.Status != "warn" || !strings.Contains(f.Detail, "nvme3n1 reports a critical warning") {
		t.Fatalf("finding = %+v", f)
	}
	if inv, _ := (Collector{Root: root}).Collect(); inv.Disks.Disks[0].Smart != nil {
		t.Fatal("health without a source")
	}
	// The real reader refuses anything but a controller name.
	for _, bad := range []string{"../nvme0", "nvme0n1", "sda", ""} {
		if NVMeHealth(bad) != nil {
			t.Fatalf("NVMeHealth(%q) read something", bad)
		}
	}
}
