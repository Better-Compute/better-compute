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
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// chHelper is bcd helper's cloud-hypervisor side (helper.CHPolicy): root's cloud-hypervisor binary
// (resolved here, never named by the node), runtime.CloudHypervisor's and the volume store's
// directories under data_dir, the node's files checked like libvirt's, the bridges of [helper]
// instance_bridges and this host's GPUs from its inventory, read at each request. nil without a
// cloud-hypervisor installed: ch.* is refused.
func chHelper(cfg *config.Config, host *agent.RealHost, uid int) func() (helper.CHPolicy, error) {
	binary, err := exec.LookPath("cloud-hypervisor")
	if err != nil {
		return nil
	}
	if binary, err = filepath.Abs(binary); err != nil {
		return nil
	}
	dir := filepath.Join(cfg.DataDir, "cloud-hypervisor")
	volumes := filepath.Join(cfg.DataDir, "volumes")
	run := func(ctx context.Context, name string, args ...string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, name, args...)
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		if err := cmd.Run(); err != nil {
			return stdout.Bytes(), fmt.Errorf("%s %s: %v: %s", name, args[0], err, strings.TrimSpace(stderr.String()))
		}
		return stdout.Bytes(), nil
	}
	return func() (helper.CHPolicy, error) {
		pci, byUUID := map[string]bool{}, map[string]string{}
		if inv, err := host.Inventory(); err == nil && inv.Gpus != nil {
			for _, g := range inv.Gpus.Gpus {
				if addr, ok := pciAddress(g.PciBusId); ok {
					pci[addr], byUUID[g.Uuid] = true, addr
				}
			}
		}
		bridges := map[string]bool{}
		for _, b := range cfg.Helper.Bridges() {
			bridges[b] = true
		}
		dirs := []string{filepath.Join(dir, "instances"), filepath.Join(dir, "images"), volumes}
		return helper.CHPolicy{
			Root: runtime.CHRootPolicy{
				Dir: dir, Volumes: volumes, Binary: binary,
				CheckFile: helper.NodeFileCheck(dirs, uid),
				PCI:       pci,
				GPUAddress: func(uuid string) (string, bool) {
					addr, ok := byUUID[uuid]
					return addr, ok
				},
			},
			Bridges: bridges, NodeUID: uid, Run: run, VFIO: runtime.SysfsVFIO{},
		}, nil
	}
}
