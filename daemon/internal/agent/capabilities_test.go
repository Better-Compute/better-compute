package agent

import (
	"slices"
	"testing"

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
