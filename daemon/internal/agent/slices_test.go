package agent

import (
	"os"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
)

func TestAHoldWithLimitsRunsInItsSlice(t *testing.T) {
	h := newHarness(t, nil)
	s, _ := h.open("gpus")
	gpus := fakehw.Inventory(1).Gpus.Gpus
	withHold := &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{Assignments: []*agentv1.DeviceAssignment{{
		AllocationId: "alloc_1", ReservationId: "res_1", Binding: agentv1.Binding_BINDING_HOLD,
		Devices: []*agentv1.AssignedDevice{{Id: gpus[0].Uuid, DeviceClass: "gpu"}},
		Limits:  &agentv1.ResourceLimits{Cpus: "0-7", Mems: "0", MemoryBytes: 16 << 30},
	}}}}
	converged := func(generation uint64) {
		t.Helper()
		s.next(t, "status", func(f *agentv1.AgentFrame) bool {
			return f.GetStatus() != nil && f.GetStatus().GetObservedGeneration() == generation
		})
	}
	record := h.host.Path(fakeSliceDir + "/bcd-alloc-alloc_1.slice.json")

	s.push(desired(1, withHold))
	converged(1)
	raw, err := os.ReadFile(record)
	if err != nil || !strings.Contains(string(raw), `"cpus":"0-7"`) || !strings.Contains(string(raw), `"memoryBytes":17179869184`) {
		t.Fatalf("slice record = %s, %v", raw, err)
	}
	cdi, _ := os.ReadFile(h.host.Path("/etc/cdi/bcd-alloc_1.json"))
	if !strings.Contains(string(cdi), `"bcd.dev/cgroup-parent":"bcd-alloc-alloc_1.slice"`) {
		t.Fatalf("CDI spec = %s", cdi)
	}
	env, _ := os.ReadFile(h.host.Path("/run/bcd/allocations/alloc_1.env"))
	if !strings.Contains(string(env), "BCD_CGROUP_PARENT=bcd-alloc-alloc_1.slice\n") {
		t.Fatalf("env file = %s", env)
	}

	// A reboot drops the slice's runtime properties, never the hold: the next pass restores it.
	if err := os.Remove(record); err != nil {
		t.Fatal(err)
	}
	s.push(desired(2, withHold))
	converged(2)
	if _, err := os.Stat(record); err != nil {
		t.Fatalf("the slice was not restored: %v", err)
	}

	// Released: the (empty) slice goes with the hold.
	s.push(desired(3, &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{}}))
	converged(3)
	if _, err := os.Stat(record); !os.IsNotExist(err) {
		t.Fatalf("the slice outlived its hold: %v", err)
	}
}
