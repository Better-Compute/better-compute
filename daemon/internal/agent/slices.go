package agent

import (
	"context"
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/slice"
)

// Hold slices (PLAN.md §3.8, package slice): a hold with limits gets its cgroup-v2 slice before its
// CDI spec names it. A host under a fake root (fakehw) keeps each slice as a JSON record of its
// limits instead of asking systemd.

// fakeSliceDir is where a fake-root host records its slices.
const fakeSliceDir = "/run/bcd/slices"

// sliceLimits converts a hold's DeviceAssignment.limits.
func sliceLimits(l *agentv1.ResourceLimits) slice.Limits {
	return slice.Limits{
		CPUs: l.GetCpus(), Mems: l.GetMems(), CPUMillis: l.GetCpuMillis(), MemoryBytes: l.GetMemoryBytes(),
		Hugepages2Mi: l.GetHugepages_2Mi(), Hugepages1Gi: l.GetHugepages_1Gi(),
	}
}

func (h *RealHost) fakeRoot() bool { return h.Root != "" && h.Root != "/" }

// ApplySlice creates or updates a hold's slice (through the helper when bcd node is unprivileged).
func (h *RealHost) ApplySlice(ctx context.Context, name string, limits slice.Limits) error {
	if err := slice.Check(name, limits); err != nil {
		return err
	}
	if h.Helper != nil {
		return h.Helper.ApplySlice(ctx, name, limits)
	}
	if h.fakeRoot() {
		raw, err := json.Marshal(limits)
		if err != nil {
			return err
		}
		return writeFile(h.Path(path.Join(fakeSliceDir, name+".json")), raw, 0o644)
	}
	return slice.Apply(ctx, helper.ExecRunner, "", name, limits)
}

// RemoveSlice stops a hold's slice once it is empty (slice.ErrBusy while a workload still runs).
func (h *RealHost) RemoveSlice(ctx context.Context, name string) error {
	if h.Helper != nil {
		return h.Helper.RemoveSlice(ctx, name)
	}
	if h.fakeRoot() {
		if err := os.Remove(h.Path(path.Join(fakeSliceDir, name+".json"))); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return slice.Remove(ctx, helper.ExecRunner, "", name)
}

// holdSliceNames lists the hold slices on the host (cgroup directories, or a fake root's records).
func (a *Agent) holdSliceNames() []string {
	dir, suffix := a.host.Path(fakeSliceDir), ".json"
	if rh, ok := a.host.(*RealHost); ok && !rh.fakeRoot() {
		dir, suffix = filepath.Dir(slice.Dir("", slice.Name("x"))), ""
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), suffix)
		if ok && slice.Check(name, slice.Limits{}) == nil {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// sliceExists reports whether a hold's slice is there: after a reboot (runtime properties gone, the
// hold kept) the devices converger applies it again.
func (a *Agent) sliceExists(name string) bool {
	if rh, ok := a.host.(*RealHost); ok && rh.fakeRoot() {
		_, err := os.Stat(rh.Path(path.Join(fakeSliceDir, name+".json")))
		return err == nil
	}
	if _, ok := a.host.(*RealHost); ok {
		_, err := os.Stat(slice.Dir("", name))
		return err == nil
	}
	_, err := os.Stat(a.host.Path(path.Join(fakeSliceDir, name+".json")))
	return err == nil
}
