package agent

import (
	"os"
	"slices"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"

	"github.com/better-compute/better-compute/daemon/internal/fakehw"
)

// A GPU host's Hello says it enforces DeviceAssignment.limits and serves Kubernetes bindings (§3.8):
// capacity books host resources and Kubernetes reservations only on a bcd that does. A host without
// GPUs claims neither.
func TestHelloAdvertisesDeviceCapabilities(t *testing.T) {
	h := newHarness(t, nil)
	_, hello := h.open()
	for _, want := range []string{DeviceLimitsCapability, KubernetesBindingCapability} {
		if !slices.Contains(hello.GetCapabilities(), want) {
			t.Fatalf("capabilities = %v, want %s", hello.GetCapabilities(), want)
		}
	}

	inv := fakehw.Inventory(1)
	inv.Gpus = nil
	none := newHarness(t, func(o *Options) { o.Host.(*fakeHost).inv = inv })
	_, hello = none.open()
	for _, unwanted := range []string{DeviceLimitsCapability, KubernetesBindingCapability} {
		if slices.Contains(hello.GetCapabilities(), unwanted) {
			t.Fatalf("a host without GPUs claims %s: %v", unwanted, hello.GetCapabilities())
		}
	}
}

// A bcd node without root and without [helper] cannot write /etc/cdi or create slices: it claims no
// GPU binding capability, and a hold that reaches it anyway fails at once (the control plane re-places
// it) instead of retrying every 30 s with "Access denied".
func TestAnUnprivilegedNodeTakesNoHolds(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Unprivileged = true })
	s, hello := h.open("gpus")
	for _, unwanted := range []string{"cdi", DeviceLimitsCapability, KubernetesBindingCapability} {
		if slices.Contains(hello.GetCapabilities(), unwanted) {
			t.Fatalf("an unprivileged node claims %s: %v", unwanted, hello.GetCapabilities())
		}
	}
	gpu := fakehw.Inventory(1).Gpus.Gpus[0].Uuid
	s.push(desired(1, &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{Assignments: []*agentv1.DeviceAssignment{{
		AllocationId: "alloc_u", Binding: agentv1.Binding_BINDING_HOLD,
		Devices: []*agentv1.AssignedDevice{{Id: gpu, DeviceClass: "gpu"}},
	}}}}))
	failed := s.next(t, "AllocationFailed", func(f *agentv1.AgentFrame) bool {
		return f.GetEvents() != nil && f.GetEvents().GetEvents()[0].GetAllocationFailed() != nil
	}).GetEvents().GetEvents()[0].GetAllocationFailed()
	if failed.GetAllocationId() != "alloc_u" || failed.GetReason() != "node-unprivileged" || !strings.Contains(failed.GetMessage(), "bcd helper") {
		t.Fatalf("failed = %v", failed)
	}
	if _, err := os.Stat(h.host.Path("/etc/cdi/bcd-alloc_u.json")); err == nil {
		t.Fatal("an unprivileged node wrote a CDI spec")
	}
}