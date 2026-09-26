package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
	"github.com/better-compute/better-compute/daemon/internal/slice"
)

// A hold's limits are admitted against the host as a VM start is, and each side counts the other.
func TestHoldsAndVMsShareTheHostsMemory(t *testing.T) {
	// 55 GiB of normal memory after the pool and headroom; 2048 free 2 MiB pages on each node.
	fakeHostMemory(t, 64, 8<<20, map[int]uint64{0: 2048, 1: 2048})
	m, err := probeHostMemory(map[string]runtime.Domain{
		"inst_a": {ID: "inst_a", Managed: true, State: runtime.StateRunning, MemoryBytes: 16 << 30},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.admitHold(&agentv1.ResourceLimits{MemoryBytes: 24 << 30, Mems: "1", Hugepages_2Mi: 1500}); err != nil {
		t.Fatalf("24 GiB and 1500 pages on node 1 refused: %v", err)
	}
	// Node 1 has 548 pages left; node 0 still has its 2048.
	if err := m.admitHold(&agentv1.ResourceLimits{Mems: "1", Hugepages_2Mi: 600}); err == nil || !strings.HasPrefix(err.Error(), ResourcesExhausted) {
		t.Fatalf("600 more pages on node 1: %v", err)
	}
	if err := m.admitHold(&agentv1.ResourceLimits{Mems: "0", Hugepages_2Mi: 600}); err != nil {
		t.Fatalf("600 pages on node 0 refused: %v", err)
	}
	// Pages taken with no node (host-wide) leave the per-node counts alone, but still bound them:
	// 2048 - 600 left on node 0, yet only 4096 - 1500 - 600 - 1500 = 496 on the host.
	if err := m.admitHold(&agentv1.ResourceLimits{Hugepages_2Mi: 1500}); err != nil {
		t.Fatalf("1500 host-wide pages refused: %v", err)
	}
	if err := m.admitHold(&agentv1.ResourceLimits{Mems: "0", Hugepages_2Mi: 600}); err == nil {
		t.Fatal("600 pages on node 0 admitted beyond the host's 496")
	}
	if err := m.admit(instance("inst_h", 2<<30, &agentv1.InstancePlacement{Mems: "0", HugepageSizeBytes: runtime.Hugepage2Mi}), false); err == nil {
		t.Fatal("a 1024-page VM on node 0 admitted beyond the host's 496")
	}
	// 16 GiB + overhead + 24 GiB committed of 55 GiB: a 16 GiB VM no longer fits.
	if err := m.admit(instance("inst_b", 16<<30, nil), false); err == nil || !strings.HasPrefix(err.Error(), ResourcesExhausted) {
		t.Fatalf("a 16 GiB VM beside the hold: %v", err)
	}

	// A bound hold counts only the hugepages it has not faulted in yet.
	root := hostMemoryRoot
	dir := slice.Dir(root, holdSlice("alloc_used"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "hugetlb.2MB.current"), []byte(itoa(1000*runtime.Hugepage2Mi)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := commitmentOf(&agentv1.ResourceLimits{MemoryBytes: 1 << 30, Hugepages_2Mi: 1200}, holdHugepagesUsed("alloc_used"))
	if c.memory != 1<<30 || c.hugepages[runtime.Hugepage2Mi] != 200 {
		t.Fatalf("commitment = %+v", c)
	}
}

// A new hold the host has no room for fails as resources-exhausted (the control plane re-places it);
// the holds already bound stay.
func TestAHoldTheHostCannotFitFailsAsResourcesExhausted(t *testing.T) {
	fakeHostMemory(t, 64, 0, nil) // 63 GiB of normal memory
	h := newHarness(t, nil)
	s, _ := h.open("gpus")
	gpus := fakehw.Inventory(1).Gpus.Gpus
	hold := func(id string, gpu int, memory uint64) *agentv1.DeviceAssignment {
		return &agentv1.DeviceAssignment{AllocationId: id, Binding: agentv1.Binding_BINDING_HOLD,
			Devices: []*agentv1.AssignedDevice{{Id: gpus[gpu].Uuid, DeviceClass: "gpu"}},
			Limits:  &agentv1.ResourceLimits{MemoryBytes: memory}}
	}
	s.push(desired(1, &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{Assignments: []*agentv1.DeviceAssignment{hold("alloc_a", 0, 40<<30)}}}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus().GetObservedGeneration() == 1 })
	if len(h.agent.holdCommitments()) != 1 {
		t.Fatalf("commitments = %v", h.agent.holdCommitments())
	}
	s.push(desired(2, &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{Assignments: []*agentv1.DeviceAssignment{
		hold("alloc_a", 0, 40<<30), hold("alloc_b", 1, 30<<30), hold("alloc_c", 2, 20<<30),
	}}}))
	failed := s.next(t, "AllocationFailed", func(f *agentv1.AgentFrame) bool {
		return f.GetEvents() != nil && f.GetEvents().GetEvents()[0].GetAllocationFailed() != nil
	}).GetEvents().GetEvents()[0].GetAllocationFailed()
	if failed.GetAllocationId() != "alloc_b" || failed.GetReason() != "resources-exhausted" || !strings.Contains(failed.GetMessage(), "30720 MiB of memory needed") {
		t.Fatalf("failed = %v", failed)
	}
	// alloc_c (20 GiB) still fits beside alloc_a and is bound.
	if _, err := os.Stat(h.host.Path("/etc/cdi/bcd-alloc_c.json")); err != nil {
		t.Fatalf("alloc_c not bound: %v", err)
	}
	if _, err := os.Stat(h.host.Path("/etc/cdi/bcd-alloc_b.json")); !os.IsNotExist(err) {
		t.Fatalf("alloc_b bound: %v", err)
	}
}
