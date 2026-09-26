package helper

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

const (
	chInstance = "inst_0123456789ab"
	vmmUID     = 0x7FFD0000 + 3
)

// chFixture is a cloud-hypervisor data directory, a fake /sys, and a recording command runner.
type chFixture struct {
	dir, sys string
	mu       sync.Mutex
	runs     []string
	live     map[string]uint32 // instance → VMM user of the "running" bcd-ch units
	bound    []string
}

func newCHFixture(t *testing.T) *chFixture {
	t.Helper()
	f := &chFixture{dir: t.TempDir(), sys: t.TempDir(), live: map[string]uint32{}}
	f.record(t, chInstance, vmmUID, nil)
	return f
}

func (f *chFixture) record(t *testing.T, id string, uid uint32, gpus []string) {
	t.Helper()
	dir := filepath.Join(f.dir, "instances", id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	quoted := make([]string, len(gpus))
	for i, g := range gpus {
		quoted[i] = `"` + g + `"`
	}
	raw := fmt.Sprintf(`{"id":%q,"managed":"better-compute/cloud-hypervisor/1","uid":%d,"vcpu":2,"memoryBytes":1073741824,"gpus":[%s]}`,
		id, uid, strings.Join(quoted, ","))
	if err := os.WriteFile(filepath.Join(dir, "vm.json"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (f *chFixture) run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	call := name + " " + strings.Join(args, " ")
	f.runs = append(f.runs, call)
	if name == "systemctl" && args[0] == "list-units" {
		var out strings.Builder
		for id := range f.live {
			fmt.Fprintf(&out, "bcd-ch-%s.service loaded active running cloud-hypervisor\n", id)
		}
		return []byte(out.String()), nil
	}
	if name == "systemctl" && args[0] == "show" && args[1] == "--property=User" {
		id := strings.TrimSuffix(strings.TrimPrefix(args[3], "bcd-ch-"), ".service")
		return []byte(fmt.Sprintf("%d\n", f.live[id])), nil
	}
	if name == "systemctl" && args[0] == "show" {
		return []byte("inactive\n"), nil
	}
	return nil, nil
}

func (f *chFixture) Bind(addr string) error    { f.bound = append(f.bound, addr); return nil }
func (f *chFixture) Release(addr string) error { return nil }

func (f *chFixture) server() *Server {
	return &Server{CHPolicy: func() (CHPolicy, error) {
		return CHPolicy{
			Root: runtime.CHRootPolicy{
				Dir: f.dir, Volumes: filepath.Join(f.dir, "volumes"), Binary: "/usr/bin/cloud-hypervisor",
				CheckFile: func(string) error { return nil }, PCI: map[string]bool{"0000:3b:00.0": true},
				GPUAddress: func(uuid string) (string, bool) {
					a, ok := map[string]string{"GPU-a": "0000:3b:00.0"}[uuid]
					return a, ok
				},
			},
			Bridges: map[string]bool{"br0": true}, NodeUID: 1000, Run: f.run, VFIO: f, Sys: f.sys,
			Busy: func(context.Context) map[string]bool { return map[string]bool{} },
		}, nil
	}}
}

func (f *chFixture) iface(t *testing.T, name string, tap bool) {
	t.Helper()
	dir := filepath.Join(f.sys, "sys/class/net", name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if tap {
		_ = os.WriteFile(filepath.Join(dir, "tun_flags"), []byte("0x1002\n"), 0o644)
	}
}

func TestCHTapsAreBcdsNamesOnAllowedBridges(t *testing.T) {
	f := newCHFixture(t)
	s := f.server()
	ctx := context.Background()
	if _, err := s.ch(ctx, "taps", &CHRequest{Instance: chInstance, Networks: []string{"br-mgmt"}}); err == nil {
		t.Fatal("a bridge outside instance_bridges")
	}
	if _, err := s.ch(ctx, "taps", &CHRequest{Instance: "../etc", Networks: []string{"br0"}}); err == nil {
		t.Fatal("a path as an instance")
	}
	tap := runtime.TapName(chInstance, 0)
	f.iface(t, tap, false) // something else by that name
	if _, err := s.ch(ctx, "taps", &CHRequest{Instance: chInstance, Networks: []string{"br0"}}); err == nil || !strings.Contains(err.Error(), "not a tap") {
		t.Fatalf("an interface that is not a tap: %v", err)
	}
	_ = os.RemoveAll(filepath.Join(f.sys, "sys/class/net", tap))
	if _, err := s.ch(ctx, "taps", &CHRequest{Instance: chInstance, Networks: []string{"br0"}}); err != nil {
		t.Fatal(err)
	}
	want := "ip tuntap add dev " + tap + " mode tap user 1000"
	if !strings.Contains(strings.Join(f.runs, "\n"), want) || !strings.Contains(strings.Join(f.runs, "\n"), "ip link set "+tap+" master br0") {
		t.Fatalf("runs = %v", f.runs)
	}
	// ch.untaps deletes exactly TapName(instance, 0..n-1): nothing else, whatever its name.
	f.runs = nil
	f.iface(t, tap, true)
	f.iface(t, runtime.TapName(chInstance, 0)+"x", true)
	if _, err := s.ch(ctx, "untaps", &CHRequest{Instance: chInstance, NICs: 1}); err != nil {
		t.Fatal(err)
	}
	if len(f.runs) != 1 || f.runs[0] != "ip link delete "+tap {
		t.Fatalf("runs = %v", f.runs)
	}
	if _, err := s.ch(ctx, "untaps", &CHRequest{Instance: chInstance, NICs: 99}); err == nil {
		t.Fatal("99 NICs")
	}
}

func TestCHLaunchIsRootsUnitNeverAnotherUnitsUser(t *testing.T) {
	f := newCHFixture(t)
	s := f.server()
	ctx := context.Background()
	f.live["inst_otherxxxxxxxx"] = vmmUID
	if _, err := s.ch(ctx, "launch", &CHRequest{Instance: chInstance}); err == nil || !strings.Contains(err.Error(), "inst_otherxxxxxxxx") {
		t.Fatalf("another unit's user: %v", err)
	}
	delete(f.live, "inst_otherxxxxxxxx")
	if _, err := s.ch(ctx, "launch", &CHRequest{Instance: chInstance}); err != nil {
		t.Fatal(err)
	}
	var unit string
	for _, r := range f.runs {
		if strings.HasPrefix(r, "systemd-run ") {
			unit = r
		}
	}
	for _, want := range []string{"--unit=bcd-ch-" + chInstance + ".service", "User=2147287043", "NoNewPrivileges=yes", "CapabilityBoundingSet=",
		"-- /usr/bin/cloud-hypervisor --api-socket path=" + filepath.Join(f.dir, "instances", chInstance, "api.sock")} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit lacks %s: %s", want, unit)
		}
	}
	// A symlink in the instance's directory stops it.
	if err := os.Symlink("/etc/shadow", filepath.Join(f.dir, "instances", chInstance, "seed.iso")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ch(ctx, "launch", &CHRequest{Instance: chInstance}); err == nil {
		t.Fatal("launched with a symlink")
	}
}

func TestCHVFIOTakesOnlyWholeGroupsOfThisHostsGPUs(t *testing.T) {
	f := newCHFixture(t)
	f.record(t, chInstance, vmmUID, []string{"GPU-a"})
	s := f.server()
	ctx := context.Background()
	group := func(devices ...string) {
		t.Helper()
		g := filepath.Join(f.sys, "sys/kernel/iommu_groups/7/devices")
		_ = os.RemoveAll(g)
		_ = os.MkdirAll(g, 0o755)
		for _, d := range devices {
			_ = os.MkdirAll(filepath.Join(g, d), 0o755)
		}
		dev := filepath.Join(f.sys, "sys/bus/pci/devices/0000:3b:00.0")
		_ = os.MkdirAll(dev, 0o755)
		_ = os.Remove(filepath.Join(dev, "iommu_group"))
		if err := os.Symlink(filepath.Join(f.sys, "sys/kernel/iommu_groups/7"), filepath.Join(dev, "iommu_group")); err != nil {
			t.Fatal(err)
		}
	}
	group("0000:3b:00.0", "0000:5e:00.0") // another device (a NIC) in the group
	if _, err := s.ch(ctx, "vfio", &CHRequest{Instance: chInstance}); err == nil || !strings.Contains(err.Error(), "0000:5e:00.0") {
		t.Fatalf("a group with another device: %v", err)
	}
	if len(f.bound) != 0 {
		t.Fatalf("bound %v", f.bound)
	}
	// Busy as root sees it: refused.
	busy := f.server()
	busyPolicy := busy.CHPolicy
	busy.CHPolicy = func() (CHPolicy, error) {
		p, err := busyPolicy()
		p.Busy = func(context.Context) map[string]bool { return map[string]bool{"GPU-a": true} }
		return p, err
	}
	group("0000:3b:00.0", "0000:3b:00.1")
	if _, err := busy.ch(ctx, "vfio", &CHRequest{Instance: chInstance}); err == nil || !strings.Contains(err.Error(), "holds work") {
		t.Fatalf("a busy GPU: %v", err)
	}
	// ch.unvfio gives back only this host's GPUs.
	if _, err := s.ch(ctx, "unvfio", &CHRequest{Instance: chInstance, Addrs: []string{"0000:5e:00.0"}}); err == nil {
		t.Fatal("unvfio of a device not this host's GPU")
	}
	if os.Geteuid() != 0 {
		return // giving /dev/vfio/<g> to the VMM's user needs root
	}
	_ = os.MkdirAll(filepath.Join(f.sys, "dev/vfio"), 0o755)
	_ = os.WriteFile(filepath.Join(f.sys, "dev/vfio/7"), nil, 0o600)
	if _, err := s.ch(ctx, "vfio", &CHRequest{Instance: chInstance}); err != nil {
		t.Fatal(err)
	}
	if len(f.bound) != 1 {
		t.Fatalf("bound %v", f.bound)
	}
}
