package agent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"github.com/better-compute/better-compute/daemon/internal/nvml"
)

// NodeSpec.telemetry starts the OTLP export of bcd.gpu.* (nvidia-smi samples plus the inventory's
// counters), with the node's identity as resource attributes; an empty section stops it.
func TestTelemetryExportsGPUMetrics(t *testing.T) {
	posts := make(chan map[string]any, 16)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/metrics" {
			t.Errorf("path %s", r.URL.Path)
		}
		var body map[string]any
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		posts <- body
	}))
	defer srv.Close()
	h := newHarness(t, func(o *Options) {
		o.GPUSampler = func(context.Context) (*nvml.Snapshot, error) {
			return fakehw.GPUSnapshot(1, time.Unix(1_800_000_000, 0)), nil
		}
	})
	s, _ := h.open()
	s.push(desired(1, &agentv1.NodeSpec{Telemetry: &agentv1.TelemetrySection{
		OtlpEndpoint: srv.URL, ExportIntervalMs: 5000, ResourceAttributes: []string{"deployment.environment=test"},
	}}))
	var body map[string]any
	select {
	case body = <-posts:
	case <-time.After(10 * time.Second):
		t.Fatal("no export")
	}
	rm := body["resourceMetrics"].([]any)[0].(map[string]any)
	resource := map[string]string{}
	for _, a := range rm["resource"].(map[string]any)["attributes"].([]any) {
		kv := a.(map[string]any)
		resource[kv["key"].(string)] = kv["value"].(map[string]any)["stringValue"].(string)
	}
	if resource["bcd.node.id"] != testNode || resource["service.name"] != "bcd" || resource["deployment.environment"] != "test" || resource["bcd.site.id"] != "site_1" {
		t.Fatalf("resource = %v", resource)
	}
	names := map[string]int{}
	for _, m := range rm["scopeMetrics"].([]any)[0].(map[string]any)["metrics"].([]any) {
		metric := m.(map[string]any)
		points := 0
		for _, kind := range []string{"gauge", "sum"} {
			if g, ok := metric[kind].(map[string]any); ok {
				points = len(g["dataPoints"].([]any))
			}
		}
		names[metric["name"].(string)] = points
	}
	gpus := len(fakehw.Inventory(1).Gpus.Gpus)
	for _, name := range []string{"bcd.gpu.memory.used", "bcd.gpu.utilization", "bcd.gpu.temperature", "bcd.gpu.power.draw", "bcd.gpu.xid.active"} {
		if names[name] != gpus {
			t.Fatalf("%s has %d points, want %d (metrics %v)", name, names[name], gpus, names)
		}
	}

	// A section without an endpoint stops the export.
	s.push(desired(2, &agentv1.NodeSpec{Telemetry: &agentv1.TelemetrySection{}}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus().GetAppliedGeneration() == 2 })
	h.agent.telemetry.mu.Lock()
	running := h.agent.telemetry.cancel != nil
	h.agent.telemetry.mu.Unlock()
	if running {
		t.Fatal("the exporter kept running without an endpoint")
	}

	// A bad endpoint is a terminal section failure, not a crash.
	s.push(desired(3, &agentv1.NodeSpec{Telemetry: &agentv1.TelemetrySection{OtlpEndpoint: "ftp://x"}}))
	st := s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus().GetAppliedGeneration() == 3 }).GetStatus()
	for _, sec := range st.GetSections() {
		if sec.GetSection() == "telemetry" && sec.GetState() != agentv1.SectionState_SECTION_STATE_FAILED {
			t.Fatalf("telemetry section = %v", sec)
		}
	}
}
