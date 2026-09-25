package agent

import (
	"context"
	"encoding/json"
	"sort"
	"sync"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	driverv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1"
	"github.com/better-compute/better-compute/daemon/internal/bcx"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// kataPlugin is a runtime plugin speaking the RuntimeDriver contract over Invoke.
type kataPlugin struct {
	mu        sync.Mutex
	instances map[string]coreInstanceStatus
	applied   []coreInstanceSpec
	removed   []string
}

func (k *kataPlugin) Invoke(_ context.Context, req *driverv1.InvokeRequest, _ func(*driverv1.Progress)) (string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if req.GetKind() != "runtime" || req.GetDriverId() != "kata" {
		return "", &bcx.Error{Code: "unsupported", Message: req.GetKind()}
	}
	var args []json.RawMessage
	if err := json.Unmarshal([]byte(req.GetArgsJson()), &args); err != nil {
		return "", &bcx.Error{Code: "invalid-args", Message: err.Error()}
	}
	switch req.GetOperation() {
	case "list":
		out := []coreInstanceStatus{}
		for _, s := range k.instances {
			out = append(out, s)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
		raw, _ := json.Marshal(out)
		return string(raw), nil
	case "apply":
		var spec coreInstanceSpec
		if err := json.Unmarshal(args[0], &spec); err != nil {
			return "", &bcx.Error{Code: "invalid-args", Message: err.Error()}
		}
		k.applied = append(k.applied, spec)
		st := coreInstanceStatus{ID: spec.ID, State: spec.DesiredState, Addresses: []string{"10.0.0.9"}}
		if spec.Image == nil || spec.Image.Format != "raw" {
			st = coreInstanceStatus{ID: spec.ID, State: "error", Message: "kata boots raw images only"}
		}
		k.instances[spec.ID] = st
		raw, _ := json.Marshal(st)
		return string(raw), nil
	case "remove":
		var id string
		_ = json.Unmarshal(args[0], &id)
		delete(k.instances, id)
		k.removed = append(k.removed, id)
		return "null", nil
	}
	return "", &bcx.Error{Code: "unsupported", Message: req.GetOperation()}
}

func TestPluginRuntimeRunsInstances(t *testing.T) {
	kata := &kataPlugin{instances: map[string]coreInstanceStatus{}}
	h := newHarness(t, func(o *Options) {
		o.Drivers = []HostedDriver{{Manifest: &commonv1.DriverManifest{Id: "kata", Version: "1.2.0", Kinds: []string{"runtime"}}, Host: kata}}
		o.Runtimes = PluginRuntimes(o.Drivers, nil)
	})
	s, hello := h.open()
	kinds := 0
	for _, d := range hello.GetDrivers() {
		if d.GetId() == "kata" {
			kinds++
			if d.GetVersion() != "1.2.0" {
				t.Fatalf("kata advertised as %v", d)
			}
		}
	}
	if kinds != 1 {
		t.Fatalf("hello drivers = %v; want the plugin's manifest once", hello.GetDrivers())
	}

	running := agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING
	sbx := vm("inst_kata", running)
	sbx.Runtime = "kata"
	sbx.Image.Format = "raw"
	sbx.UserDataRef = "secret://t/ud"
	sbx.NetworkPolicy = agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_PRIVATE
	bad := vm("inst_qcow", running)
	bad.Runtime = "kata"
	s.push(desired(1, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{sbx, bad}}}))
	answerSecret(t, s, "#cloud-config\n")
	status := s.next(t, "status with the kata instances", func(f *agentv1.AgentFrame) bool {
		return f.GetStatus() != nil && len(f.GetStatus().GetInstances()) == 2
	}).GetStatus()
	got := instanceStates(status)
	if got["inst_kata"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING || got["inst_qcow"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR {
		t.Fatalf("instances = %v", status.GetInstances())
	}
	kata.mu.Lock()
	var first *coreInstanceSpec
	for i := range kata.applied {
		if kata.applied[i].ID == "inst_kata" {
			first = &kata.applied[i]
			break
		}
	}
	kata.mu.Unlock()
	if first == nil || first.UserData != "#cloud-config\n" || first.DesiredState != "running" || first.Flavor.MemoryGiB != 4 ||
		first.NetworkPolicy != "private" || first.Image.Sha256 != "0102" || first.AllocationID != "alloc_inst_kata" || len(first.Nics) != 1 {
		t.Fatalf("first apply = %+v", first)
	}

	// Paused, then dropped: applied with the new state (user data only once), then removed.
	sbx.DesiredState = agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_PAUSED
	s.push(desired(2, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{sbx}}}))
	s.next(t, "status paused", func(f *agentv1.AgentFrame) bool {
		return instanceStates(f.GetStatus())["inst_kata"] == agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_PAUSED
	})
	s.push(desired(3, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{}}))
	s.next(t, "status after removal", func(f *agentv1.AgentFrame) bool {
		return f.GetStatus().GetAppliedGeneration() == 3
	})
	kata.mu.Lock()
	defer kata.mu.Unlock()
	last := kata.applied[len(kata.applied)-1]
	if last.ID != "inst_kata" || last.DesiredState != "paused" || last.UserData != "" {
		t.Fatalf("last apply = %+v", last)
	}
	sort.Strings(kata.removed)
	if len(kata.removed) != 2 || kata.removed[0] != "inst_kata" || kata.removed[1] != "inst_qcow" {
		t.Fatalf("removed = %v", kata.removed)
	}
	// A plugin runtime never shadows a built-in one of the same name.
	builtin := &runtime.Fake{RuntimeName: "kata"}
	if rts := PluginRuntimes([]HostedDriver{{Manifest: &commonv1.DriverManifest{Id: "kata", Kinds: []string{"runtime"}}, Host: kata}}, []runtime.Runtime{builtin}); len(rts) != 0 {
		t.Fatalf("plugin runtimes = %v", rts)
	}
}
