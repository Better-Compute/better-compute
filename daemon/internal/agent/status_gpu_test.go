package agent

import (
	"context"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"github.com/better-compute/better-compute/daemon/internal/nvml"
)

// bcd status shows every GPU with its live reading, what holds it, and the OTLP export.
func TestStatusShowsGPUsHoldsAndTelemetry(t *testing.T) {
	h := newHarness(t, func(o *Options) {
		o.GPUSampler = func(context.Context) (*nvml.Snapshot, error) {
			return fakehw.GPUSnapshot(1, time.Unix(1_800_000_000, 0)), nil
		}
	})
	s, _ := h.open()
	gpus := fakehw.Inventory(1).Gpus.Gpus
	s.push(desired(1, &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{Assignments: []*agentv1.DeviceAssignment{{
		AllocationId: "alloc_1", Binding: agentv1.Binding_BINDING_HOLD, Devices: []*agentv1.AssignedDevice{{Id: gpus[1].Uuid}},
	}}}}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus().GetAppliedGeneration() == 1 })

	st := h.agent.Status()
	if len(st.GPUs) != len(gpus) {
		t.Fatalf("gpus = %d", len(st.GPUs))
	}
	g := st.GPUs[1]
	want := fakehw.GPUSnapshot(1, time.Unix(1_800_000_000, 0)).Samples[1]
	if g.UUID != gpus[1].Uuid || g.Held != "alloc_1" || !g.Healthy || g.UtilizationPct != want.UtilizationGPU || g.MemoryUsed != want.MemoryUsed || g.PowerLimitW != 700 {
		t.Fatalf("gpu 1 = %+v", g)
	}
	if st.GPUs[0].Held != "" {
		t.Fatalf("gpu 0 = %+v", st.GPUs[0])
	}
	if st.Kubernetes != nil || st.Telemetry != nil {
		t.Fatalf("kubernetes %+v telemetry %+v", st.Kubernetes, st.Telemetry)
	}
	// An export with no collector behind it shows its failure.
	s.push(desired(2, &agentv1.NodeSpec{Telemetry: &agentv1.TelemetrySection{OtlpEndpoint: "http://127.0.0.1:1", ExportIntervalMs: 5000}}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus().GetAppliedGeneration() == 2 })
	deadline := time.Now().Add(10 * time.Second)
	for {
		st = h.agent.Status()
		if st.Telemetry != nil && st.Telemetry.LastError != "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("telemetry = %+v", st.Telemetry)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if st.Telemetry.Endpoint != "http://127.0.0.1:1" || !st.Telemetry.LastExport.IsZero() {
		t.Fatalf("telemetry = %+v", st.Telemetry)
	}
}
