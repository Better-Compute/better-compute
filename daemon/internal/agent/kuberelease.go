package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/converge"
	"github.com/better-compute/better-compute/daemon/internal/journal"
)

// Releasing a Kubernetes binding (round-5 review MED): its CDI spec goes at once, so bcd stops
// advertising the devices and the kube reaper evicts pods still holding them, but AllocationReleased
// is reported only once no pod holds a device of the allocation (kube.Manager.InUse, fail closed).
// Until then the control plane keeps the GPUs booked, and bcd keeps them claimed (no hold or VM gets
// them). The pending releases survive a restart in <data_dir>/releasing.json; one pending longer
// than releaseStuckAfter is a KubernetesReleaseStuck condition.

const (
	releasingFile     = "releasing.json"
	releaseStuckAfter = 5 * time.Minute
	releaseRecheck    = 30 * time.Second
)

type releasing struct {
	DeviceIDs  []string  `json:"deviceIds"`
	Generation uint64    `json:"generation"`
	Since      time.Time `json:"since"`
}

func (d *devicesConverger) releasingPath() string {
	return filepath.Join(d.a.o.DataDir, releasingFile)
}

// loadReleasing reads the pending releases (none when the file is missing or unreadable: logged).
func (d *devicesConverger) loadReleasing() map[string]releasing {
	out := map[string]releasing{}
	raw, err := os.ReadFile(d.releasingPath())
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			d.a.log.Warn("pending Kubernetes releases unreadable", "err", err.Error())
		}
		return out
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		d.a.log.Warn("pending Kubernetes releases unreadable", "err", err.Error())
		return map[string]releasing{}
	}
	return out
}

func (d *devicesConverger) saveReleasing(m map[string]releasing) error {
	if len(m) == 0 {
		if err := os.Remove(d.releasingPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	tmp := d.releasingPath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, d.releasingPath())
}

// updateReleasing applies change to the pending releases under the converger's lock.
func (d *devicesConverger) updateReleasing(change func(map[string]releasing)) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.loadReleasing()
	change(m)
	return d.saveReleasing(m)
}

// inUse reports whether a pod may still hold a device of the allocation (tests replace it); kube
// also checks the host's pod processes for its whole GPUs.
func (d *devicesConverger) inUse(ctx context.Context, allocationID string, deviceIDs []string) bool {
	if d.inUseHook != nil {
		return d.inUseHook(ctx, allocationID)
	}
	if d.a.kube == nil {
		return false
	}
	return d.a.kube.InUseDevices(ctx, allocationID, deviceIDs)
}

// releaseActions reports the pending releases no pod holds any more; wanted ones (bound again) are
// dropped unreported.
func (d *devicesConverger) releaseActions(wanted map[string]bool) []converge.Action {
	d.mu.Lock()
	pending := d.loadReleasing()
	d.mu.Unlock()
	ids := make([]string, 0, len(pending))
	for id := range pending {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var actions []converge.Action
	for _, id := range ids {
		id, r := id, pending[id]
		if wanted[id] {
			actions = append(actions, converge.Action{Description: "drop the pending release of " + id, Apply: func(context.Context) error {
				return d.updateReleasing(func(m map[string]releasing) { delete(m, id) })
			}})
			continue
		}
		actions = append(actions, converge.Action{
			Description: "report the release of " + id + " once no pod holds it",
			Apply: func(ctx context.Context) error {
				if d.inUse(ctx, id, r.DeviceIDs) {
					if since := time.Since(r.Since); since > releaseStuckAfter {
						d.a.log.Warn("a released Kubernetes allocation is still in use", "allocation", id, "since", since.Round(time.Second).String())
					}
					d.recheckSoon()
					return nil
				}
				d.a.log.Info("allocation released", "allocation", id, "generation", r.Generation, "kubernetes", true)
				d.a.emitAttested(journal.ClassTransition, "allocation.released", &agentv1.AttestedReportBody{
					Report: &agentv1.AttestedReportBody_AllocationReleased{AllocationReleased: &agentv1.AllocationReleased{
						AllocationId: id, Generation: r.Generation, DeviceIds: r.DeviceIDs,
					}},
				})
				return d.updateReleasing(func(m map[string]releasing) { delete(m, id) })
			},
		})
	}
	return actions
}

// recheckSoon converges again in releaseRecheck (a backstop: kube's Freed hook usually comes first).
func (d *devicesConverger) recheckSoon() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.recheck != nil {
		return
	}
	d.recheck = time.AfterFunc(releaseRecheck, func() {
		d.mu.Lock()
		d.recheck = nil
		d.mu.Unlock()
		d.a.triggerConverge()
	})
}

// releasingDevices are the devices of pending releases (still claimed): device id → allocation.
func (d *devicesConverger) releasingDevices() map[string]string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := map[string]string{}
	for id, r := range d.loadReleasing() {
		for _, dev := range r.DeviceIDs {
			out[dev] = id
		}
	}
	return out
}

// currentConditions: a KubernetesReleaseStuck condition per release pending past releaseStuckAfter.
func (d *devicesConverger) currentConditions() []*agentv1.Condition {
	if d == nil {
		return nil
	}
	d.mu.Lock()
	pending := d.loadReleasing()
	d.mu.Unlock()
	var ids []string
	for id, r := range pending {
		if time.Since(r.Since) > releaseStuckAfter {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	var out []*agentv1.Condition
	for _, id := range ids {
		r := pending[id]
		out = append(out, &agentv1.Condition{
			Type:   "KubernetesReleaseStuck",
			Status: agentv1.ConditionStatus_CONDITION_STATUS_TRUE,
			Reason: "PodsHoldDevices",
			Message: fmt.Sprintf("allocation %s was released at generation %d, but a pod still holds %s (or pod-resources is unreachable) since %s",
				id, r.Generation, strings.Join(r.DeviceIDs, ", "), r.Since.UTC().Format(time.RFC3339)),
		})
	}
	return out
}
