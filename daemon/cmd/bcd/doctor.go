package main

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
)

type doctorCheck struct{ status, check, detail string }

// toolChecks: what a VPS host needs besides KVM. libvirt-kvm drives virsh and qemu-img and builds
// NoCloud seeds with genisoimage or xorriso; the instance firewall (anti-spoofing, network
// policies) needs nft, and without it the metadata service and instance dials stay off.
func toolChecks(lookPath func(string) (string, error)) []doctorCheck {
	have := func(names ...string) (string, bool) {
		for _, n := range names {
			if path, err := lookPath(n); err == nil {
				return path, true
			}
		}
		return "", false
	}
	path, ok := have("virsh")
	if !ok {
		return []doctorCheck{{"warn", "libvirt", "no virsh: this host runs no libvirt-kvm instances"}}
	}
	out := []doctorCheck{{"ok", "libvirt", path}}
	if path, ok := have("qemu-img"); ok {
		out = append(out, doctorCheck{"ok", "qemu-img", path})
	} else {
		out = append(out, doctorCheck{"fail", "qemu-img", "virsh without qemu-img: instance disks cannot be made"})
	}
	if path, ok := have("genisoimage", "xorriso"); ok {
		out = append(out, doctorCheck{"ok", "seed", path})
	} else {
		out = append(out, doctorCheck{"fail", "seed", "neither genisoimage nor xorriso: instances get no user data"})
	}
	if path, ok := have("nft"); ok {
		out = append(out, doctorCheck{"ok", "nftables", path})
	} else {
		out = append(out, doctorCheck{"fail", "nftables", "no nft: instances run without anti-spoofing or network policies, and the metadata service and instance dials stay off"})
	}
	return out
}

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
	out = append(out, toolChecks(exec.LookPath)...)
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
