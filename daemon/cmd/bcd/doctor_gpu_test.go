package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"github.com/better-compute/better-compute/daemon/internal/nvml"
)

// pciTree writes PCI functions under root/sys/bus/pci/devices: address → "class driver".
func pciTree(t *testing.T, root string, devices map[string]string) {
	t.Helper()
	for addr, spec := range devices {
		class, driver, _ := strings.Cut(spec, " ")
		dir := filepath.Join(root, "sys/bus/pci/devices", addr)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		vendor := "0x10de"
		if class == "nic" {
			vendor, class = "0x15b3", "0x020000"
		}
		os.WriteFile(filepath.Join(dir, "vendor"), []byte(vendor+"\n"), 0o644)
		os.WriteFile(filepath.Join(dir, "class"), []byte(class+"\n"), 0o644)
		if driver != "" {
			if err := os.Symlink("../../../bus/pci/drivers/"+driver, filepath.Join(dir, "driver")); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func findCheck(checks []doctorCheck, name string) *doctorCheck {
	for i := range checks {
		if checks[i].check == name {
			return &checks[i]
		}
	}
	return nil
}

func TestGpuHostChecks(t *testing.T) {
	snap := fakehw.GPUSnapshot(1, time.Unix(1_800_000_000, 0)) // 8 GPUs, persistence on
	all := func(string) bool { return true }
	none := func(string) bool { return false }
	eight := map[string]string{"0000:3a:00.0": "nic"}
	for i := 0; i < 8; i++ {
		eight["0000:1"+string(rune('0'+i))+":00.0"] = "0x030200 nvidia"
	}

	// Healthy: every bound GPU answers; NVSwitches with fabric manager.
	root := t.TempDir()
	devices := map[string]string{"0000:c0:00.0": "0x068000 ", "0000:c1:00.0": "0x068000 "}
	for k, v := range eight {
		devices[k] = v
	}
	pciTree(t, root, devices)
	got := gpuHostChecks(root, snap, all)
	if c := findCheck(got, "gpu-bus"); c == nil || c.status != "ok" || c.detail != "8 NVIDIA GPU(s) on the PCI bus: 8 on nvidia" {
		t.Fatalf("healthy = %+v", got)
	}
	if c := findCheck(got, "fabric-manager"); c == nil || c.status != "ok" {
		t.Fatalf("fabric manager = %+v", got)
	}
	if len(got) != 2 {
		t.Fatalf("healthy host has extra findings: %+v", got)
	}
	// Fabric manager down fails.
	if c := findCheck(gpuHostChecks(root, snap, none), "fabric-manager"); c == nil || c.status != "fail" {
		t.Fatal("fabric manager down not failed")
	}

	// A GPU fell off the bus: bound to nvidia, gone from nvidia-smi.
	short := *snap
	sec := *snap.Section
	sec.Gpus = sec.Gpus[:7]
	short.Section = &sec
	if c := findCheck(gpuHostChecks(root, &short, all), "gpu-bus"); c == nil || c.status != "fail" || !strings.Contains(c.detail, "nvidia-smi sees 7") {
		t.Fatalf("fell off the bus = %+v", c)
	}

	// Passthrough GPUs on vfio-pci are expected to be invisible to nvidia-smi; an unbound one warns.
	root = t.TempDir()
	pciTree(t, root, map[string]string{"0000:10:00.0": "0x030200 nvidia", "0000:11:00.0": "0x030200 vfio-pci", "0000:12:00.0": "0x030000 "})
	one := short
	sec1 := *snap.Section
	sec1.Gpus = sec1.Gpus[:1]
	one.Section = &sec1
	if c := findCheck(gpuHostChecks(root, &one, all), "gpu-bus"); c == nil || c.status != "warn" || !strings.Contains(c.detail, "0000:12:00.0") {
		t.Fatalf("unbound = %+v", c)
	}
	os.Remove(filepath.Join(root, "sys/bus/pci/devices/0000:12:00.0/class"))
	if c := findCheck(gpuHostChecks(root, &one, all), "gpu-bus"); c == nil || c.status != "ok" || !strings.Contains(c.detail, "1 on vfio-pci") {
		t.Fatalf("vfio = %+v", c)
	}

	// No driver at all, and nouveau holding them; persistence off.
	root = t.TempDir()
	pciTree(t, root, map[string]string{"0000:10:00.0": "0x030200 nouveau"})
	os.MkdirAll(filepath.Join(root, "proc"), 0o755)
	os.WriteFile(filepath.Join(root, "proc/modules"), []byte("nouveau 2400000 0 - Live 0x0\nvideo 65536 1 nouveau, Live 0x0\n"), 0o644)
	got = gpuHostChecks(root, nil, all)
	if c := findCheck(got, "nouveau"); c == nil || c.status != "fail" {
		t.Fatalf("nouveau = %+v", got)
	}
	if c := findCheck(got, "gpu-bus"); c == nil || c.status != "warn" || !strings.Contains(c.detail, "no NVIDIA driver") {
		t.Fatalf("no driver = %+v", got)
	}
	sec1.Gpus[0].PersistenceMode = false
	if c := findCheck(gpuHostChecks(t.TempDir(), &one, all), "persistence"); c == nil || c.status != "warn" {
		t.Fatal("persistence off not reported")
	}

	// WSL 2: /dev/dxg, no /dev/nvidiactl, PCI bus full of virtual devices.
	root = t.TempDir()
	os.MkdirAll(filepath.Join(root, "dev"), 0o755)
	os.WriteFile(filepath.Join(root, "dev/dxg"), nil, 0o644)
	pciTree(t, root, map[string]string{"0827:00:00.0": "nic"})
	got = gpuHostChecks(root, &one, all)
	if len(got) != 1 || got[0].check != "gpu-host" || !strings.Contains(got[0].detail, "WSL 2") {
		t.Fatalf("wsl = %+v", got)
	}
}

func TestGpuErrorHint(t *testing.T) {
	for msg, want := range map[string]string{
		"nvidia-smi -q -x: exit status 18: Failed to initialize NVML: Driver/library version mismatch": "reboot",
		"nvidia-smi -q -x: exit status 9: NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver": "modprobe nvidia",
		"nvidia-smi -q -x: exit status 6: No devices were found":                                                        "lspci",
		"nvidia-smi -q -x: signal: killed":                                                                              "wedged",
	} {
		if got := gpuErrorHint(errors.New(msg)).Error(); !strings.Contains(got, want) || !strings.HasPrefix(got, msg) {
			t.Errorf("%q → %q", msg, got)
		}
	}
	plain := errors.New("something else")
	if gpuErrorHint(plain) != plain {
		t.Error("an unknown error was rewritten")
	}
	if c := gpuDoctorWith(errors.New("exit status 18: Driver/library version mismatch")); len(c) != 1 || c[0].status != "fail" || !strings.Contains(c[0].detail, "reboot") {
		t.Fatalf("doctor = %+v", c)
	}
	if c := gpuDoctorWith(nvml.ErrNoDriver); len(c) != 0 {
		t.Fatalf("no driver = %+v", c)
	}
}

// gpuDoctorWith runs gpuDoctor over a sampler that fails with err.
func gpuDoctorWith(err error) []doctorCheck {
	return gpuDoctor(func(context.Context) (*nvml.Snapshot, error) { return nil, err })
}
