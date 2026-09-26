package runtime

import (
	"context"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseBalloonStats(t *testing.T) {
	out := "Domain: 'inst_a'\n  balloon.current=3145728\n  balloon.maximum=4194304\n\nDomain: 'inst_b'\n  balloon.maximum=4194304\n\nDomain: 'inst_c'\n  balloon.current=x\n"
	if got := parseBalloonStats([]byte(out)); !reflect.DeepEqual(got, map[string]uint64{"inst_a": 3 << 30}) {
		t.Fatalf("balloons = %v", got)
	}
}

// balloonHypervisor records the helper operations the balloon asks for.
type balloonHypervisor struct {
	Hypervisor
	ops  []string
	ops2 []LibvirtOp
}

func (h *balloonHypervisor) Libvirt(_ context.Context, verb string, op LibvirtOp) error {
	h.ops = append(h.ops, verb)
	h.ops2 = append(h.ops2, op)
	return nil
}

// Libvirt's balloon is virsh setmem (KiB, live) and domstats; under bcd helper setmem is the
// helper's operation and domstats reads through the read-only socket.
func TestLibvirtBalloon(t *testing.T) {
	ctx := context.Background()
	var calls []string
	exec := func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		if len(args) > 0 && strings.Contains(strings.Join(args, " "), "domstats") {
			return []byte("Domain: 'inst_a'\n  balloon.current=2097152\n"), nil
		}
		return nil, nil
	}
	l := &Libvirt{Dir: t.TempDir(), Exec: exec}
	if err := l.SetBalloon(ctx, "inst_a", 3<<30); err != nil {
		t.Fatal(err)
	}
	sizes, err := l.Balloons(ctx)
	if err != nil || sizes["inst_a"] != 2<<30 {
		t.Fatalf("balloons = %v, %v", sizes, err)
	}
	if want := []string{"virsh -c qemu:///system setmem inst_a 3145728 --live", "virsh -c qemu:///system domstats --raw --state-running --balloon"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %q", calls)
	}

	calls = nil
	h := &balloonHypervisor{}
	l = &Libvirt{Dir: t.TempDir(), Exec: exec, Hypervisor: h}
	if err := l.SetBalloon(ctx, "inst_a", 3<<30); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(h.ops, []string{"setmem"}) || h.ops2[0].Domain != "inst_a" || h.ops2[0].Bytes != 3<<30 {
		t.Fatalf("helper ops = %v %+v", h.ops, h.ops2)
	}
	if sizes, err := l.Balloons(ctx); err != nil || sizes["inst_a"] != 2<<30 {
		t.Fatalf("balloons under the helper = %v, %v", sizes, err)
	}
	if len(calls) != 1 || !strings.HasPrefix(calls[0], "virsh -r -c qemu:///system domstats") {
		t.Fatalf("calls under the helper = %q", calls)
	}
}

// The fake keeps balloons per runtime file and never above the domain's memory.
func TestFakeBalloon(t *testing.T) {
	ctx := context.Background()
	f := &Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}
	if err := f.Leak("vm", StateRunning); err != nil {
		t.Fatal(err)
	}
	domains, _ := f.List(ctx)
	if err := f.SetBalloon(ctx, "vm", domains[0].MemoryBytes+1); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.Balloons(ctx); got["vm"] != domains[0].MemoryBytes {
		t.Fatalf("balloons = %v", got)
	}
	if f.SetBalloon(ctx, "missing", 1) == nil {
		t.Fatal("a missing domain was ballooned")
	}
	other := &Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}
	_ = other.Leak("vm", StateRunning)
	if got, _ := other.Balloons(ctx); len(got) != 0 {
		t.Fatalf("another fake's balloons = %v", got)
	}
}
