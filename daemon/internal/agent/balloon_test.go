package agent

import (
	"reflect"
	"testing"
)

const gib = uint64(1) << 30

func TestBalloonTargets(t *testing.T) {
	guests := func() []balloonDomain {
		return []balloonDomain{
			{ID: "idle", Configured: 16 * gib, Current: 16 * gib, Used: 2 * gib},
			{ID: "busy", Configured: 16 * gib, Current: 16 * gib, Used: 15 * gib},
			{ID: "half", Configured: 8 * gib, Current: 8 * gib, Used: 3 * gib},
		}
	}
	// Plenty of room, nothing inflated: nothing to do.
	if got := balloonTargets(balloonHost{Total: 256 * gib, Available: 100 * gib}, guests(), 0); len(got) != 0 {
		t.Fatalf("idle host = %v", got)
	}
	// Short by 6 GiB (10% of 256 GiB is 25.6 GiB; 19.6 available): the idle guest lends first, at most
	// a quarter of its memory a pass, never below half of it or its use plus 10%; the busy guest none.
	got := balloonTargets(balloonHost{Total: 256 * gib, Available: 256*gib/10 - 6*gib}, guests(), 0)
	if !reflect.DeepEqual(got, map[string]uint64{"idle": 12 * gib, "half": 6 * gib}) {
		t.Fatalf("short host = %v", got)
	}
	// Floors hold under any pressure: repeated passes stop at 8 GiB (half) for idle, 3.8 GiB+ for half.
	domains := guests()
	for pass := 0; pass < 10; pass++ {
		targets := balloonTargets(balloonHost{Total: 256 * gib, Available: 0}, domains, 0)
		for i := range domains {
			if v, ok := targets[domains[i].ID]; ok {
				domains[i].Current = v
			}
		}
	}
	for _, d := range domains {
		if d.Current < d.Configured/2 || d.Current < d.Used {
			t.Fatalf("%s went below its floor: %d", d.ID, d.Current)
		}
	}
	if domains[1].Current != 16*gib {
		t.Fatalf("the busy guest lent memory: %d", domains[1].Current)
	}
	// Room again: balloons deflate a step (a quarter) at a time.
	got = balloonTargets(balloonHost{Total: 256 * gib, Available: 200 * gib}, domains, 0)
	if got["idle"] != domains[0].Current+4*gib || got["half"] != min(domains[2].Current+2*gib, 8*gib) {
		t.Fatalf("deflate = %v (from %+v)", got, domains)
	}
	if _, ok := got["busy"]; ok {
		t.Fatal("a deflated balloon changed")
	}
	// A memory stall reclaims (2% of the host) though MemAvailable looks fine, and never deflates.
	got = balloonTargets(balloonHost{Total: 256 * gib, Available: 200 * gib, Pressure: 25}, guests(), 0)
	var taken uint64
	for id, v := range got {
		if id == "busy" {
			t.Fatal("the busy guest lent memory under a stall")
		}
		taken += 16*gib - v
		if id == "half" {
			taken -= 8 * gib
		}
	}
	total := 256 * gib
	if want := uint64(float64(total) * balloonPressureTake); taken != want {
		t.Fatalf("stall took %d, want %d (%v)", taken, want, got)
	}
	if got := balloonTargets(balloonHost{Total: 256 * gib, Available: 200 * gib, Pressure: 25}, domains, 0); len(got) != 0 {
		t.Fatalf("deflated under a stall: %v", got)
	}
	// A higher floor ([instances] balloon_floor_percent = 90) keeps the idle guest at 14.4 GiB.
	domains = guests()
	for pass := 0; pass < 10; pass++ {
		for id, v := range balloonTargets(balloonHost{Total: 256 * gib, Available: 0}, domains, 0.9) {
			for i := range domains {
				if domains[i].ID == id {
					domains[i].Current = v
				}
			}
		}
	}
	if want := uint64(float64(domains[0].Configured) * 0.9); domains[0].Current != want {
		t.Fatalf("idle guest at %d, want the 90%% floor %d", domains[0].Current, want)
	}
}
