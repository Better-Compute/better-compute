//go:build fakehw

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// plannedFake is the fakehw runtime that also writes, for each domain it defines, the libvirt XML
// bcd would define on a real host (fakehw-plans/<id>.xml; <id>.error when libvirt would refuse the
// spec). The fake still runs the domain either way: tests assert the plan the fake cannot run
// (pinning, NUMA, hugepages, the balloon, volumes by serial). Every other method is the fake's.
type plannedFake struct {
	*runtime.Fake
	dir        string
	volumes    *runtime.Volumes
	gpuAddress func(id string) (string, bool)
}

func newPlannedFake(dataDir string, fake *runtime.Fake) *plannedFake {
	inv := fakehw.Inventory(fakeSeed())
	return &plannedFake{
		Fake:    fake,
		dir:     filepath.Join(dataDir, "fakehw-plans"),
		volumes: &runtime.Volumes{Dir: runtime.VolumeDir(dataDir)},
		gpuAddress: func(id string) (string, bool) {
			if inv == nil || inv.Gpus == nil {
				return "", false
			}
			for _, g := range inv.Gpus.Gpus {
				if g.Uuid == id && len(g.PciBusId) >= 12 {
					bus := g.PciBusId // 00000000:18:00.0 → 0000:18:00.0
					return bus[len(bus)-12:], true
				}
			}
			return "", false
		},
	}
}

func (p *plannedFake) Ensure(ctx context.Context, spec *agentv1.InstanceSpec, userData []byte, restore *runtime.Restore) error {
	if err := p.Fake.Ensure(ctx, spec, userData, restore); err != nil {
		return err
	}
	id := spec.GetInstanceId()
	if err := os.MkdirAll(p.dir, 0o700); err != nil {
		return err
	}
	raw, err := runtime.RenderLibvirt(spec, filepath.Join(filepath.Dir(p.dir), "instances", id), p.volumes, p.gpuAddress)
	if err != nil {
		_ = os.Remove(filepath.Join(p.dir, id+".xml"))
		return os.WriteFile(filepath.Join(p.dir, id+".error"), []byte(err.Error()+"\n"), 0o600)
	}
	_ = os.Remove(filepath.Join(p.dir, id+".error"))
	return os.WriteFile(filepath.Join(p.dir, id+".xml"), raw, 0o600)
}

func (p *plannedFake) Destroy(ctx context.Context, id string) error {
	if err := p.Fake.Destroy(ctx, id); err != nil {
		return err
	}
	for _, ext := range []string{".xml", ".error"} {
		if err := os.Remove(filepath.Join(p.dir, id+ext)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
