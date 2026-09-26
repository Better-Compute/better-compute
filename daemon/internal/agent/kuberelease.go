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

// releasingUnreadableFile marks pending releases lost to an unreadable releasing.json. While it is
// there every GPU of the node counts as claimed (a pod of a lost release may still hold it) and the
// node reports KubernetesReleasesUnreadable. It goes once kube says no pod holds a bcd GPU of an
// allocation this node does not know (releasesUnaccounted), or when an operator removes it.
const releasingUnreadableFile = "releasing.unreadable"

func (d *devicesConverger) unreadableMarker() string {
	return filepath.Join(d.a.o.DataDir, releasingUnreadableFile)
}

// releasesUnreadable reports the marker.
func (d *devicesConverger) releasesUnreadable() bool {
	_, err := os.Stat(d.unreadableMarker())
	return err == nil
}

// loadReleasing reads the pending releases. An unreadable file is set aside (kept, never deleted) and
// marked: its releases are unknown, so the node fails closed (releasingDevices) until it is cleared.
func (d *devicesConverger) loadReleasing() map[string]releasing {
	out := map[string]releasing{}
	raw, err := os.ReadFile(d.releasingPath())
	if errors.Is(err, os.ErrNotExist) {
		return out
	}
	if err == nil {
		if err = json.Unmarshal(raw, &out); err == nil {
			return out
		}
	}
	d.a.log.Error("pending Kubernetes releases unreadable: every GPU stays claimed until no pod holds one", "err", err.Error())
	if werr := os.WriteFile(d.unreadableMarker(), []byte(time.Now().UTC().Format(time.RFC3339)+" "+err.Error()+"\n"), 0o600); werr != nil {
		d.a.log.Error("the unreadable-releases marker was not written", "err", werr.Error())
	}
	aside := fmt.Sprintf("%s.unreadable-%d", d.releasingPath(), time.Now().Unix())
	if rerr := os.Rename(d.releasingPath(), aside); rerr != nil {
		d.a.log.Error("the unreadable releases file was not set aside", "err", rerr.Error())
	}
	return map[string]releasing{}
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
	if d.releasesUnreadable() {
		actions = append(actions, converge.Action{Description: "free the GPUs once no pod holds one of an unknown release", Apply: func(ctx context.Context) error {
			live := map[string]bool{}
			for id := range wanted {
				live[id] = true
			}
			for id := range pending {
				live[id] = true
			}
			if held, err := d.observed(); err == nil {
				for id := range held {
					live[id] = true
				}
			}
			d.clearUnreadable(ctx, live)
			return nil
		}})
	}
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

// unknownRelease names, in claims, the GPUs held for releases an unreadable file lost.
const unknownRelease = "(pending Kubernetes releases that could not be read)"

// releasingDevices are the devices of pending releases (still claimed): device id → allocation.
// With the releases unreadable, every GPU of the node is (the node's holds claim theirs anyway).
func (d *devicesConverger) releasingDevices() map[string]string {
	d.mu.Lock()
	out := map[string]string{}
	for id, r := range d.loadReleasing() {
		for _, dev := range r.DeviceIDs {
			out[dev] = id
		}
	}
	d.mu.Unlock()
	if d.releasesUnreadable() {
		d.a.invMu.Lock()
		for _, uuid := range gpuUUIDs(d.a.inv) {
			if _, ok := out[uuid]; !ok {
				out[uuid] = unknownRelease
			}
		}
		d.a.invMu.Unlock()
	}
	return out
}

// clearUnreadable drops the marker once kube says no pod holds a bcd GPU of an allocation other than
// live ones (the node's holds and its pending releases): whatever the lost file held has let go.
func (d *devicesConverger) clearUnreadable(ctx context.Context, live map[string]bool) {
	if !d.releasesUnreadable() || d.releasesUnaccounted == nil || d.releasesUnaccounted(ctx, live) {
		return
	}
	if err := os.Remove(d.unreadableMarker()); err == nil {
		d.a.log.Info("no pod holds a GPU of an unknown release: the node's GPUs are free again")
	}
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
	if d.releasesUnreadable() {
		out = append(out, &agentv1.Condition{
			Type:   "KubernetesReleasesUnreadable",
			Status: agentv1.ConditionStatus_CONDITION_STATUS_TRUE,
			Reason: "ReleasesFileUnreadable",
			Message: "the pending Kubernetes releases (" + releasingFile + ") could not be read: every GPU stays claimed until no pod holds one of an unknown allocation, or an operator removes " +
				d.unreadableMarker(),
		})
	}
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
