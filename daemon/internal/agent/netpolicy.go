package agent

import (
	"fmt"
	"net/netip"
	"sort"
	"strings"

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
// The rules live in one bridge-family table that bcd owns and replaces in a single transaction. The
// bridge family sees every frame of a tap: input (to the host, including what the host would route
// onwards), forward (to another port of the bridge) and output (from the host). Taps are matched by
// name (runtime.TapName), so the rules exist before a runtime creates the tap.

// NetworkPolicyCapability (Hello.capabilities) says this bcd enforces InstanceSpec.network_policy:
// an older one drops the field as unknown, so a private or none instance must never be placed there.
const NetworkPolicyCapability = "instance.network-policy"

// firewallTable is the nftables table bcd owns.
const firewallTable = "bcd_instances"

// policyEnforced reports whether a policy needs rules.
func policyEnforced(p agentv1.InstanceNetworkPolicy) bool {
	return p == agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_PRIVATE || p == agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_NONE
}

// firewallRuleset renders the table for specs. Instances whose policy cannot be enforced (a NIC
// without IPAM addresses) are left out and returned in failed: they must not run.
func firewallRuleset(specs []*agentv1.InstanceSpec) (ruleset string, failed map[string]string) {
	failed = map[string]string{}
	var input, forward, output []string
	sorted := append([]*agentv1.InstanceSpec(nil), specs...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].GetInstanceId() < sorted[j].GetInstanceId() })
	for _, spec := range sorted {
		policy := spec.GetNetworkPolicy()
		if !policyEnforced(policy) || spec.GetDesiredState() == agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_DELETED {
			continue
		}
		type nicRules struct {
			tap    string
			v4, v6 []string
		}
		var nics []nicRules
		for i, nic := range spec.GetNics() {
			r := nicRules{tap: runtime.TapName(spec.GetInstanceId(), i)}
			for _, a := range nic.GetAddresses() {
				p, err := netip.ParsePrefix(a)
				if err != nil {
					failed[spec.GetInstanceId()] = fmt.Sprintf("network policy: NIC %d address %q is not in CIDR form", i, a)
					break
				}
				if p.Addr().Is4() {
					r.v4 = append(r.v4, p.Masked().String())
				} else {
					r.v6 = append(r.v6, p.Masked().String())
				}
			}
			if _, bad := failed[spec.GetInstanceId()]; bad {
				break
			}
			if len(r.v4)+len(r.v6) == 0 {
				failed[spec.GetInstanceId()] = fmt.Sprintf("network policy %s needs IPAM addresses on NIC %d", policyName(policy), i)
				break
			}
			nics = append(nics, r)
		}
		if _, bad := failed[spec.GetInstanceId()]; bad {
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
	return b.String(), failed
}

func set(items []string) string { return "{ " + strings.Join(items, ", ") + " }" }

func policyName(p agentv1.InstanceNetworkPolicy) string {
	return strings.ToLower(strings.TrimPrefix(p.String(), "INSTANCE_NETWORK_POLICY_"))
}
