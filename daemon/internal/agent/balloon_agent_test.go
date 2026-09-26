package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// The balloon pass inflates only the guests whose spec gives them a balloon, never below their
// floor, and deflates them once the host has room; the OTLP export reports the sizes.
func TestBalloonPass(t *testing.T) {
	var fake *runtime.Fake
	h := newHarness(t, func(o *Options) {
		fake = &runtime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}
		o.Runtimes = []runtime.Runtime{fake}
	})
	meminfo := func(totalGiB, availableMiB uint64) {
		p := h.host.Path("/proc/meminfo")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		content := "MemTotal:       " + itoa(totalGiB<<20) + " kB\nMemAvailable:   " + itoa(availableMiB<<10) + " kB\n"
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s, _ := h.open()
	lent := vm("inst_lent", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	lent.Placement = &agentv1.InstancePlacement{Balloon: true}
	fixed := vm("inst_fixed", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	fixed.Nics[0].Mac = "52:54:00:00:00:02"
	fixed.Nics[0].Addresses = []string{"10.0.0.6/24"}
	s.push(desired(1, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{lent, fixed}}}))
	s.next(t, "both instances running", func(f *agentv1.AgentFrame) bool {
		got := instanceStates(f.GetStatus())
		return got["inst_lent"] == agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING &&
			got["inst_fixed"] == agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING
	})
	ctx := context.Background()
	sizes := func() map[string]uint64 {
		m, err := fake.Balloons(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}

	// Room enough: nothing moves.
	meminfo(16, 8<<10)
	if set := h.agent.balloonPass(ctx); len(set) != 0 {
		t.Fatalf("idle host set %v", set)
	}
	// Short (0.5 GiB available of 16): the ballooned guest lends a step (a quarter of 4 GiB) a pass;
	// the fake says it uses half, so it stops at its use plus 10% headroom.
	meminfo(16, 512)
	for pass := 0; pass < 5; pass++ {
		h.agent.balloonPass(ctx)
	}
	memory := lent.GetMemoryBytes()
	floor := memory/2 + uint64(float64(memory)*balloonHeadroom)
	if got := sizes(); got["inst_lent"] != floor {
		t.Fatalf("balloons = %v, want inst_lent at %d", got, floor)
	}
	if _, ok := sizes()["inst_fixed"]; ok {
		t.Fatal("a guest without a balloon was resized")
	}
	// What it lends is reported for it alone (inst_fixed has no balloon).
	var reported bool
	for _, m := range h.agent.instanceMetrics(ctx) {
		if m.Name != "bcd.instance.memory.balloon.reclaimed" {
			continue
		}
		if len(m.Points) != 1 || m.Points[0].Attrs["instance.id"] != "inst_lent" || uint64(*m.Points[0].Int) != memory-floor {
			t.Fatalf("reclaimed = %+v, want inst_lent lending %d", m.Points, memory-floor)
		}
		reported = true
	}
	if !reported {
		t.Fatal("no bcd.instance.memory.balloon.reclaimed")
	}
	// Room again: it deflates a step at a time, back to its full memory.
	meminfo(16, 12<<10)
	if set := h.agent.balloonPass(ctx); set["inst_lent"] != floor+1<<30 {
		t.Fatalf("deflate set %v", set)
	}
	h.agent.balloonPass(ctx)
	if got := sizes()["inst_lent"]; got != 4<<30 {
		t.Fatalf("deflated to %d", got)
	}
	if set := h.agent.balloonPass(ctx); len(set) != 0 {
		t.Fatalf("a full guest resized: %v", set)
	}
}
