package main

import (
	"crypto"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
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
		out = append(out, helperBindingChecks(cfg, &hostconfig.OSSystem{})...)
	}
	if role == "site" && cfg.BMCNetworks == "" {
		out = append(out, doctorCheck{"warn", "bmc", "no [site] bmc_networks: site.httpProxy's BMC refusal relies on the BMCs this agent has driven"})
	}
	return out
}

// helperBindingChecks (root, [helper]): bcd helper applies host units only for the node root's signed
// join record names. A node joined before bcd join kept that record has none, and the helper binds to
// the node the first signed spec it accepts names (trust on first use): a finding, so operators can
// pin it deliberately.
func helperBindingChecks(cfg *config.Config, sys hostconfig.System) []doctorCheck {
	if cfg.Helper.Socket == "" {
		return nil
	}
	pin, _ := config.DecodePin(cfg.JoinSigningKeyPin)
	joined, err := helper.ReadJoinRecord(sys, pin)
	state, _, stateErr := agent.LoadState(cfg.DataDir)
	if err != nil {
		return []doctorCheck{{"fail", "helper", err.Error() + ": bcd helper refuses every host unit"}}
	}
	if joined == nil && stateErr != nil {
		return nil // not joined yet
	}
	var out []doctorCheck
	switch {
	case joined == nil:
		out = append(out, doctorCheck{"warn", "helper", fmt.Sprintf("host units bind to the node the first signed spec names (trust on first use): %s joined before bcd join kept a signed join record (%s). To pin it, re-join as root: bcd join with a new token after moving %s's identity aside (a tpm or provisioned re-join keeps the node id)",
			state.NodeID, helper.JoinRecord, cfg.DataDir)})
	case stateErr == nil && joined.NodeID != state.NodeID:
		out = append(out, doctorCheck{"fail", "helper", fmt.Sprintf("root's join record names %s, but this machine's identity is %s: bcd helper refuses its specs; re-run the join as root", joined.NodeID, state.NodeID)})
	default:
		out = append(out, doctorCheck{"ok", "helper", "host units bind to " + joined.NodeID + " (root's signed join record)"})
	}
	// Signed intent must be root's decision: the install's pins, or the roots root's join record carries.
	if pins, _ := cfg.CommandRootPins(); len(pins) == 0 && len(joined.CommandRoots()) == 0 {
		out = append(out, doctorCheck{"fail", "helper", "bcd helper applies host units unsigned unless the node itself presents a trust bundle: neither command_root_sha256 nor root's join record names command-signing roots. Pin them (the install script's --command-root-sha256), or re-join as root against a control plane that signs intent"})
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
	out = append(out, gpuDoctor(gpuSampler())...)
	if cfg == nil {
		return out
	}
	out = append(out, hostKubeChecks(cfg)...)
	out = append(out, helperRuntimeChecks(cfg, exec.LookPath, realLibvirtHost)...)
	out = append(out, tssCheck(cfg, userInGroup)...)
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
	state, key, err := agent.LoadState(cfg.DataDir)
	role := ""
	if err == nil {
		role = state.Role
		out = append(out, nodeKeyCheck(key, nodeKeyTPM(cfg.DataDir) != nil))
		if c, ok := key.(io.Closer); ok {
			_ = c.Close()
		}
	}
	switch {
	case errors.Is(err, agent.ErrNotJoined):
		out = append(out, doctorCheck{"warn", "identity", err.Error()})
	case err != nil:
		// An identity that is there but does not load: bcd join joins again, but cannot tell whose the
		// journal is, and bcd node refuses another node's; --reset moves the journal aside with it.
		out = append(out, doctorCheck{"fail", "identity", err.Error() + " (to join again as root: bcd join --reset --yes, then bcd join)"})
	case time.Now().After(state.NotAfter):
		out = append(out, doctorCheck{"fail", "identity", fmt.Sprintf("node %s: the certificate expired at %s; join again as root: bcd join --reset --yes, then bcd join",
			state.NodeID, state.NotAfter.Format(time.RFC3339))})
	default:
		out = append(out, doctorCheck{"ok", "identity", fmt.Sprintf("node %s (site %s, role %s), certificate valid for %s",
			state.NodeID, state.SiteID, state.Role, time.Until(state.NotAfter).Round(time.Minute))})
	}
	return append(out, configChecks(cfg, role)...)
}

// tssCheck: under [helper] bcd node never opens the TPM (bcd helper holds its node keys, 8870b8d). A node
// user still in the tss group (install scripts 0ba2a79 to 8870b8d put it there) can open the TPM
// resource manager, which filters no command: it could lock or clear the TPM's hierarchies.
func tssCheck(cfg *config.Config, inGroup func(name, group string) (bool, error)) []doctorCheck {
	if cfg.Helper.Socket == "" || cfg.Helper.User == "" {
		return nil
	}
	node := cfg.Helper.User
	switch in, err := inGroup(node, "tss"); {
	case err != nil && !strings.Contains(err.Error(), "unknown group"):
		return []doctorCheck{{"warn", "tpm", err.Error()}}
	case in:
		return []doctorCheck{{"fail", "tpm", node + " is in the tss group: it can send the TPM any command (lock or clear its hierarchies); " +
			"bcd helper holds the node keys, so remove it (gpasswd -d " + node + " tss) and restart bcd.service"}}
	}
	return nil
}

// nodeKeyCheck says what holds the node key: the TPM, or a file (a warning where a TPM is there: the
// next renewal moves the key into it, through bcd helper when bcd node runs unprivileged).
func nodeKeyCheck(key crypto.Signer, haveTPM bool) doctorCheck {
	switch {
	case agent.NodeKeyKind(key) == "tpm":
		return doctorCheck{"ok", "node key", "in the TPM: it cannot be copied off this machine"}
	case haveTPM:
		return doctorCheck{"warn", "node key", "a file key although this host has a TPM: the next renewal moves it into the TPM (through bcd helper when bcd node runs unprivileged)"}
	}
	return doctorCheck{"ok", "node key", "a file key (this host has no TPM)"}
}
