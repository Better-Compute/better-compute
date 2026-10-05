package helper

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// serveHW is serve with a fake NVMe health reader that records the controllers it is asked for.
func serveHW(t *testing.T, allowed func(Peer) error) (Client, string, *[]string) {
	t.Helper()
	root := t.TempDir()
	sock := filepath.Join(t.TempDir(), "helper.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	asked := &[]string{}
	srv := &Server{Ops: &fakeOps{}, Root: root, Allowed: allowed, NVMeHealth: func(ctrl string) *inventory.SmartStatus {
		*asked = append(*asked, ctrl)
		wear := uint32(len(*asked))
		return &inventory.SmartStatus{Healthy: true, WearPercent: &wear}
	}, BMC: func() *inventory.BmcSection {
		return &inventory.BmcSection{Vendor: "Dell", FirmwareVersion: "7.10", Mac: "d0:8e:79:00:00:01", Ip: "10.0.0.5", Ipmi: true}
	}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = srv.Serve(ctx, ln) }()
	return Client{Socket: sock}, root, asked
}

// memoryDevice is a minimal SMBIOS type 17 structure: a 16 GiB DDR5 module in slot, with a serial.
func memoryDevice(slot, serial string) []byte {
	f := make([]byte, 0x22)
	f[0], f[1] = 17, 0x22
	binary.LittleEndian.PutUint16(f[0x0c:], 16384)
	f[0x12] = 0x22
	f[0x10], f[0x18] = 1, 2
	return append(append(append(f, slot...), 0), append([]byte(serial), 0, 0)...)
}

func writeFile(t *testing.T, path string, b []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o400); err != nil {
		t.Fatal(err)
	}
}

func TestHWReadReturnsParsedDIMMsAndNVMeHealth(t *testing.T) {
	c, root, asked := serveHW(t, me)
	entries := filepath.Join(root, "sys", "firmware", "dmi", "entries")
	writeFile(t, filepath.Join(entries, "17-0", "raw"), memoryDevice("A1", "SER0"))
	writeFile(t, filepath.Join(entries, "17-1", "raw"), memoryDevice("B1", "SER1"))
	writeFile(t, filepath.Join(entries, "1-0", "raw"), []byte{1, 4, 0, 0, 0, 0}) // not memory
	// A symlinked raw is never followed.
	writeFile(t, filepath.Join(root, "secret"), memoryDevice("LEAK", "SECRET"))
	if err := os.MkdirAll(filepath.Join(entries, "17-2"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "secret"), filepath.Join(entries, "17-2", "raw")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"nvme1", "nvme0", "nvme-subsys0", "nvme0n1"} {
		if err := os.MkdirAll(filepath.Join(root, "sys", "class", "nvme", name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	got, err := c.ReadHW(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Dimms) != 2 || got.Dimms[0].Slot != "A1" || got.Dimms[0].Serial != "SER0" || got.Dimms[0].SizeBytes != 16<<30 || got.Dimms[1].Slot != "B1" {
		t.Fatalf("dimms = %+v", got.Dimms)
	}
	if b := got.BMC; b == nil || b.Vendor != "Dell" || b.Mac != "d0:8e:79:00:00:01" || b.Ip != "10.0.0.5" || b.FirmwareVersion != "7.10" {
		t.Fatalf("bmc = %+v", got.BMC)
	}
	if strings.Join(*asked, ",") != "nvme0,nvme1" || len(got.NVMe) != 2 || got.NVMe["nvme0"] == nil || !got.NVMe["nvme0"].Healthy || *got.NVMe["nvme1"].WearPercent != 2 {
		t.Fatalf("asked %v, nvme = %+v", *asked, got.NVMe)
	}
}

func TestHWReadCaps(t *testing.T) {
	c, root, asked := serveHW(t, me)
	entries := filepath.Join(root, "sys", "firmware", "dmi", "entries")
	for i := 0; i < maxHWEntries+10; i++ {
		writeFile(t, filepath.Join(entries, fmt.Sprintf("17-%d", i), "raw"), memoryDevice(fmt.Sprintf("S%03d", i), "X"))
		if err := os.MkdirAll(filepath.Join(root, "sys", "class", "nvme", fmt.Sprintf("nvme%d", i)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// An oversized structure is cut at maxSMBIOSRaw (and then fails to parse as anything bigger).
	big := append(memoryDevice("BIG", "X"), make([]byte, 2*maxSMBIOSRaw)...)
	writeFile(t, filepath.Join(entries, "17-999", "raw"), big)
	got, err := c.ReadHW(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Dimms) != maxHWEntries || len(got.NVMe) != maxHWEntries || len(*asked) != maxHWEntries {
		t.Fatalf("dimms %d, nvme %d, asked %d", len(got.Dimms), len(got.NVMe), len(*asked))
	}
}

// A controller whose read never returns costs the op its budget, not the helper its connection:
// the controllers read before it are answered.
func TestHWReadBudget(t *testing.T) {
	defer func(b time.Duration) { hwBudget = b }(hwBudget)
	hwBudget = 200 * time.Millisecond
	root := t.TempDir()
	sock := filepath.Join(t.TempDir(), "helper.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	stuck := make(chan struct{})
	defer close(stuck)
	srv := &Server{Ops: &fakeOps{}, Root: root, Allowed: me, NVMeHealth: func(ctrl string) *inventory.SmartStatus {
		if ctrl == "nvme1" {
			<-stuck
		}
		return &inventory.SmartStatus{Healthy: true}
	}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx, ln) }()
	for _, name := range []string{"nvme0", "nvme1", "nvme2"} {
		if err := os.MkdirAll(filepath.Join(root, "sys", "class", "nvme", name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	start := time.Now()
	got, err := Client{Socket: sock}.ReadHW(context.Background())
	if err != nil || len(got.NVMe) != 1 || got.NVMe["nvme0"] == nil || time.Since(start) > 5*time.Second {
		t.Fatalf("got %+v, %v after %s", got, err, time.Since(start))
	}
}

func TestHWReadRefusesArguments(t *testing.T) {
	c, _, asked := serveHW(t, me)
	for _, req := range []Request{
		{Op: "hw.read", Name: "nvme0"},
		{Op: "hw.read", Kind: "smbios"},
		{Op: "hw.read", GPU: "GPU-1"},
	} {
		if _, err := c.Call(context.Background(), req); err == nil || !strings.Contains(err.Error(), "takes no arguments") {
			t.Fatalf("%+v: %v", req, err)
		}
	}
	if len(*asked) != 0 {
		t.Fatalf("a refused request read %v", *asked)
	}
	// No SMBIOS, no NVMe: an empty answer.
	got, err := c.ReadHW(context.Background())
	if err != nil || len(got.Dimms) != 0 || len(got.NVMe) != 0 {
		t.Fatalf("empty host = %+v, %v", got, err)
	}
	refused, _, _ := serveHW(t, func(Peer) error { return fmt.Errorf("no") })
	if _, err := refused.ReadHW(context.Background()); err == nil {
		t.Fatal("a refused peer read the hardware")
	}
}
