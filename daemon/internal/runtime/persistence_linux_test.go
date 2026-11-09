package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// An nvidia-smi that hangs (the driver does) is killed after its timeout: the persistence calls
// around a passthrough start or stop return, both the libvirt path's and SysfsVFIO's.
func TestNvidiaSMIIsBounded(t *testing.T) {
	// A stand-in that never answers; its sleep is a child that keeps the output pipe open.
	hung := filepath.Join(t.TempDir(), "nvidia-smi")
	if err := os.WriteFile(hung, []byte("#!/bin/sh\necho waiting\nsleep 20\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	oldBin, oldTimeout := nvidiaSMI, nvidiaSMITimeout
	nvidiaSMI, nvidiaSMITimeout = hung, 300*time.Millisecond
	t.Cleanup(func() { nvidiaSMI, nvidiaSMITimeout = oldBin, oldTimeout })
	for name, call := range map[string]func() error{
		"NvidiaPersistence":     func() error { return NvidiaPersistence("0000:3b:00.0", false) },
		"SysfsVFIO.persistence": func() error { return SysfsVFIO{}.persistence("0000:3b:00.0", true) },
	} {
		started := time.Now()
		err := call()
		if took := time.Since(started); took > 10*time.Second {
			t.Fatalf("%s waited %s for a hung nvidia-smi", name, took)
		}
		if err == nil || !strings.Contains(err.Error(), "no answer after") {
			t.Fatalf("%s with a hung nvidia-smi = %v", name, err)
		}
	}
	// One that answers is still an ordinary call.
	ok := filepath.Join(t.TempDir(), "nvidia-smi")
	if err := os.WriteFile(ok, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	nvidiaSMI, nvidiaSMITimeout = ok, 5*time.Second
	if err := NvidiaPersistence("0000:3b:00.0", true); err != nil {
		t.Fatal(err)
	}
}
