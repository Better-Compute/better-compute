package runtime

import (
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// networkConfig renders the NoCloud seed's network-config (cloud-init network config v2) for the
// NICs the control plane leased addresses to: each matched by MAC, its CIDR addresses static, a
// default route through its gateway when it has one, and its nameservers when it has any. A NIC
// without addresses keeps DHCP. nil when no NIC has static configuration: the image's own
// fallback (DHCP on the first NIC) stays.
func networkConfig(nics []*agentv1.InstanceNic) ([]byte, error) {
	static := false
	for _, n := range nics {
		if len(n.GetAddresses()) > 0 || n.GetGateway() != "" || len(n.GetNameservers()) > 0 {
			static = true
		}
	}
	if !static {
		return nil, nil
	}
	var b strings.Builder
	b.WriteString("version: 2\nethernets:\n")
	for i, n := range nics {
		mac, err := net.ParseMAC(n.GetMac())
		if err != nil {
			if len(n.GetAddresses()) == 0 && n.GetGateway() == "" && len(n.GetNameservers()) == 0 {
				continue // a DHCP NIC the runtime gives a MAC
			}
			return nil, fmt.Errorf("nic %d: static configuration needs a MAC: %q", i, n.GetMac())
		}
		fmt.Fprintf(&b, "  nic%d:\n    match:\n      macaddress: %s\n", i, strconv.Quote(mac.String()))
		if len(n.GetAddresses()) == 0 {
			b.WriteString("    dhcp4: true\n")
		} else {
			b.WriteString("    dhcp4: false\n    dhcp6: false\n    addresses:\n")
			for _, a := range n.GetAddresses() {
				p, err := netip.ParsePrefix(a)
				if err != nil {
					return nil, fmt.Errorf("nic %d: address %q is not in CIDR form", i, a)
				}
				fmt.Fprintf(&b, "      - %s\n", strconv.Quote(p.String()))
			}
		}
		if gw := n.GetGateway(); gw != "" {
			ip, err := netip.ParseAddr(gw)
			if err != nil {
				return nil, fmt.Errorf("nic %d: gateway %q", i, gw)
			}
			to := "0.0.0.0/0"
			if ip.Is6() && !ip.Is4In6() {
				to = "::/0"
			}
			fmt.Fprintf(&b, "    routes:\n      - to: %s\n        via: %s\n", strconv.Quote(to), strconv.Quote(ip.String()))
		}
		if ns := n.GetNameservers(); len(ns) > 0 {
			b.WriteString("    nameservers:\n      addresses:\n")
			for _, s := range ns {
				ip, err := netip.ParseAddr(s)
				if err != nil {
					return nil, fmt.Errorf("nic %d: nameserver %q", i, s)
				}
				fmt.Fprintf(&b, "        - %s\n", strconv.Quote(ip.String()))
			}
		}
	}
	return []byte(b.String()), nil
}
