package agent

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
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

	// The ramdisk's operations (ramdisk.go, ramdisk_host.go).
	SecureErase(ctx context.Context, d *inventory.Disk, mode agentv1.WipeMode) (method string, verified bool, err error)
	RereadPartitions(ctx context.Context, d *inventory.Disk) error
	InstallUserData(ctx context.Context, d *inventory.Disk, kind string, data []byte) error
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

func (h *RealHost) Reboot(reason string) error { return h.RebootFunc(reason) }

// ReloadSSH reloads sshd through systemd (Debian names the unit ssh, others sshd). A host under a
// fake root has no sshd to reload.
func (h *RealHost) ReloadSSH() error {
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
