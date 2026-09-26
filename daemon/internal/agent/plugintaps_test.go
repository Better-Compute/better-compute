package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

func TestPluginRuntimesAreToldWhatBcdEnforces(t *testing.T) {
	spec := &agentv1.InstanceSpec{
		InstanceId: "inst_p", Runtime: "firecracker", Vcpu: 2, MemoryBytes: 2 << 30,
		Nics:              []*agentv1.InstanceNic{{Network: "br0", Mac: "52:54:00:00:00:09"}},
		NetworkPolicy:     agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_NONE,
		SshFromHostOnly:   true,
		IdentityRebindRef: "secret://acme/rebind-1",
		Placement:         &agentv1.InstancePlacement{Cpus: "4-5", Mems: "0"},
	}
	raw, _ := json.Marshal(coreSpecOf(spec))
	out := string(raw)
	for _, want := range []string{
		`"tap":"` + runtime.TapName("inst_p", 0) + `"`, `"networkPolicy":"none"`, `"sshFromHostOnly":true`,
		`"identityRebindRef":"secret://acme/rebind-1"`, `"placement":{"cpus":"4-5","mems":"0"}`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("core spec lacks %s: %s", want, out)
		}
	}
	if !tapRulesApply(spec) {
		t.Fatal("a none-network, host-only-SSH instance needs its taps named")
	}
	spec.NetworkPolicy, spec.SshFromHostOnly = agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_EGRESS, false
	if tapRulesApply(spec) {
		t.Fatal("an egress instance without host-only SSH has no tap rules")
	}
}

func TestMissingTapsAreTheOnesNotUnderBcdsNames(t *testing.T) {
	root := t.TempDir()
	a := &Agent{host: &fakeHost{root: root}}
	spec := &agentv1.InstanceSpec{InstanceId: "inst_p", Nics: []*agentv1.InstanceNic{{}, {}}}
	first := runtime.TapName("inst_p", 0)
	if err := os.MkdirAll(filepath.Join(root, "sys", "class", "net", first), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := a.missingTaps(spec); len(got) != 1 || got[0] != runtime.TapName("inst_p", 1) {
		t.Fatalf("missing = %v", got)
	}
}

func TestAPluginThatIgnoresItsTapNamesIsStopped(t *testing.T) {
	kata := &kataPlugin{instances: map[string]coreInstanceStatus{}} // creates no taps
	h := newHarness(t, func(o *Options) {
		o.Drivers = []HostedDriver{{Manifest: &commonv1.DriverManifest{Id: "kata", Version: "1.2.0", Kinds: []string{"runtime"}}, Host: kata}}
		o.Runtimes = PluginRuntimes(o.Drivers, nil)
	})
	s, _ := h.open()
	sbx := vm("inst_kata", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	sbx.Runtime, sbx.Image.Format, sbx.UserDataRef = "kata", "raw", "secret://t/ud"
	sbx.NetworkPolicy = agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_NONE
	s.push(desired(1, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{sbx}}}))
	answerSecret(t, s, "#cloud-config\n")
	status := s.next(t, "status with the refused instance", func(f *agentv1.AgentFrame) bool {
		return f.GetStatus() != nil && len(f.GetStatus().GetInstances()) == 1 &&
			f.GetStatus().GetInstances()[0].GetState() == agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR
	}).GetStatus()
	if msg := status.GetInstances()[0].GetMessage(); !strings.Contains(msg, "did not create taps") {
		t.Fatalf("message = %q", msg)
	}
	kata.mu.Lock()
	defer kata.mu.Unlock()
	if kata.instances["inst_kata"].State != "stopped" {
		t.Fatalf("the instance kept running without its rules: %v", kata.instances["inst_kata"])
	}
}
