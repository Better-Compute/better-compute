package agent

import (
	"os"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"google.golang.org/protobuf/proto"
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

	// Released while a workload still runs in it: the slice stays, and every pass tries again until
	// it is empty.
	busy := h.host.Path(fakeSliceDir + "/bcd-alloc-alloc_1.slice.busy")
	if err := os.WriteFile(busy, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	s.push(desired(3, &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{}}))
	converged(3)
	if _, err := os.Stat(record); err != nil {
		t.Fatalf("a busy slice was removed: %v", err)
	}
	if _, err := os.Stat(h.host.Path("/etc/cdi/bcd-alloc_1.json")); !os.IsNotExist(err) {
		t.Fatalf("the hold outlived its release: %v", err)
	}
	_ = os.Remove(busy)
	s.push(desired(4, &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{}}))
	converged(4)
	if _, err := os.Stat(record); !os.IsNotExist(err) {
		t.Fatalf("the emptied slice was left: %v", err)
	}

	// A Kubernetes binding's pods live in the kubelet's cgroups: no slice, no cgroup parent.
	kube := proto.Clone(withHold).(*agentv1.NodeSpec)
	kube.Devices.Assignments[0].AllocationId, kube.Devices.Assignments[0].Binding = "alloc_k", agentv1.Binding_BINDING_KUBERNETES
	s.push(desired(5, kube))
	converged(5)
	if _, err := os.Stat(h.host.Path(fakeSliceDir + "/bcd-alloc-alloc_k.slice.json")); !os.IsNotExist(err) {
		t.Fatalf("a Kubernetes binding got a slice: %v", err)
	}
	cdi, _ = os.ReadFile(h.host.Path("/etc/cdi/bcd-alloc_k.json"))
	if len(cdi) == 0 || strings.Contains(string(cdi), "cgroup-parent") || strings.Contains(string(cdi), "BCD_CGROUP_PARENT") {
		t.Fatalf("CDI spec = %s", cdi)
	}
}
