package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/nvml"
)

// gpuDoctor reads the GPUs once and checks them the ways real GPU hosts fail: each GPU's own health
// (gpuChecks), why nvidia-smi could not answer, and the host around the GPUs (gpuHostChecks) when
// gpuHostRoot is set (the host build; a fakehw build has no real GPUs to compare the bus with).
func gpuDoctor(sampler agent.GPUSampler) []doctorCheck {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	snap, err := sampler(ctx)
	if err != nil && !errors.Is(err, nvml.ErrNoDriver) {
		err = gpuErrorHint(err)
	}
	out := gpuChecks(func(context.Context) (*nvml.Snapshot, error) { return snap, err })
	if gpuHostRoot == "" {
		return out
	}
	if err != nil {
		snap = nil
	}
	return append(out, gpuHostChecks(gpuHostRoot, snap, systemdActive)...)
}

// gpuErrorHint adds what to do to the nvidia-smi failures seen on real hosts.
func gpuErrorHint(err error) error {
	msg := err.Error()
	var hint string
	switch {
	case strings.Contains(msg, "Driver/library version mismatch"):
		hint = "the loaded kernel module and the user-space libraries differ, usually after a driver upgrade: reboot, or unload and reload the nvidia modules"
	case strings.Contains(msg, "couldn't communicate with the NVIDIA driver"):
		hint = "the nvidia kernel module is not loaded: modprobe nvidia (under Secure Boot the module must be signed by an enrolled key; see dmesg)"
	case strings.Contains(msg, "No devices were found"):
		hint = "the driver sees no GPU: compare lspci -d 10de: with dmesg (RmInitAdapter failed, Xid 79)"
	case errors.Is(err, context.DeadlineExceeded) || strings.Contains(msg, "signal: killed"):
		hint = "nvidia-smi did not answer: a GPU may be wedged (dmesg: Xid 79 or 119); gpu.reset or a reboot recovers it"
	default:
		return err
	}
	return fmt.Errorf("%w (%s)", err, hint)
}

func systemdActive(unit string) bool {
	out, err := exec.Command("systemctl", "is-active", unit).Output()
	return err == nil && strings.TrimSpace(string(out)) == "active"
}

// pciGPU is one NVIDIA PCI function the kernel lists.
type pciGPU struct {
	address string
	// class: 0x03xxxx display (a GPU), 0x0680xx bridge (an NVSwitch).
	class  string
	driver string
}

// nvidiaPCI lists NVIDIA's PCI functions under root/sys/bus/pci/devices.
func nvidiaPCI(root string) []pciGPU {
	base := filepath.Join(root, "sys/bus/pci/devices")
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil
	}
	var out []pciGPU
	for _, e := range entries {
		dir := filepath.Join(base, e.Name())
		vendor, _ := os.ReadFile(filepath.Join(dir, "vendor"))
		if strings.TrimSpace(string(vendor)) != "0x10de" {
			continue
		}
		class, _ := os.ReadFile(filepath.Join(dir, "class"))
		d := pciGPU{address: e.Name(), class: strings.TrimSpace(string(class))}
		if link, err := os.Readlink(filepath.Join(dir, "driver")); err == nil {
			d.driver = filepath.Base(link)
		}
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].address < out[j].address })
	return out
}

// gpuHostChecks: what real GPU hosts get wrong around the GPUs (root prefixes /dev, /proc and /sys;
// snap is nil when nvidia-smi gave nothing):
//   - WSL 2's paravirtual GPU, which runs CUDA but supports nothing bcd does to a GPU itself;
//   - nouveau holding the GPUs;
//   - GPUs on the PCI bus that the driver lost ("fell off the bus") or that no driver has;
//   - persistence mode off;
//   - NVSwitch systems without nvidia-fabricmanager, where CUDA fails on every GPU.
func gpuHostChecks(root string, snap *nvml.Snapshot, active func(unit string) bool) []doctorCheck {
	path := func(p string) string { return filepath.Join(root, p) }
	exists := func(p string) bool { _, err := os.Stat(path(p)); return err == nil }
	if exists("dev/dxg") && !exists("dev/nvidiactl") {
		if snap == nil || len(snap.Section.Gpus) == 0 {
			return nil
		}
		return []doctorCheck{{"warn", "gpu-host", fmt.Sprintf("WSL 2 paravirtual GPU(s) (/dev/dxg, %d): CUDA containers work (CDI: nvidia-ctk cdi generate --mode=wsl), but there is no VFIO passthrough, gpu.reset, MIG or DCGM here", len(snap.Section.Gpus))}}
	}
	var out []doctorCheck
	if modules, err := os.ReadFile(path("proc/modules")); err == nil {
		for _, line := range strings.Split(string(modules), "\n") {
			if strings.HasPrefix(line, "nouveau ") {
				out = append(out, doctorCheck{"fail", "nouveau", "the nouveau driver is loaded: blacklist it (blacklist nouveau in /etc/modprobe.d, rebuild the initramfs, reboot) so the NVIDIA driver can bind the GPUs"})
				break
			}
		}
	}
	var gpus, switches []pciGPU
	byDriver := map[string]int{}
	var unbound []string
	for _, d := range nvidiaPCI(root) {
		switch {
		case strings.HasPrefix(d.class, "0x03"):
			gpus = append(gpus, d)
			byDriver[d.driver]++
			if d.driver == "" {
				unbound = append(unbound, d.address)
			}
		case strings.HasPrefix(d.class, "0x0680"):
			switches = append(switches, d)
		}
	}
	seen := 0
	if snap != nil {
		seen = len(snap.Section.Gpus)
	}
	switch {
	case len(gpus) == 0:
	case snap == nil && byDriver["nvidia"] == 0:
		out = append(out, doctorCheck{"warn", "gpu-bus", fmt.Sprintf("%d NVIDIA GPU(s) on the PCI bus but no NVIDIA driver answers: install it (the nvidia-driver host unit)", len(gpus))})
	case byDriver["nvidia"] > seen:
		out = append(out, doctorCheck{"fail", "gpu-bus", fmt.Sprintf("%d GPU(s) on the PCI bus are bound to nvidia but nvidia-smi sees %d: a GPU fell off the bus or did not initialize (dmesg: Xid 79, RmInitAdapter failed); gpu.reset or a reboot", byDriver["nvidia"], seen)})
	case len(unbound) > 0:
		out = append(out, doctorCheck{"warn", "gpu-bus", fmt.Sprintf("%d GPU(s) have no driver bound (%s): not offered until a driver binds them", len(unbound), strings.Join(unbound, ", "))})
	default:
		detail := fmt.Sprintf("%d NVIDIA GPU(s) on the PCI bus: %d on nvidia", len(gpus), byDriver["nvidia"])
		if n := byDriver["vfio-pci"]; n > 0 {
			detail += fmt.Sprintf(", %d on vfio-pci (passthrough)", n)
		}
		out = append(out, doctorCheck{"ok", "gpu-bus", detail})
	}
	if snap != nil {
		var off []string
		for _, g := range snap.Section.Gpus {
			if !g.PersistenceMode {
				off = append(off, fmt.Sprint(g.Index))
			}
		}
		if len(off) > 0 {
			out = append(out, doctorCheck{"warn", "persistence", fmt.Sprintf("persistence mode is off on GPU %s: enable nvidia-persistenced, or every first CUDA call re-initializes the GPU (seconds) and resets its state", strings.Join(off, ", "))})
		}
	}
	if len(switches) > 0 {
		if active("nvidia-fabricmanager") {
			out = append(out, doctorCheck{"ok", "fabric-manager", fmt.Sprintf("%d NVSwitch(es), nvidia-fabricmanager active", len(switches))})
		} else {
			out = append(out, doctorCheck{"fail", "fabric-manager", fmt.Sprintf("%d NVSwitch(es) but nvidia-fabricmanager is not active: CUDA fails on every GPU until it runs (the fabric-manager host unit)", len(switches))})
		}
	}
	return out
}
