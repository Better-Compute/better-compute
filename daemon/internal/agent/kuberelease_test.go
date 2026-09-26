package agent

import (
	"context"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"google.golang.org/protobuf/proto"
)

// A Kubernetes binding's release stops advertising at once, but is reported only once no pod
// holds its devices; meanwhile they stay claimed.
func TestAKubernetesReleaseWaitsForItsPods(t *testing.T) {
	h := newHarness(t, nil)
	s, _ := h.open("gpus")
	var inUse atomic.Bool
	h.agent.devices.inUseHook = func(context.Context, string) bool { return inUse.Load() }
	gpus := fakehw.Inventory(1).Gpus.Gpus
	hold := func(id string, binding agentv1.Binding) *agentv1.DeviceAssignment {
		return &agentv1.DeviceAssignment{AllocationId: id, Binding: binding,
			Devices: []*agentv1.AssignedDevice{{Id: gpus[0].Uuid, DeviceClass: "gpu"}}}
	}
	converged := func(generation uint64) {
		t.Helper()
		s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus().GetObservedGeneration() == generation })
	}
	released := func(f *agentv1.AgentFrame) *agentv1.AllocationReleased {
		for _, e := range f.GetEvents().GetEvents() {
			rb := &agentv1.AttestedReportBody{}
			if proto.Unmarshal(e.GetAttested().GetBody(), rb) == nil && rb.GetAllocationReleased() != nil {
				return rb.GetAllocationReleased()
			}
		}
		return nil
	}

	s.push(desired(1, &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{Assignments: []*agentv1.DeviceAssignment{hold("alloc_k", agentv1.Binding_BINDING_KUBERNETES)}}}))
	converged(1)
	inUse.Store(true)
	s.push(desired(2, &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{}}))
	converged(2)
	if _, err := os.Stat(h.host.Path("/etc/cdi/bcd-alloc_k.json")); !os.IsNotExist(err) {
		t.Fatalf("still advertised: %v", err)
	}
	if got := h.agent.devices.releasingDevices(); got[gpus[0].Uuid] != "alloc_k" {
		t.Fatalf("releasing = %v", got)
	}
	// Still claimed: a new hold on the GPU fails.
	s.push(desired(3, &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{Assignments: []*agentv1.DeviceAssignment{hold("alloc_n", agentv1.Binding_BINDING_HOLD)}}}))
	failed := s.next(t, "AllocationFailed", func(f *agentv1.AgentFrame) bool {
		return f.GetEvents() != nil && f.GetEvents().GetEvents()[0].GetAllocationFailed() != nil
	}).GetEvents().GetEvents()[0].GetAllocationFailed()
	if failed.GetAllocationId() != "alloc_n" || failed.GetReason() != "overlap" {
		t.Fatalf("failed = %v", failed)
	}
	// The pods are gone: reported, with the generation that released it.
	inUse.Store(false)
	s.push(desired(4, &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{}}))
	r := released(s.next(t, "AllocationReleased", func(f *agentv1.AgentFrame) bool { return released(f) != nil }))
	if r.GetAllocationId() != "alloc_k" || r.GetGeneration() != 2 || len(r.GetDeviceIds()) != 1 {
		t.Fatalf("released = %v", r)
	}
	if got := h.agent.devices.releasingDevices(); len(got) != 0 {
		t.Fatalf("still releasing: %v", got)
	}
}

func TestAStuckKubernetesReleaseIsACondition(t *testing.T) {
	h := newHarness(t, nil)
	d := h.agent.devices
	if err := d.updateReleasing(func(m map[string]releasing) {
		m["alloc_old"] = releasing{DeviceIDs: []string{"GPU-a"}, Generation: 7, Since: time.Now().Add(-10 * time.Minute)}
		m["alloc_new"] = releasing{DeviceIDs: []string{"GPU-b"}, Generation: 8, Since: time.Now()}
	}); err != nil {
		t.Fatal(err)
	}
	conds := d.currentConditions()
	if len(conds) != 1 || conds[0].GetType() != "KubernetesReleaseStuck" || !strings.Contains(conds[0].GetMessage(), "alloc_old") {
		t.Fatalf("conditions = %v", conds)
	}
}
