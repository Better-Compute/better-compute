package main

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// libvirtHelper is bcd helper's libvirt side: virsh on qemu:///system as root, and the policy the
// node's requests are held to. The directories are runtime.Libvirt's under data_dir; the bridges
// are [helper] instance_bridges; the GPUs are the host's inventory, read at each request.
func libvirtHelper(cfg *config.Config, host *agent.RealHost, uid, gid int) (helper.Virsh, func() (helper.LibvirtPolicy, error)) {
	virsh := func(ctx context.Context, args ...string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, "virsh", append([]string{"-c", "qemu:///system"}, args...)...)
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		if err := cmd.Run(); err != nil {
			return stdout.Bytes(), fmt.Errorf("virsh %s: %v: %s", args[0], err, strings.TrimSpace(stderr.String()))
		}
		return stdout.Bytes(), nil
	}
	instances := filepath.Join(cfg.DataDir, "libvirt", "instances")
	images := filepath.Join(cfg.DataDir, "libvirt", "images")
	volumes := filepath.Join(cfg.DataDir, "volumes")
	policy := func() (helper.LibvirtPolicy, error) {
		pci := map[string]bool{}
		if inv, err := host.Inventory(); err == nil && inv.Gpus != nil {
			for _, g := range inv.Gpus.Gpus {
				if addr, ok := pciAddress(g.PciBusId); ok {
					pci[addr] = true
				}
			}
		}
		bridges := map[string]bool{}
		for _, b := range cfg.Helper.Bridges() {
			bridges[b] = true
		}
		dirs := []string{instances, images, volumes}
		return helper.LibvirtPolicy{
			Domain: helper.DomainPolicy{
				Dirs:      dirs,
				CheckFile: helper.NodeFileCheck(dirs, uid),
				PCI:       pci,
				Bridges:   bridges,
				Images:    images,
				Overlay:   runtime.CheckOverlay,
				Base:      runtime.CheckBase,
			},
			StateDirs:  []string{instances},
			CheckState: helper.NodeFileCheck([]string{instances}, uid),
			NodeUID:    uid,
			NodeGID:    gid,
			Staging:    filepath.Join(hostconfig.StateDir, "libvirt"),
		}, nil
	}
	return virsh, policy
}
