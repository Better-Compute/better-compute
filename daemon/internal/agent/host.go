package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// Host is the machine under the agent: its boot, its hardware and its filesystem. The real host
// reads /proc and /sys and reboots through systemd; a fakehw host (tests, bcd sim) keeps its boot id
// in a file and "reboots" by restarting the process with a new one.
type Host interface {
	// BootID returns the kernel boot id (/proc/sys/kernel/random/boot_id).
	BootID() (string, error)
	// Hostname returns the host name.
	Hostname() string
	// Inventory collects the hardware inventory.
	Inventory() (*inventory.NodeInventory, error)
	// Reboot reboots the machine. It returns only on failure (or, for a fake host, never: it
	// restarts the process).
	Reboot(reason string) error
	// Path maps an absolute host path (/etc/cdi/..., /run/bcd/...) to where this host keeps it.
	Path(abs string) string
	// Logs returns a systemd unit's log lines of the last since (logs.collect).
	Logs(ctx context.Context, unit string, since time.Duration) ([]byte, error)
	// ReloadSSH makes sshd re-read its configuration (the access converger's drop-in).
	ReloadSSH() error
	// Kmsg opens the kernel log after its last record (NVIDIA XIDs).
	Kmsg() (io.ReadCloser, error)
	// ResetGPU resets one GPU (gpu.reset).
	ResetGPU(ctx context.Context, uuid string) error
	// ApplyFirewall loads an nftables ruleset (one transaction; the instances' network policies).
	ApplyFirewall(ctx context.Context, ruleset string) error
	// CheckFirewall reports whether bcd's table is still loaded with its rules (an nftables reload,
	// "flush ruleset" or a flushed table or chain changes it): rules is how many bcd loaded.
	CheckFirewall(ctx context.Context, rules int) error
	// WriteFile replaces a root-owned file bcd owns (CDI specs, allocation env files, the SSH files);
	// RemoveFile removes one (absent is fine). Under bcd helper, the helper does both.
	WriteFile(abs string, data []byte, mode os.FileMode) error
	RemoveFile(abs string) error

	// The ramdisk's operations (ramdisk.go, ramdisk_host.go).
	SecureErase(ctx context.Context, d *inventory.Disk, mode agentv1.WipeMode) (method string, verified bool, err error)
	RereadPartitions(ctx context.Context, d *inventory.Disk) error
	InstallUserData(ctx context.Context, d *inventory.Disk, kind string, data []byte) error
	// InstallFiles writes files (absolute paths, mode 0600) into the root filesystem of the OS on d.
	InstallFiles(ctx context.Context, d *inventory.Disk, files map[string][]byte) error
	Kexec(ctx context.Context, d *inventory.Disk, kernel, initrd string, cmdline []string) error
	RunDCGM(ctx context.Context, level uint32, uuids []string, gpus []*inventory.Gpu) (*agentv1.DiagDcgmResult, error)
}

// RealHost is the machine bcd runs on.
type RealHost struct {
	// Collect gathers the inventory (the NVML and sysfs collectors, or fakehw).
	Collect func() (*inventory.NodeInventory, error)
	// RebootFunc reboots (systemctl reboot on a systemd host).
	RebootFunc func(reason string) error
	// Root prefixes every host path; "" or "/" is the real filesystem.
	Root string
	// BootIDFile overrides /proc/sys/kernel/random/boot_id.
	BootIDFile string
	// KexecFunc overrides kexec (a fakehw machine "reboots" instead).
	KexecFunc func(ctx context.Context, d *inventory.Disk, kernel, initrd string, cmdline []string) error
	// ResetGPUFunc overrides nvidia-smi --gpu-reset.
	ResetGPUFunc func(ctx context.Context, uuid string) error
	// LogsFunc overrides journalctl.
	LogsFunc func(ctx context.Context, unit string, since time.Duration) ([]byte, error)
	// FirewallFunc overrides nft -f.
	FirewallFunc func(ctx context.Context, ruleset string) error
	// Helper, when set, performs the privileged operations: bcd node runs unprivileged and asks
	// bcd helper (reboot, GPU resets, the firewall, sshd reloads and the files bcd owns).
	Helper *helper.Client
}

// WriteFile writes a file bcd owns, through the helper when there is one.
func (h *RealHost) WriteFile(abs string, data []byte, mode os.FileMode) error {
	if h.Helper != nil {
		return h.Helper.WriteFile(context.Background(), abs, data)
	}
	return writeFile(h.Path(abs), data, mode)
}

// RemoveFile removes a file bcd owns, through the helper when there is one.
func (h *RealHost) RemoveFile(abs string) error {
	if h.Helper != nil {
		return h.Helper.RemoveFile(context.Background(), abs)
	}
	if err := os.Remove(h.Path(abs)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// FirewallFile is where a host under a fake root keeps the ruleset it was asked to load.
const FirewallFile = "/run/bcd/instances.nft"

// CheckFirewall lists bcd's tables as JSON (nft -j list table bridge bcd_instances, inet bcd_taps)
// and counts their rules; a host under a fake root checks its ruleset file.
func (h *RealHost) CheckFirewall(ctx context.Context, rules int) error {
	if h.Helper != nil {
		return h.Helper.Do(ctx, helper.Request{Op: "firewall.check", Rules: rules})
	}
	if h.FirewallFunc != nil {
		return nil
	}
	if h.Root != "" && h.Root != "/" {
		_, err := os.Stat(h.Path(FirewallFile))
		return err
	}
	n := 0
	for _, table := range [][2]string{{"bridge", firewallTable}, {"inet", backstopTable}} {
		out, err := exec.CommandContext(ctx, "nft", "-j", "list", "table", table[0], table[1]).Output()
		if err != nil {
			if table[0] == "inet" {
				continue // absent: no rules (a ruleset without NICs has none)
			}
			return fmt.Errorf("nft: %v", err)
		}
		var listing struct {
			Nftables []map[string]json.RawMessage `json:"nftables"`
		}
		if err := json.Unmarshal(out, &listing); err != nil {
			return fmt.Errorf("nft -j: %w", err)
		}
		for _, object := range listing.Nftables {
			if _, ok := object["rule"]; ok {
				n++
			}
		}
	}
	if n != rules {
		return fmt.Errorf("the tables hold %d rules, not the %d bcd loaded", n, rules)
	}
	return nil
}

// ApplyFirewall runs nft -f with the ruleset on its standard input. A host under a fake root (fakehw)
// writes it to FirewallFile instead.
func (h *RealHost) ApplyFirewall(ctx context.Context, ruleset string) error {
	if h.Helper != nil {
		return h.Helper.Do(ctx, helper.Request{Op: "firewall.apply", Ruleset: ruleset})
	}
	if h.FirewallFunc != nil {
		return h.FirewallFunc(ctx, ruleset)
	}
	if h.Root != "" && h.Root != "/" {
		file := h.Path(FirewallFile)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			return err
		}
		return os.WriteFile(file, []byte(ruleset), 0o644)
	}
	cmd := exec.CommandContext(ctx, "nft", "-f", "-")
	cmd.Stdin = strings.NewReader(ruleset)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("nft: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (h *RealHost) BootID() (string, error) {
	file := h.BootIDFile
	if file == "" {
		file = "/proc/sys/kernel/random/boot_id"
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

func (h *RealHost) Hostname() string {
	name, _ := os.Hostname()
	return name
}

func (h *RealHost) Inventory() (*inventory.NodeInventory, error) { return h.Collect() }

func (h *RealHost) Reboot(reason string) error {
	if h.Helper != nil {
		return h.Helper.Do(context.Background(), helper.Request{Op: "reboot", Reason: reason})
	}
	return h.RebootFunc(reason)
}

// ReloadSSH reloads sshd through systemd (Debian names the unit ssh, others sshd). A host under a
// fake root has no sshd to reload.
func (h *RealHost) ReloadSSH() error {
	if h.Helper != nil {
		return h.Helper.Do(context.Background(), helper.Request{Op: "ssh.reload"})
	}
	if h.Root != "" && h.Root != "/" {
		return nil
	}
	var last error
	for _, unit := range []string{"ssh", "sshd"} {
		if last = exec.Command("systemctl", "reload-or-restart", unit).Run(); last == nil {
			return nil
		}
	}
	return fmt.Errorf("reload sshd: %w", last)
}

func (h *RealHost) Path(abs string) string {
	if h.Root == "" || h.Root == "/" {
		return abs
	}
	return filepath.Join(h.Root, filepath.FromSlash(abs))
}

// Claims are the HardwareClaims of a JoinRequest (session.proto): the identifiers JoinService
// derives the hardware key from, lowercase where the proto says so, lists sorted.
func Claims(inv *inventory.NodeInventory, hostname, bootID string) *agentv1.HardwareClaims {
	c := &agentv1.HardwareClaims{Hostname: hostname, BootId: bootID}
	if inv == nil {
		return c
	}
	if s := inv.System; s != nil {
		c.ProductUuid = strings.ToLower(s.ProductUuid)
		c.ProductSerial = s.Serial
		c.BoardSerial = s.BoardSerial
		c.ChassisSerial = s.ChassisSerial
		c.SysVendor = s.Vendor
		c.ProductName = s.Product
	}
	if n := inv.Nics; n != nil {
		for _, nic := range n.Nics {
			if nic.Mac != "" {
				c.PermanentMacs = append(c.PermanentMacs, strings.ToLower(nic.Mac))
			}
		}
		sort.Strings(c.PermanentMacs)
	}
	if g := inv.Gpus; g != nil {
		for _, gpu := range g.Gpus {
			if gpu.Uuid != "" {
				c.GpuUuids = append(c.GpuUuids, gpu.Uuid)
			}
		}
		sort.Strings(c.GpuUuids)
	}
	if b := inv.Bmc; b != nil {
		c.BmcMac = strings.ToLower(b.Mac)
	}
	return c
}

// gpuUUIDs lists the GPUs an inventory holds.
func gpuUUIDs(inv *inventory.NodeInventory) []string {
	if inv == nil || inv.Gpus == nil {
		return nil
	}
	out := make([]string, 0, len(inv.Gpus.Gpus))
	for _, g := range inv.Gpus.Gpus {
		out = append(out, g.Uuid)
	}
	return out
}
