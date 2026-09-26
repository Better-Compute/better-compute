package agent

import (
	"context"
	"sort"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// Memory ballooning (PLAN.md §3.8): a guest given a virtio balloon (InstancePlacement.balloon) lends
// the host the memory it does not use. bcd inflates balloons only when the host runs short and
// deflates them as soon as it has room again; it never takes a guest below its floor.

// balloonHost is the host's memory as the policy sees it: MemTotal and MemAvailable, and the memory
// pressure stall (PSI some avg10, percent).
type balloonHost struct {
	Total, Available uint64
	Pressure         float64
}

// balloonDomain is one ballooned guest.
type balloonDomain struct {
	ID string
	// Configured is the guest's memory; Current what the balloon leaves it now (Configured when
	// deflated); Used what it actually uses (from the runtime's usage).
	Configured, Current, Used uint64
}

// Balloon policy thresholds, as fractions of host memory, and the guest floor.
const (
	// balloonLow: below this much available memory the host reclaims from guests.
	balloonLow = 0.10
	// balloonHigh: above it the host gives memory back.
	balloonHigh = 0.20
	// balloonPressure: at or above this memory stall (PSI some avg10, percent) the host reclaims at
	// least balloonPressureTake of its memory, and never deflates.
	balloonPressure     = 10.0
	balloonPressureTake = 0.02
	// balloonFloor: a guest keeps at least this share of its memory ([instances]
	// balloon_floor_percent), and its use plus headroom.
	balloonFloor = 0.50
	// balloonHeadroom: over what a guest uses, as a share of its memory.
	balloonHeadroom = 0.10
	// balloonStep caps one pass's change per guest, as a share of its memory.
	balloonStep = 0.25
)

// balloonTargets returns the new size per guest that should change (absent: leave it). Short of
// memory (or stalling on it), it reclaims up to the shortfall from the guests with the most unused
// memory first; with room, it deflates every inflated balloon a step at a time. floorShare is the
// share of its memory a guest always keeps (0: balloonFloor).
func balloonTargets(host balloonHost, domains []balloonDomain, floorShare float64) map[string]uint64 {
	out := map[string]uint64{}
	if host.Total == 0 {
		return out
	}
	if floorShare <= 0 || floorShare > 1 {
		floorShare = balloonFloor
	}
	domains = append([]balloonDomain(nil), domains...) // sorted below; the caller's order stays
	low := uint64(float64(host.Total) * balloonLow)
	high := uint64(float64(host.Total) * balloonHigh)
	floor := func(d balloonDomain) uint64 {
		f := uint64(float64(d.Configured) * floorShare)
		if need := d.Used + uint64(float64(d.Configured)*balloonHeadroom); need > f {
			f = need
		}
		if f > d.Configured {
			f = d.Configured
		}
		return f
	}
	step := func(d balloonDomain) uint64 { return uint64(float64(d.Configured) * balloonStep) }
	stalled := host.Pressure >= balloonPressure
	switch {
	case host.Available < low || stalled:
		var shortfall uint64
		if host.Available < low {
			shortfall = low - host.Available
		}
		if stalled {
			shortfall = max(shortfall, uint64(float64(host.Total)*balloonPressureTake))
		}
		// The most unused (above its floor) first; ties by id for a stable plan.
		sort.Slice(domains, func(i, j int) bool {
			si, sj := slack(domains[i], floor(domains[i])), slack(domains[j], floor(domains[j]))
			if si != sj {
				return si > sj
			}
			return domains[i].ID < domains[j].ID
		})
		for _, d := range domains {
			if shortfall == 0 {
				break
			}
			take := min(slack(d, floor(d)), step(d), shortfall)
			if take == 0 {
				continue
			}
			out[d.ID] = d.Current - take
			shortfall -= take
		}
	case host.Available > high:
		room := host.Available - high
		sort.Slice(domains, func(i, j int) bool { return domains[i].ID < domains[j].ID })
		for _, d := range domains {
			if d.Current >= d.Configured || room == 0 {
				continue
			}
			give := min(d.Configured-d.Current, step(d), room)
			out[d.ID] = d.Current + give
			room -= give
		}
	}
	return out
}

// slack is what a guest can still lend: its current size above its floor.
func slack(d balloonDomain, floor uint64) uint64 {
	if d.Current <= floor {
		return 0
	}
	return d.Current - floor
}

// balloonLoop runs a balloon pass every health interval (PLAN.md §3.8).
func (a *Agent) balloonLoop(ctx context.Context) {
	t := time.NewTicker(a.o.HealthInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		a.balloonPass(ctx)
	}
}

// balloonPass resizes the balloons of the running guests whose spec gives them one
// (InstancePlacement.balloon, never with hugepages), from the host's MemAvailable and memory stall;
// it returns the sizes it set. A guest without a balloon is never touched; nor is one the runtime
// does not report as running and bcd's.
func (a *Agent) balloonPass(ctx context.Context) map[string]uint64 {
	allowed := map[string]bool{}
	for _, spec := range a.instances.currentSpecs() {
		if spec.GetPlacement().GetBalloon() && spec.GetPlacement().GetHugepageSizeBytes() == 0 {
			allowed[spec.GetInstanceId()] = true
		}
	}
	if len(allowed) == 0 {
		return nil
	}
	mem, err := a.meminfo()
	if err != nil || mem["MemTotal"] == 0 {
		return nil
	}
	host := balloonHost{Total: mem["MemTotal"], Available: mem["MemAvailable"]}
	a.mu.Lock()
	host.Pressure = float64(a.pressure.GetMemorySomeAvg10())
	a.mu.Unlock()
	var domains []balloonDomain
	owner := map[string]runtime.Ballooner{}
	for _, r := range a.o.Runtimes {
		b, ok := r.(runtime.Ballooner)
		if !ok {
			continue
		}
		list, err := r.List(ctx)
		if err != nil {
			continue
		}
		sizes, err := b.Balloons(ctx)
		if err != nil {
			a.log.Debug("balloon sizes unavailable", "runtime", r.Name(), "error", err.Error())
			continue
		}
		var usage map[string]runtime.Usage
		if reader, ok := r.(runtime.UsageReader); ok {
			usage, _ = reader.Usage(ctx)
		}
		for _, d := range list {
			if !d.Managed || d.State != runtime.StateRunning || !allowed[d.ID] || d.HugepageSize != 0 || d.MemoryBytes == 0 {
				continue
			}
			bd := balloonDomain{ID: d.ID, Configured: d.MemoryBytes, Current: d.MemoryBytes, Used: d.MemoryBytes}
			if v, ok := sizes[d.ID]; ok && v <= d.MemoryBytes {
				bd.Current = v
			}
			// Without a reading, the guest counts as using all of it: nothing is taken from it.
			if u, ok := usage[d.ID]; ok && u.MemoryBytes > 0 {
				bd.Used = min(u.MemoryBytes, d.MemoryBytes)
			}
			domains = append(domains, bd)
			owner[d.ID] = b
		}
	}
	targets := balloonTargets(host, domains, a.o.BalloonFloor)
	set := map[string]uint64{}
	for _, id := range sortedKeys(targets) {
		if err := owner[id].SetBalloon(ctx, id, targets[id]); err != nil {
			a.log.Warn("balloon not resized", "instance", id, "bytes", targets[id], "error", err.Error())
			continue
		}
		a.log.Info("balloon resized", "instance", id, "bytes", targets[id], "hostAvailable", host.Available, "memoryStall", host.Pressure)
		set[id] = targets[id]
	}
	return set
}
