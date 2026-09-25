package agent

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/helper"
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

	macless := withPolicy(vm("inst_nomac", running), agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_PRIVATE)
	macless.Nics[0].Mac = ""
	host := []string{"10.0.0.1", "fe80::1"}

	ruleset, failed, guarded := firewallRuleset([]*agentv1.InstanceSpec{none, egress, private, unaddressed, gone, macless}, host)
	if len(failed) != 2 || !strings.Contains(failed["inst_noipam"], "needs IPAM addresses") || !strings.Contains(failed["inst_nomac"], "needs the MAC") {
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
	if strings.Contains(ruleset, tap("inst_noipam")) {
		t.Error("inst_noipam has rules")
	}
	// A deleted instance keeps its guard (its domain may outlive a failed destroy), not its policy.
	if !strings.Contains(ruleset, "iifname "+tap("inst_gone")+" ether saddr != ") || strings.Contains(ruleset, "iifname "+tap("inst_gone")+" drop") {
		t.Errorf("inst_gone rules:\n%s", ruleset)
	}
	// Each guarded address belongs to its tap: nothing else on the bridge sends from it or claims it.
	for _, want := range []string{
		"ip saddr 10.0.0.6 iifname != " + tap("inst_private") + " drop",
		"ether type arp arp saddr ip 10.0.0.6 iifname != " + tap("inst_private") + " drop",
		"ip6 saddr fd00::6 iifname != " + tap("inst_private") + " drop",
		"icmpv6 type nd-neighbor-advert icmpv6 taddr fd00::6 iifname != " + tap("inst_private") + " drop",
		// Every instance tap, guarded or not: no DHCP server, no router, never the host.
		`iifname "bc*" udp sport { 67, 547 } drop`,
		`iifname "bc*" icmpv6 type { nd-router-advert, nd-redirect } drop`,
		`iifname "bc*" ip saddr 10.0.0.1 drop`,
		`iifname "bc*" ether type arp arp saddr ip 10.0.0.1 drop`,
		`iifname "bc*" icmpv6 type nd-neighbor-advert icmpv6 taddr fe80::1 drop`,
		// Its own EUI-64 link-local only, bound to its tap.
		"iifname " + tap("inst_private") + " icmpv6 type nd-neighbor-advert icmpv6 taddr != { fd00::6, fe80::5054:ff:fe00:1 } drop",
		"ip6 saddr fe80::5054:ff:fe00:1 iifname != " + tap("inst_private") + " drop",
	} {
		if !strings.Contains(ruleset, want) {
			t.Errorf("ruleset lacks %q", want)
		}
	}
	if guarded["10.0.0.6"] != "inst_private" || guarded["fd00::6"] != "inst_private" || guarded["10.0.0.5"] == "" {
		t.Errorf("guarded = %v", guarded)
	}
	// Every addressed NIC is guarded against spoofing, whatever its policy, before any accept.
	for _, want := range []string{
		"iifname " + tap("inst_egress") + " ether saddr != 52:54:00:00:00:01 drop",
		"iifname " + tap("inst_egress") + " ether type ip ip saddr != { 10.0.0.5, 0.0.0.0 } drop",
		"iifname " + tap("inst_egress") + " ether type arp arp saddr ip != { 10.0.0.5, 0.0.0.0 } drop",
		"iifname " + tap("inst_private") + " ether type ip6 ip6 saddr != { fd00::6, fe80::5054:ff:fe00:1, :: } drop",
	} {
		if !strings.Contains(ruleset, want) {
			t.Errorf("ruleset lacks %q", want)
		}
	}
	if strings.Contains(ruleset, "iifname "+tap("inst_egress")+" drop\n") || strings.Contains(ruleset, "oifname "+tap("inst_egress")) {
		t.Errorf("an egress instance is restricted beyond anti-spoofing:\n%s", ruleset)
	}
	input := ruleset[strings.Index(ruleset, "chain input"):strings.Index(ruleset, "chain forward")]
	if strings.Index(input, "ether saddr != ") > strings.Index(input, " accept\n") {
		t.Errorf("an accept precedes the anti-spoofing rules:\n%s", input)
	}
	// A malformed MAC never reaches the ruleset.
	odd := vm("inst_odd", running)
	odd.Nics[0].Mac = `52:54:00:00:00:01" accept; drop "`
	if rs, _, g := firewallRuleset([]*agentv1.InstanceSpec{odd}, nil); strings.Contains(rs, `accept; drop`) || strings.Contains(rs, "52:54:00:00:00:01") || len(g) != 0 {
		t.Fatalf("the MAC was injected:\n%s", rs)
	}
	// An unguarded NIC (no IPAM addresses) still gets the rules every tap has; no instance: the table
	// is only removed.
	bare := vm("inst_bare", running)
	bare.Nics[0].Addresses = nil
	if rs, _, _ := firewallRuleset([]*agentv1.InstanceSpec{bare}, host); !strings.Contains(rs, `iifname "bc*" udp sport { 67, 547 } drop`) || strings.Contains(rs, tap("inst_bare")) {
		t.Fatalf("unguarded ruleset = %q", rs)
	}
	if empty, _, _ := firewallRuleset(nil, host); empty != "table bridge bcd_instances\ndelete table bridge bcd_instances\ntable inet bcd_taps\ndelete table inet bcd_taps\ntable arp bcd_taps\ndelete table arp bcd_taps\n" {
		t.Fatalf("empty ruleset = %q", empty)
	}
	// Security review 12 H1: a tap off its bridge reaches neither the host nor, forwarded, anything.
	backstop := ruleset[strings.Index(ruleset, "table inet bcd_taps {"):]
	for _, want := range []string{"hook input priority filter; policy accept;\n\t\tiifname \"bc*\" drop", "hook forward priority filter; policy accept;\n\t\tiifname \"bc*\" drop\n\t\toifname \"bc*\" drop",
		"hook output priority filter; policy accept;\n\t\toifname \"bc*\" drop", "table arp bcd_taps {\n\tchain input"} {
		if !strings.Contains(backstop, want) {
			t.Fatalf("the backstop lacks %q:\n%s", want, backstop)
		}
	}
	if err := helper.CheckRuleset(ruleset); err != nil {
		t.Fatalf("the helper refuses bcd's ruleset: %v", err)
	}
	// A bridge named like the taps fails its instance.
	odd2 := vm("inst_bcbridge", running)
	odd2.Nics[0].Network = "bcbr0"
	if rs, failed, _ := firewallRuleset([]*agentv1.InstanceSpec{odd2}, host); failed["inst_bcbridge"] == "" || strings.Contains(rs, tap("inst_bcbridge")) {
		t.Fatalf("a bc* bridge: %v", failed)
	}
	if ll := eui64(net.HardwareAddr{0x52, 0x54, 0x00, 0x00, 0x00, 0x01}); ll != "fe80::5054:ff:fe00:1" {
		t.Fatalf("eui64 = %s", ll)
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

// An external "flush ruleset" takes bcd's table away: trust in addresses ends at once, and the next
// pass loads the table again.
func TestFirewallReloadsAfterAFlush(t *testing.T) {
	h := newHarness(t, func(o *Options) {
		o.Runtimes = []runtime.Runtime{&runtime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}}
	})
	s, _ := h.open()
	web := vm("inst_web", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	s.push(desired(1, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web}}}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus().GetAppliedGeneration() == 1 })
	loads := func() int {
		h.host.mu.Lock()
		defer h.host.mu.Unlock()
		return len(h.host.firewalls)
	}
	if !h.agent.spoofGuard.Load() || loads() != 1 {
		t.Fatalf("guard %v after %d loads", h.agent.spoofGuard.Load(), loads())
	}
	h.host.mu.Lock()
	h.host.firewallGone = true
	h.host.mu.Unlock()
	// The check reloads the table itself (not a converge pass) and trusts addresses again after.
	h.agent.checkFirewall(context.Background())
	if loads() != 2 || !h.agent.spoofGuard.Load() {
		t.Fatalf("after the check: %d loads, guard %v", loads(), h.agent.spoofGuard.Load())
	}
	// A reload that fails leaves addresses untrusted, and the next pass tries again.
	h.host.mu.Lock()
	h.host.firewallErr = errors.New("nft: busy")
	h.host.mu.Unlock()
	h.agent.checkFirewall(context.Background())
	if h.agent.spoofGuard.Load() {
		t.Fatal("addresses stayed trusted without the table")
	}
	h.host.mu.Lock()
	h.host.firewallGone, h.host.firewallErr = false, nil
	h.host.mu.Unlock()
	deadline := time.Now().Add(5 * time.Second)
	for loads() < 3 || !h.agent.spoofGuard.Load() {
		if time.Now().After(deadline) {
			t.Fatalf("the table was not loaded again (%d loads)", loads())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if countRules("chain input {\n\t\ttype filter hook input priority filter; policy accept;\n\t\tiifname \"x\" drop\n\t\tip saddr 1.2.3.4 accept\n\t}") != 2 {
		t.Fatal("countRules")
	}
}
