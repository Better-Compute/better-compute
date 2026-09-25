package agent

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

func withPolicy(s *agentv1.InstanceSpec, p agentv1.InstanceNetworkPolicy) *agentv1.InstanceSpec {
	s.NetworkPolicy = p
	return s
}

func TestFirewallRuleset(t *testing.T) {
	running := agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING
	egress := vm("inst_egress", running)
	private := withPolicy(vm("inst_private", running), agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_PRIVATE)
	private.Nics[0].Addresses = []string{"10.0.0.6/24", "fd00::6/64"}
	none := withPolicy(vm("inst_none", running), agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_NONE)
	unaddressed := withPolicy(vm("inst_noipam", running), agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_NONE)
	unaddressed.Nics[0].Addresses = nil
	gone := withPolicy(vm("inst_gone", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_DELETED), agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_NONE)

	ruleset, failed := firewallRuleset([]*agentv1.InstanceSpec{none, egress, private, unaddressed, gone})
	if len(failed) != 1 || !strings.Contains(failed["inst_noipam"], "needs IPAM addresses") {
		t.Fatalf("failed = %v", failed)
	}
	if !strings.HasPrefix(ruleset, "table bridge bcd_instances\ndelete table bridge bcd_instances\ntable bridge bcd_instances {\n") {
		t.Fatalf("ruleset does not replace the table atomically:\n%s", ruleset)
	}
	tap := func(id string) string { return `"` + runtime.TapName(id, 0) + `"` }
	for _, want := range []string{
		// PRIVATE: its subnets (both families) and the metadata service; nothing else in or out.
		"iifname " + tap("inst_private") + " ip daddr { 10.0.0.0/24 } accept",
		"iifname " + tap("inst_private") + " ip daddr 169.254.169.254 accept",
		"iifname " + tap("inst_private") + " ip6 daddr { fd00::/64, fe80::/10, ff02::/16 } accept",
		"oifname " + tap("inst_private") + " ip saddr { 10.0.0.0/24 } accept",
		"iifname " + tap("inst_private") + " drop",
		"oifname " + tap("inst_private") + " drop",
		// NONE: DHCP, ARP, replies and the host's own connections from the subnet (the tunnel dial).
		"iifname " + tap("inst_none") + " udp sport 68 udp dport 67 accept",
		"iifname " + tap("inst_none") + " ct state established,related accept",
		"oifname " + tap("inst_none") + " ip saddr { 10.0.0.0/24 } accept",
		"iifname " + tap("inst_none") + " drop",
	} {
		if !strings.Contains(ruleset, want) {
			t.Errorf("ruleset lacks %q", want)
		}
	}
	// NONE reaches nothing but the host: no accept for its subnet on input or between ports.
	if strings.Contains(ruleset, "iifname "+tap("inst_none")+" ip daddr") {
		t.Errorf("a NONE instance may reach its subnet:\n%s", ruleset)
	}
	for _, id := range []string{"inst_noipam", "inst_gone"} {
		if strings.Contains(ruleset, tap(id)) {
			t.Errorf("%s has rules", id)
		}
	}
	// Every addressed NIC is guarded against spoofing, whatever its policy, before any accept.
	for _, want := range []string{
		"iifname " + tap("inst_egress") + " ether saddr != 52:54:00:00:00:01 drop",
		"iifname " + tap("inst_egress") + " ether type ip ip saddr != { 10.0.0.5, 0.0.0.0 } drop",
		"iifname " + tap("inst_egress") + " ether type arp arp saddr ip != { 10.0.0.5, 0.0.0.0 } drop",
		"iifname " + tap("inst_private") + " ether type ip6 ip6 saddr != { fd00::6, fe80::/10, :: } drop",
	} {
		if !strings.Contains(ruleset, want) {
			t.Errorf("ruleset lacks %q", want)
		}
	}
	if strings.Contains(ruleset, tap("inst_egress")+" drop\n") || strings.Contains(ruleset, "oifname "+tap("inst_egress")) {
		t.Errorf("an egress instance is restricted beyond anti-spoofing:\n%s", ruleset)
	}
	input := ruleset[strings.Index(ruleset, "chain input"):strings.Index(ruleset, "chain forward")]
	if strings.Index(input, "ether saddr != ") > strings.Index(input, " accept\n") {
		t.Errorf("an accept precedes the anti-spoofing rules:\n%s", input)
	}
	// A malformed MAC never reaches the ruleset.
	odd := vm("inst_odd", running)
	odd.Nics[0].Mac = `52:54:00:00:00:01" accept; drop "`
	if rs, _ := firewallRuleset([]*agentv1.InstanceSpec{odd}); strings.Contains(rs, "accept;") {
		t.Fatalf("the MAC was injected:\n%s", rs)
	}
	// Nothing addressed: the table is only removed.
	bare := vm("inst_bare", running)
	bare.Nics[0].Addresses = nil
	if empty, _ := firewallRuleset([]*agentv1.InstanceSpec{bare}); empty != "table bridge bcd_instances\ndelete table bridge bcd_instances\n" {
		t.Fatalf("empty ruleset = %q", empty)
	}
	if n := len(runtime.TapName("inst_"+strings.Repeat("x", 200), 99)); n > 15 {
		t.Fatalf("tap names are %d bytes, more than IFNAMSIZ allows", n)
	}
	nftSyntax(t, ruleset)
}

// nftSyntax parses a ruleset with nft in a throwaway network namespace when it can. Kernels without
// bridge nf_tables (WSL) refuse to load it, which is not a syntax error.
func nftSyntax(t *testing.T, ruleset string) {
	t.Helper()
	nft, err := exec.LookPath("nft")
	if err != nil {
		t.Log("nft not installed; syntax not checked")
		return
	}
	unshare, err := exec.LookPath("unshare")
	if err != nil {
		t.Log("unshare not installed; syntax not checked")
		return
	}
	file := filepath.Join(t.TempDir(), "rules.nft")
	_ = os.WriteFile(file, []byte(ruleset), 0o600)
	out, err := exec.Command(unshare, "-rn", nft, "-c", "-f", file).CombinedOutput()
	if err == nil {
		return
	}
	// Past the parser, nft only reports what the kernel refused (an errno: the family is not
	// supported, so the table never existed); any other error (syntax, conflicting protocols, bad
	// sets) is the ruleset's.
	kernel := []string{"Could not process rule", "Operation not supported", "No such file or directory"}
	for _, line := range strings.Split(string(out), "\n") {
		refused := false
		for _, k := range kernel {
			refused = refused || strings.Contains(line, k)
		}
		if strings.Contains(line, "Error:") && !refused {
			t.Fatalf("nft rejects the ruleset: %s\n%s\n%s", line, out, ruleset)
		}
	}
	t.Logf("nft parsed the ruleset; this kernel refused to load it (%v)", err)
}

func TestNetworkPoliciesAreEnforcedBeforeInstancesRun(t *testing.T) {
	var fake *runtime.Fake
	h := newHarness(t, func(o *Options) {
		fake = &runtime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}
		o.Runtimes = []runtime.Runtime{fake}
	})
	s, _ := h.open()
	running := agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING
	sandbox := withPolicy(vm("inst_sbx", running), agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_NONE)
	s.push(desired(1, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{sandbox}}}))
	status := s.next(t, "status with the sandbox", func(f *agentv1.AgentFrame) bool {
		return f.GetStatus().GetAppliedGeneration() == 1
	}).GetStatus()
	if instanceStates(status)["inst_sbx"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING {
		t.Fatalf("instances = %v", status.GetInstances())
	}
	h.host.mu.Lock()
	loaded := append([]string(nil), h.host.firewalls...)
	h.host.mu.Unlock()
	if len(loaded) != 1 || !strings.Contains(loaded[0], `iifname "`+runtime.TapName("inst_sbx", 0)+`" drop`) {
		t.Fatalf("rulesets loaded = %q", loaded)
	}

	// Rules that fail to load stop the instance (fail closed) and fail it; an unchanged ruleset is not
	// reloaded.
	h.host.mu.Lock()
	h.host.firewallErr = errors.New("nft: Operation not supported")
	h.host.mu.Unlock()
	private := withPolicy(vm("inst_sbx", running), agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_PRIVATE)
	s.push(desired(2, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{private}}}))
	status = s.next(t, "status after the failed load", func(f *agentv1.AgentFrame) bool {
		return f.GetStatus().GetAppliedGeneration() == 2 || instanceStates(f.GetStatus())["inst_sbx"] == agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR
	}).GetStatus()
	if instanceStates(status)["inst_sbx"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR {
		t.Fatalf("instances = %v", status.GetInstances())
	}
	domains, _ := fake.List(context.Background())
	for _, d := range domains {
		if d.ID == "inst_sbx" && d.State != runtime.StateStopped {
			t.Fatalf("an instance whose policy could not be loaded is %s", d.State)
		}
	}
	// Without the anti-spoofing rules the metadata service names no instance.
	if h.agent.spoofGuard.Load() {
		t.Fatal("the guard is on although the rules did not load")
	}
}
