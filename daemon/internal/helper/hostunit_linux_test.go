package helper

import (
	"context"
	"encoding/json"
	"net"
	"path/filepath"
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
)

// host.unit: the helper plans the unit again itself, as root, from the unit's name and settings
// alone, with the same validation bcd node has; the node's word adds nothing.
func TestHelperHostUnit(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "helper.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	sys := hostconfig.NewFakeSystem()
	sys.Set("/proc/sys/vm/swappiness", "60\n")
	sys.Set("/proc/sys/kernel/core_pattern", "core\n")
	var busy []string
	srv := &Server{
		Ops: &fakeOps{}, Root: t.TempDir(), Allowed: me,
		HostUnits: func(o hostconfig.Options) *hostconfig.Registry {
			busy = busy[:0]
			for _, g := range []string{"GPU-a", "GPU-b"} {
				if o.GPUBusy(g) {
					busy = append(busy, g)
				}
			}
			return hostconfig.Builtin(o)
		},
		HostSystem: sys,
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = srv.Serve(ctx, ln) }()
	c := Client{Socket: sock}

	if err := c.HostUnit(ctx, "sysctl", json.RawMessage(`{"vm.swappiness":10}`), []string{"GPU-b"}, nil); err != nil {
		t.Fatal(err)
	}
	if v, _ := sys.Get("/proc/sys/vm/swappiness"); v != "10\n" {
		t.Fatalf("swappiness = %q", v)
	}
	if strings.Join(busy, ",") != "GPU-b" {
		t.Fatalf("busy GPUs = %v", busy)
	}
	// What the unit refuses, the helper refuses: a key that would run a program as root.
	err = c.HostUnit(ctx, "sysctl", json.RawMessage(`{"kernel.core_pattern":"|/tmp/x"}`), nil, nil)
	if err == nil || !strings.Contains(err.Error(), "refused") {
		t.Fatalf("core_pattern: %v", err)
	}
	if v, _ := sys.Get("/proc/sys/kernel/core_pattern"); v != "core\n" {
		t.Fatalf("core_pattern written: %q", v)
	}
	for _, unit := range []string{"../etc", "Sysctl", "", strings.Repeat("a", 65)} {
		if err := c.HostUnit(ctx, unit, json.RawMessage(`{}`), nil, nil); err == nil || !strings.Contains(err.Error(), "not a config unit name") {
			t.Fatalf("%q: %v", unit, err)
		}
	}
	if err := c.HostUnit(ctx, "slurm-join", json.RawMessage(`{}`), nil, nil); err == nil || !strings.Contains(err.Error(), "not supported") {
		t.Fatalf("unknown unit: %v", err)
	}
	// No settings: the unit left the spec, and its drop-in goes.
	if _, ok := sys.Get(hostconfig.SysctlFile); !ok {
		t.Fatal("no drop-in written")
	}
	if err := c.HostUnit(ctx, "sysctl", nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, ok := sys.Get(hostconfig.SysctlFile); ok {
		t.Fatal("drop-in left after the clean")
	}
	// A helper without host units refuses the operation.
	srv.HostUnits = nil
	if err := c.HostUnit(ctx, "sysctl", json.RawMessage(`{}`), nil, nil); err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("unconfigured: %v", err)
	}
}
