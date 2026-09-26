package agent

import (
	"context"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"google.golang.org/protobuf/proto"
)

// DefaultInventoryInterval is how often the inventory is collected again without a reason: GPU
// error counters (ECC, row remapping) and MIG state change without an event bcd sees.
const DefaultInventoryInterval = 10 * time.Minute

// inventoryLoop collects the inventory again every InventoryInterval, and soon after an XID (the
// GPU's counters and state move with it), sending the sections that changed.
func (a *Agent) inventoryLoop(ctx context.Context) {
	interval := a.o.InventoryInterval
	if interval <= 0 {
		interval = DefaultInventoryInterval
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-a.rescan:
			// XIDs come in bursts: let the burst end, then read once.
			if sleepCtx(ctx, 2*time.Second) != nil {
				return
			}
			drain(a.rescan)
		}
		a.refreshSections()
	}
}

// requestRescan asks inventoryLoop for a collection soon.
func (a *Agent) requestRescan() {
	select {
	case a.rescan <- struct{}{}:
	default:
	}
}

func drain(ch chan struct{}) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

// gpuXids lists each GPU's active XID conditions of this boot ("Xid79", ...).
func (a *Agent) gpuXids() map[string][]string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := map[string][]string{}
	for _, f := range a.faults {
		if strings.HasPrefix(f.GetType(), "Xid") && f.GetDeviceId() != "" {
			out[f.GetDeviceId()] = append(out[f.GetDeviceId()], f.GetType())
		}
	}
	for _, kinds := range out {
		sort.Strings(kinds)
	}
	return out
}

// clearGpuFaults drops a GPU's XID conditions (a reset brought it back healthy) and re-sends the
// status without them.
func (a *Agent) clearGpuFaults(uuid string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	kept := a.faults[:0:0]
	for _, f := range a.faults {
		if f.GetDeviceId() != uuid {
			kept = append(kept, f)
		}
	}
	if len(kept) == len(a.faults) {
		return
	}
	a.log.Info("GPU XID conditions cleared after a reset", "gpu", uuid)
	defer a.kube.Trigger()
	a.faults = kept
	a.saveFaultsLocked()
	if a.lastStatus != nil {
		a.lastStatus = proto.Clone(a.lastStatus).(*agentv1.StatusReport)
		a.lastStatus.Conditions = append(withoutFaults(a.lastStatus.Conditions), cloneConditions(a.faults)...)
		a.sendStatusLocked()
	}
}

// pcieLinkWidth reads a GPU's negotiated and maximum PCIe link width from sysfs (bus id
// "00000000:18:00.0" is the device 0000:18:00.0).
func (a *Agent) pcieLinkWidth(busID string) (current, max int, ok bool) {
	domain, rest, found := strings.Cut(strings.ToLower(busID), ":")
	if !found {
		return 0, 0, false
	}
	if len(domain) > 4 {
		domain = domain[len(domain)-4:]
	}
	dir := a.host.Path("/sys/bus/pci/devices/" + domain + ":" + rest)
	read := func(name string) (int, bool) {
		b, err := os.ReadFile(dir + "/" + name)
		if err != nil {
			return 0, false
		}
		n, err := strconv.Atoi(strings.TrimSpace(string(b)))
		return n, err == nil && n > 0
	}
	current, ok1 := read("current_link_width")
	max, ok2 := read("max_link_width")
	return current, max, ok1 && ok2
}
