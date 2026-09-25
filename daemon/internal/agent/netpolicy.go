package agent

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strings"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// Instance network policies (InstanceSpec.network_policy, PLAN.md §3.7) as host nftables rules on
// the instances' taps, whatever the runtime:
//   - EGRESS (and UNSPECIFIED): no rules, anything the pool's network allows;
//   - PRIVATE: the NIC's IPAM subnets and the host (including its metadata service), nothing routed
//     beyond them and nothing from outside them;
//   - NONE: the host only: DHCP, ARP, replies, and connections the host opens from its address on the
//     subnet (bcd's tunnel dial); no other instance, nothing routed.
//
// Every tap whose NIC has a MAC and IPAM addresses is also guarded against spoofing, whatever its
// policy: frames must carry the NIC's MAC, IP packets its own addresses (0.0.0.0 and :: for DHCP,
// link-local for IPv6 neighbour discovery) and ARP its own IPv4 addresses. The metadata service and
// instance tunnels name an instance by its address, so another instance must never claim it.
//
// The rules live in one bridge-family table that bcd owns and replaces in a single transaction. The
// bridge family sees every frame of a tap: input (to the host, including what the host would route
// onwards), forward (to another port of the bridge) and output (from the host). Taps are matched by
// name (runtime.TapName), so the rules exist before a runtime creates the tap.

// NetworkPolicyCapability (Hello.capabilities) says this bcd enforces InstanceSpec.network_policy:
// an older one drops the field as unknown, so a private or none instance must never be placed there.
const NetworkPolicyCapability = "instance.network-policy"

// firewallTable is the nftables table bcd owns.
const firewallTable = "bcd_instances"

// backstopTable is bcd's inet table: instance taps that are not bridge ports reach nothing.
const backstopTable = "bcd_taps"

// policyEnforced reports whether a policy needs rules.
func policyEnforced(p agentv1.InstanceNetworkPolicy) bool {
	return p == agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_PRIVATE || p == agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_NONE
}

// eui64 is the EUI-64 link-local address of a MAC (RFC 4291): the only link-local a guarded NIC may
// use, so no instance can answer for a neighbour's or the host's.
func eui64(mac net.HardwareAddr) string {
	ip := make(net.IP, 16)
	ip[0], ip[1] = 0xfe, 0x80
	copy(ip[8:11], mac[0:3])
	ip[8] ^= 0x02
	ip[11], ip[12] = 0xff, 0xfe
	copy(ip[13:16], mac[3:6])
	return ip.String()
}

// firewallRuleset renders the table for specs. Instances whose policy cannot be enforced (a NIC
// without IPAM addresses or a MAC) are left out and returned in failed: they must not run. guarded
// maps each address the rules bind to its instance's tap (address → instance id): only those may
// name an instance to the metadata service or an instance tunnel. host are the host's own addresses
// on the instances' bridges: no tap may send from them or claim them.
func firewallRuleset(specs []*agentv1.InstanceSpec, host []string) (ruleset string, failed map[string]string, guarded map[string]string) {
	failed, guarded = map[string]string{}, map[string]string{}
	var claims, guard, input, forward, output, sshForward, sshOutput []string
	anyNIC := false
	sorted := append([]*agentv1.InstanceSpec(nil), specs...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].GetInstanceId() < sorted[j].GetInstanceId() })
	for _, spec := range sorted {
		// A deleted instance keeps its guard until its domain is gone (a destroy can fail); its policy
		// no longer matters.
		deleted := spec.GetDesiredState() == agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_DELETED
		policy := spec.GetNetworkPolicy()
		enforced := policyEnforced(policy) && !deleted
		type nicRules struct {
			tap            string
			v4, v6         []string // subnets
			hosts4, hosts6 []string // the NIC's own addresses
		}
		var nics []nicRules
		var problem string
		// A bridge named like a tap ("bc…") would match every tap rule and the backstop's drops.
		for i, nic := range spec.GetNics() {
			if strings.HasPrefix(nic.GetNetwork(), "bc") && !deleted {
				problem = fmt.Sprintf("NIC %d's network %q is named like bcd's taps (bc…)", i, nic.GetNetwork())
			}
		}
		if problem != "" {
			failed[spec.GetInstanceId()] = problem
			continue
		}
		for i, nic := range spec.GetNics() {
			anyNIC = true
			r := nicRules{tap: runtime.TapName(spec.GetInstanceId(), i)}
			for _, a := range nic.GetAddresses() {
				p, err := netip.ParsePrefix(a)
				if err != nil {
					problem = fmt.Sprintf("network policy: NIC %d address %q is not in CIDR form", i, a)
					break
				}
				if p.Addr().Is4() {
					r.v4, r.hosts4 = append(r.v4, p.Masked().String()), append(r.hosts4, p.Addr().String())
				} else {
					r.v6, r.hosts6 = append(r.v6, p.Masked().String()), append(r.hosts6, p.Addr().String())
				}
			}
			if problem == "" && len(r.v4)+len(r.v6) == 0 {
				problem = fmt.Sprintf("network policy %s needs IPAM addresses on NIC %d", policyName(policy), i)
			}
			mac, macErr := net.ParseMAC(nic.GetMac())
			if problem == "" && (macErr != nil || len(mac) != 6) {
				problem = fmt.Sprintf("network policy %s needs the MAC of NIC %d", policyName(policy), i)
			}
			if problem != "" {
				if enforced {
					break
				}
				problem = "" // an egress NIC without IPAM addresses is not guarded
				continue
			}
			// The MAC goes into the ruleset: only a well-formed one (an egress NIC without one is not
			// guarded; an enforced one failed above).
			if macErr == nil && len(mac) == 6 {
				in := fmt.Sprintf("iifname %q", r.tap)
				ll := eui64(mac)
				guard = append(guard,
					// Its own MAC and addresses only (0.0.0.0 and :: for DHCP, its own EUI-64 link-local
					// for NDP).
					in+" ether saddr != "+mac.String()+" drop",
					in+" ether type ip ip saddr != "+set(append(r.hosts4, "0.0.0.0"))+" drop",
					in+" ether type arp arp saddr ip != "+set(append(r.hosts4, "0.0.0.0"))+" drop",
					in+" ether type ip6 ip6 saddr != "+set(append(r.hosts6, ll, "::"))+" drop",
					// Neighbour adverts only for its own addresses.
					in+" icmpv6 type nd-neighbor-advert icmpv6 taddr != "+set(append(r.hosts6, ll))+" drop")
				r.hosts6 = append(r.hosts6, ll)
				// Its addresses belong to its tap: no other port of the bridge (another tap, bcd's or
				// not, an uplink) may send from them or claim them in ARP or NDP.
				tap := fmt.Sprintf("iifname != %q", r.tap)
				for _, a := range r.hosts4 {
					claims = append(claims, "ip saddr "+a+" "+tap+" drop", "ether type arp arp saddr ip "+a+" "+tap+" drop")
					guarded[a] = spec.GetInstanceId()
				}
				for _, a := range r.hosts6 {
					claims = append(claims, "ip6 saddr "+a+" "+tap+" drop", "icmpv6 type nd-neighbor-advert icmpv6 taddr "+a+" "+tap+" drop")
					guarded[a] = spec.GetInstanceId()
				}
			}
			nics = append(nics, r)
		}
		if problem != "" {
			failed[spec.GetInstanceId()] = problem
			continue
		}
		// ssh_from_host_only (sandboxes, review 13 L5): tcp/22 into the guest only from the host's own
		// bridge addresses (bcd's tunnel dial), whatever the policy: an exec certificate is usable only
		// through a tunnel, which the control plane closes on revocation.
		if spec.GetSshFromHostOnly() && !deleted {
			for i := range spec.GetNics() {
				out := fmt.Sprintf("oifname %q", runtime.TapName(spec.GetInstanceId(), i))
				sshForward = append(sshForward, out+" tcp dport 22 drop")
				sshOutput = append(sshOutput, hostOnlySSH(out, host)...)
			}
		}
		if !enforced {
			continue
		}
		none := policy == agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_NONE
		for _, n := range nics {
			in, out := fmt.Sprintf("iifname %q", n.tap), fmt.Sprintf("oifname %q", n.tap)
			v4, v6 := set(n.v4), set(append(n.v6, "fe80::/10"))
			// To the host: ARP, DHCP and replies always.
			input = append(input,
				in+" ether type arp accept",
				in+" udp sport 68 udp dport 67 accept",
				in+" ct state established,related accept")
			// From the host: ARP, DHCP answers, replies, and what the host opens from the subnet.
			output = append(output,
				out+" ether type arp accept",
				out+" udp sport 67 udp dport 68 accept",
				out+" ct state established,related accept")
			if len(n.v4) > 0 {
				output = append(output, out+" ip saddr "+v4+" accept")
			}
			output = append(output, out+" ip6 saddr "+v6+" accept")
			if none {
				input = append(input, in+" drop")
				forward = append(forward, in+" drop", out+" drop")
				output = append(output, out+" drop")
				continue
			}
			// PRIVATE: the subnets (the host's address on them included) and the metadata service.
			if len(n.v4) > 0 {
				input = append(input, in+" ip daddr "+v4+" accept")
				forward = append(forward, in+" ip daddr "+v4+" accept", out+" ip saddr "+v4+" accept")
			}
			input = append(input,
				in+" ip daddr 169.254.169.254 accept",
				in+" ip6 daddr "+set(append(n.v6, "fe80::/10", "ff02::/16"))+" accept",
				in+" drop")
			forward = append(forward,
				in+" ether type arp accept",
				out+" ether type arp accept",
				in+" ip6 daddr "+set(append(n.v6, "fe80::/10", "ff02::/16"))+" accept",
				out+" ip6 saddr "+v6+" accept",
				in+" drop", out+" drop")
			output = append(output, out+" drop")
		}
	}
	var b strings.Builder
	// Declaring the table first makes the delete succeed when it does not exist yet; the file is one
	// transaction, so the old rules are replaced atomically.
	fmt.Fprintf(&b, "table bridge %s\ndelete table bridge %s\n", firewallTable, firewallTable)
	// Every instance tap, guarded or not: never a DHCP server or a router, and never the host (its
	// addresses on the bridges belong to the host).
	var taps []string
	if anyNIC {
		taps = append(taps,
			`iifname "bc*" udp sport { 67, 547 } drop`,
			`iifname "bc*" icmpv6 type { nd-router-advert, nd-redirect } drop`)
		for _, a := range host {
			ip := net.ParseIP(a)
			switch {
			case ip == nil:
			case ip.To4() != nil:
				taps = append(taps, `iifname "bc*" ip saddr `+a+` drop`, `iifname "bc*" ether type arp arp saddr ip `+a+` drop`)
			default:
				taps = append(taps, `iifname "bc*" ip6 saddr `+a+` drop`, `iifname "bc*" icmpv6 type nd-neighbor-advert icmpv6 taddr `+a+` drop`)
			}
		}
	}
	// Spoofed frames are dropped before any policy accepts them.
	first := append(append(append([]string{}, taps...), claims...), guard...)
	input = append(append([]string{}, first...), input...)
	forward = append(append(append([]string{}, first...), sshForward...), forward...)
	output = append(append([]string{}, sshOutput...), output...)
	if len(input)+len(forward)+len(output) > 0 {
		fmt.Fprintf(&b, "table bridge %s {\n", firewallTable)
		chain := func(name string, rules []string) {
			fmt.Fprintf(&b, "\tchain %s {\n\t\ttype filter hook %s priority filter; policy accept;\n", name, name)
			for _, r := range rules {
				fmt.Fprintf(&b, "\t\t%s\n", r)
			}
			b.WriteString("\t}\n")
		}
		chain("input", input)
		chain("forward", forward)
		chain("output", output)
		b.WriteString("}\n")
	}
	// The backstop (security review 12 H1): the bridge table sees only taps that are bridge ports; a
	// tap off its bridge (a runtime that recreated it, a failed attach) would reach the host's stack,
	// and through forwarding other networks, unfiltered. Frames of a tap on its bridge reach the inet
	// hooks as the bridge's, so these rules drop only what the bridge table cannot see.
	// The arp table does the same for ARP, which the inet hooks never see.
	fmt.Fprintf(&b, "table inet %s\ndelete table inet %s\n", backstopTable, backstopTable)
	fmt.Fprintf(&b, "table arp %s\ndelete table arp %s\n", backstopTable, backstopTable)
	if anyNIC {
		fmt.Fprintf(&b, "table inet %s {\n", backstopTable)
		fmt.Fprintf(&b, "\tchain input {\n\t\ttype filter hook input priority filter; policy accept;\n\t\tiifname \"bc*\" drop\n\t}\n")
		fmt.Fprintf(&b, "\tchain forward {\n\t\ttype filter hook forward priority filter; policy accept;\n\t\tiifname \"bc*\" drop\n\t\toifname \"bc*\" drop\n\t}\n")
		fmt.Fprintf(&b, "\tchain output {\n\t\ttype filter hook output priority filter; policy accept;\n\t\toifname \"bc*\" drop\n\t}\n")
		b.WriteString("}\n")
		fmt.Fprintf(&b, "table arp %s {\n", backstopTable)
		fmt.Fprintf(&b, "\tchain input {\n\t\ttype filter hook input priority filter; policy accept;\n\t\tiifname \"bc*\" drop\n\t}\n")
		fmt.Fprintf(&b, "\tchain output {\n\t\ttype filter hook output priority filter; policy accept;\n\t\toifname \"bc*\" drop\n\t}\n")
		b.WriteString("}\n")
	}
	return b.String(), failed, guarded
}

// hostOnlySSH drops tcp/22 out of the bridge into a tap unless the host's own address sent it.
func hostOnlySSH(out string, host []string) []string {
	var v4, v6 []string
	for _, a := range host {
		if ip := net.ParseIP(a); ip != nil && ip.To4() != nil {
			v4 = append(v4, a)
		} else if ip != nil {
			v6 = append(v6, a)
		}
	}
	rule := func(family, saddr string, addrs []string) string {
		if len(addrs) == 0 {
			return out + " ether type " + family + " tcp dport 22 drop"
		}
		return out + " ether type " + family + " tcp dport 22 " + saddr + " != " + set(addrs) + " drop"
	}
	return []string{rule("ip", "ip saddr", v4), rule("ip6", "ip6 saddr", v6)}
}

func set(items []string) string { return "{ " + strings.Join(items, ", ") + " }" }

func policyName(p agentv1.InstanceNetworkPolicy) string {
	return strings.ToLower(strings.TrimPrefix(p.String(), "INSTANCE_NETWORK_POLICY_"))
}

// firewallCheckEvery is how often bcd verifies its table is still loaded as it wrote it.
const firewallCheckEvery = 5 * time.Second

// countRules counts the rules of a ruleset bcd rendered (every chain line but its header).
func countRules(ruleset string) int {
	n := 0
	for _, line := range strings.Split(ruleset, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasSuffix(line, " drop") || strings.HasSuffix(line, " accept") {
			n++
		}
	}
	return n
}

// firewallLoop notices when bcd's table is gone or emptied (an nftables reload, "flush ruleset",
// "flush table", a flushed chain): the metadata service and instance dials stop trusting addresses
// at once, and the table is loaded again right here, outside any converge pass.
func (a *Agent) firewallLoop(ctx context.Context) {
	t := time.NewTicker(firewallCheckEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.checkFirewall(ctx)
		}
	}
}

func (a *Agent) checkFirewall(ctx context.Context) {
	last := a.lastFirewall.Load()
	if !a.tableLoaded.Load() || last == nil {
		return
	}
	err := a.host.CheckFirewall(ctx, countRules(*last))
	if err == nil {
		return
	}
	a.log.Warn("the instance firewall is not as bcd loaded it; loading it again", "error", err.Error())
	a.spoofGuard.Store(false)
	if err := a.host.ApplyFirewall(ctx, *last); err != nil {
		// The next converge pass tries again (and fails the policy-bearing instances meanwhile).
		a.log.Error("reloading the instance firewall failed", "error", err.Error())
		a.tableLoaded.Store(false)
		a.instances.stale.Store(true)
		a.triggerConverge()
		return
	}
	a.spoofGuard.Store(true)
}

// bridgeAddrs are the host's own addresses on the bridges the instances' NICs attach to (tests
// replace it).
var bridgeAddrs = func(specs []*agentv1.InstanceSpec) []string {
	seen := map[string]bool{}
	var out []string
	for _, spec := range specs {
		for _, nic := range spec.GetNics() {
			if seen[nic.GetNetwork()] {
				continue
			}
			seen[nic.GetNetwork()] = true
			iface, err := net.InterfaceByName(nic.GetNetwork())
			if err != nil {
				continue
			}
			addrs, _ := iface.Addrs()
			for _, a := range addrs {
				if ipn, ok := a.(*net.IPNet); ok {
					out = append(out, ipn.IP.String())
				}
			}
		}
	}
	sort.Strings(out)
	return out
}
