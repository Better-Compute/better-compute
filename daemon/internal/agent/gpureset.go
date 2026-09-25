package agent

import (
	"context"
	"errors"
	"fmt"
	osexec "os/exec"
	"sort"
	"strings"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/journal"
)

// ResetGPU resets one GPU (nvidia-smi --gpu-reset), unless ResetGPUFunc replaces it; a host under a
// fake root has no GPUs to reset and succeeds.
func (h *RealHost) ResetGPU(ctx context.Context, uuid string) error {
	if h.Helper != nil {
		return h.Helper.Do(ctx, helper.Request{Op: "gpu.reset", GPU: uuid})
	}
	if h.ResetGPUFunc != nil {
		return h.ResetGPUFunc(ctx, uuid)
	}
	if h.Root != "" && h.Root != "/" {
		return nil
	}
	out, err := osexec.CommandContext(ctx, "nvidia-smi", "--gpu-reset", "-i", uuid).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// runGpuReset resets the listed GPUs (after a release, and for remediation such as XID 63). It
// refuses a GPU that still has a live assignment, reports unknown GPUs as not reset, and reads ECC
// and row-remap state back from a fresh inventory.
func (a *Agent) runGpuReset(ctx context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &agentv1.GpuResetRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	if len(req.GetGpuUuids()) == 0 {
		return journal.Result{}, invalidPayload(errors.New("gpu_uuids is empty"))
	}
	busy := a.devices.assignedDevices()
	var blocked []string
	for _, u := range req.GetGpuUuids() {
		if busy[u] {
			blocked = append(blocked, u)
		}
	}
	if len(blocked) > 0 {
		return journal.Result{}, &KindError{Code: "gpu-busy", Message: strings.Join(blocked, ", ") + " has a live assignment"}
	}
	a.invMu.Lock()
	known := map[string]bool{}
	for _, u := range gpuUUIDs(a.inv) {
		known[u] = true
	}
	a.invMu.Unlock()
	uuids := append([]string(nil), req.GetGpuUuids()...)
	sort.Strings(uuids)
	result := &agentv1.GpuResetResult{}
	for _, u := range uuids {
		o := &agentv1.GpuResetOutcome{Uuid: u}
		if !known[u] {
			o.Message = "unknown GPU"
		} else if err := a.host.ResetGPU(ctx, u); err != nil {
			o.Message = err.Error()
		} else {
			o.Reset_ = true
		}
		result.Gpus = append(result.Gpus, o)
	}
	if _, err := a.collect(true); err == nil {
		a.invMu.Lock()
		if a.inv != nil && a.inv.Gpus != nil {
			for _, o := range result.Gpus {
				for _, g := range a.inv.Gpus.Gpus {
					if g.Uuid != o.Uuid || !o.Reset_ {
						continue
					}
					o.Healthy = true
					if g.Ecc != nil && g.Ecc.VolatileCounts != nil && g.Ecc.VolatileCounts.Uncorrectable > 0 {
						o.Healthy = false
					}
					if g.RowRemap != nil && (g.RowRemap.Pending || g.RowRemap.Failure) {
						o.Healthy = false
					}
				}
			}
		}
		a.invMu.Unlock()
	}
	return succeeded(result)
}
