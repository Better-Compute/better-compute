package main

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
)

type doctorCheck struct{ status, check, detail string }

// hostChecks are doctor's host checks (PLAN.md §14): virtualization support for VPS hosts, the
// gateway reachable over TCP, and the node's identity (joined, certificate lifetime).
func hostChecks(cfg *config.Config) []doctorCheck {
	var out []doctorCheck
	if _, err := os.Stat("/dev/kvm"); err == nil {
		out = append(out, doctorCheck{"ok", "kvm", "/dev/kvm present"})
	} else {
		out = append(out, doctorCheck{"warn", "kvm", "no /dev/kvm: this host cannot run VPS instances"})
	}
	if entries, err := os.ReadDir("/sys/class/iommu"); err == nil && len(entries) > 0 {
		out = append(out, doctorCheck{"ok", "iommu", fmt.Sprintf("%d IOMMU units", len(entries))})
	} else {
		out = append(out, doctorCheck{"warn", "iommu", "no IOMMU: GPU passthrough to instances is unavailable"})
	}
	if cfg == nil {
		return out
	}
	if u, err := url.Parse(cfg.GatewayURL); err == nil {
		host := u.Host
		if u.Port() == "" {
			port := "443"
			if u.Scheme == "http" {
				port = "80"
			}
			host = net.JoinHostPort(u.Hostname(), port)
		}
		start := time.Now()
		conn, err := net.DialTimeout("tcp", host, 5*time.Second)
		if err != nil {
			out = append(out, doctorCheck{"fail", "gateway", fmt.Sprintf("%s: %v", host, err)})
		} else {
			conn.Close()
			out = append(out, doctorCheck{"ok", "gateway", fmt.Sprintf("%s reachable in %s", host, time.Since(start).Round(time.Millisecond))})
		}
	}
	state, _, err := agent.LoadState(cfg.DataDir)
	switch {
	case err != nil:
		out = append(out, doctorCheck{"warn", "identity", err.Error()})
	case time.Now().After(state.NotAfter):
		out = append(out, doctorCheck{"fail", "identity", fmt.Sprintf("node %s: the certificate expired at %s; join again", state.NodeID, state.NotAfter.Format(time.RFC3339))})
	default:
		out = append(out, doctorCheck{"ok", "identity", fmt.Sprintf("node %s (site %s, role %s), certificate valid for %s",
			state.NodeID, state.SiteID, state.Role, time.Until(state.NotAfter).Round(time.Minute))})
	}
	return out
}
