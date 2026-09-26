package main

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/selfupdate"
)

type doctorCheck struct{ status, check, detail string }

// toolChecks: what a VPS host needs besides KVM. libvirt-kvm drives virsh, cloud-hypervisor its
// VMM through systemd-run; both use qemu-img and build
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
	var out []doctorCheck
	virsh, libvirt := have("virsh")
	ch, cloudHypervisor := have("cloud-hypervisor")
	if !libvirt && !cloudHypervisor {
		return []doctorCheck{{"warn", "libvirt", "neither virsh nor cloud-hypervisor: this host runs no VPS instances"}}
	}
	if libvirt {
		out = append(out, doctorCheck{"ok", "libvirt", virsh})
	}
	if cloudHypervisor {
		out = append(out, doctorCheck{"ok", "cloud-hypervisor", ch})
		if _, err := os.Stat("/usr/share/cloud-hypervisor/CLOUDHV.fd"); err != nil {
			out = append(out, doctorCheck{"warn", "cloud-hypervisor", "no firmware at /usr/share/cloud-hypervisor/CLOUDHV.fd: its instances cannot boot"})
		}
		if _, ok := have("systemd-run"); !ok {
			out = append(out, doctorCheck{"fail", "cloud-hypervisor", "no systemd-run: its VMMs cannot outlive bcd"})
		}
	}
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

// configChecks look at what the configuration leaves off: self-update without release pins, an
// update pending or failed, and a site agent without its local BMC deny list.
func configChecks(cfg *config.Config, role string) []doctorCheck {
	var out []doctorCheck
	pins, _ := cfg.Update.Pins()
	if len(pins) == 0 {
		out = append(out, doctorCheck{"warn", "update", "no [update] release_pins: self-update is refused (reinstall to upgrade)"})
	} else {
		out = append(out, doctorCheck{"ok", "update", fmt.Sprintf("%d release pins, threshold %d", len(pins), cfg.Update.ReleaseThreshold)})
	}
	// The same resolver as bcd update: [update] slots_dir, /usr/local/lib/bcd under bcd helper, else
	// <data_dir>/bin (and the records beside the slots, or in data_dir).
	slotsDir, stateDir := cfg.UpdateDirs()
	slots := selfupdate.Slots{Dir: slotsDir, Entrypoint: cfg.Update.Entrypoint}
	if cur, err := slots.Current(); err == nil && cur != "" {
		if target, _ := os.Readlink(cfg.Update.Entrypoint); target != filepath.Join(slots.Dir, "current") {
			out = append(out, doctorCheck{"fail", "slots", fmt.Sprintf("%s does not link to %s: bcd.service would not start the current slot", cfg.Update.Entrypoint, filepath.Join(slots.Dir, "current"))})
		} else {
			out = append(out, doctorCheck{"ok", "slots", fmt.Sprintf("running slot %s (%s)", cur, slots.Versions()[cur])})
		}
	}
	if p, err := selfupdate.LoadPending(stateDir); err == nil && p != nil {
		out = append(out, doctorCheck{"warn", "update", fmt.Sprintf("update %s -> %s is %s", p.FromVersion, p.Version, p.State)})
	}
	for v, why := range selfupdate.LoadRecord(stateDir).Failed {
		out = append(out, doctorCheck{"warn", "update", fmt.Sprintf("bcd %s failed (%s); bcd update --clear-failed lets a rollout retry it", v, why)})
	}
	if cfg.Helper.Socket != "" && os.Geteuid() == 0 {
		// bcd helper refuses to start unless every directory to its slots, socket and entrypoint is
		// root's alone (a group-writable /usr/local/lib, root:staff 2775 on older Debian, fails it).
		for _, p := range []string{slotsDir, filepath.Dir(cfg.Helper.Socket), filepath.Dir(cfg.Update.Entrypoint)} {
			if err := rootOnlyPath(p); err != nil {
				out = append(out, doctorCheck{"fail", "helper", err.Error()})
			}
		}
	}
	if role == "site" && cfg.BMCNetworks == "" {
		out = append(out, doctorCheck{"warn", "bmc", "no [site] bmc_networks: site.httpProxy's BMC refusal relies on the BMCs this agent has driven"})
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
	out = append(out, hostResourceChecks()...)
	out = append(out, gpuChecks(gpuSampler())...)
	if cfg == nil {
		return out
	}
	out = append(out, hostKubeChecks(cfg)...)
	out = append(out, helperRuntimeChecks(cfg, exec.LookPath, userInGroup)...)
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
	role := ""
	if err == nil {
		role = state.Role
	}
	switch {
	case err != nil:
		out = append(out, doctorCheck{"warn", "identity", err.Error()})
	case time.Now().After(state.NotAfter):
		out = append(out, doctorCheck{"fail", "identity", fmt.Sprintf("node %s: the certificate expired at %s; join again", state.NodeID, state.NotAfter.Format(time.RFC3339))})
	default:
		out = append(out, doctorCheck{"ok", "identity", fmt.Sprintf("node %s (site %s, role %s), certificate valid for %s",
			state.NodeID, state.SiteID, state.Role, time.Until(state.NotAfter).Round(time.Minute))})
	}
	return append(out, configChecks(cfg, role)...)
}
