package dispatch

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/journal"
)

// blockedFor is how long a test waits to conclude that something is blocked. Waiting longer only
// slows the test; it cannot make it flaky, because the blocked side can never proceed on its own.
const blockedFor = 30 * time.Millisecond

func TestSemaphore(t *testing.T) {
	s := NewSemaphore(2)
	if !s.TryAcquire() || !s.TryAcquire() {
		t.Fatal("TryAcquire failed below capacity")
	}
	if s.TryAcquire() {
		t.Fatal("TryAcquire succeeded at capacity")
	}
	if s.InUse() != 2 || s.Cap() != 2 {
		t.Fatalf("InUse/Cap = %d/%d", s.InUse(), s.Cap())
	}

	ctx, cancel := context.WithTimeout(context.Background(), blockedFor)
	defer cancel()
	if err := s.Acquire(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Acquire at capacity = %v; want DeadlineExceeded", err)
	}

	acquired := make(chan error, 1)
	go func() { acquired <- s.Acquire(context.Background()) }()
	select {
	case err := <-acquired:
		t.Fatalf("Acquire returned %v at capacity", err)
	case <-time.After(blockedFor):
	}
	s.Release()
	select {
	case err := <-acquired:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Acquire did not return after Release")
	}

	s.Release()
	s.Release()
	defer func() {
		if recover() == nil {
			t.Fatal("releasing an idle semaphore did not panic")
		}
	}()
	s.Release()
}

func TestDefaultLanes(t *testing.T) {
	lanes, err := NewLanes(DefaultLanes())
	if err != nil {
		t.Fatal(err)
	}
	want := map[Lane][2]int{LaneControl: {8, 4}, LaneProvision: {4, 2}, LaneBulk: {2, 1}}
	for id, sizes := range want {
		credits, workers := sizes[0], sizes[1]
		var releases []func()
		for i := 0; i < credits; i++ {
			release, ok, err := lanes.Admit(id)
			if err != nil || !ok {
				t.Fatalf("%s: Admit %d = %v, %v", id, i, ok, err)
			}
			releases = append(releases, release)
		}
		if _, ok, err := lanes.Admit(id); err != nil || ok {
			t.Fatalf("%s: Admit past %d credits = %v, %v; want BUSY", id, credits, ok, err)
		}
		// Releasing twice frees one credit only.
		releases[0]()
		releases[0]()
		if got, _ := lanes.InUse(id); got != credits-1 {
			t.Fatalf("%s: credits in use = %d, want %d", id, got, credits-1)
		}

		var done []func()
		for i := 0; i < workers; i++ {
			release, err := lanes.Work(context.Background(), id)
			if err != nil {
				t.Fatalf("%s: Work %d: %v", id, i, err)
			}
			done = append(done, release)
		}
		if err := workWithTimeout(lanes, id); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("%s: Work past %d workers = %v; want to block", id, workers, err)
		}
		for _, release := range done {
			release()
		}
		for _, release := range releases[1:] {
			release()
		}
		if c, w := lanes.InUse(id); c != 0 || w != 0 {
			t.Fatalf("%s: in use after release = %d credits, %d workers", id, c, w)
		}
	}
}

func workWithTimeout(lanes *Lanes, id Lane) error {
	ctx, cancel := context.WithTimeout(context.Background(), blockedFor)
	defer cancel()
	_, err := lanes.Work(ctx, id)
	return err
}

func TestLanesRejectBadConfig(t *testing.T) {
	bad := []map[Lane]LaneConfig{
		{LaneControl: {Credits: 2, Workers: 3}},
		{LaneControl: {Credits: 2, Workers: 0}},
		{Lane(9): {Credits: 1, Workers: 1}},
	}
	for _, config := range bad {
		if _, err := NewLanes(config); err == nil {
			t.Errorf("NewLanes(%v) succeeded", config)
		}
	}
	lanes, err := NewLanes(map[Lane]LaneConfig{LaneControl: {Credits: 1, Workers: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := lanes.Admit(LaneBulk); !errors.Is(err, ErrUnknownLane) {
		t.Fatalf("Admit(bulk) = %v; want ErrUnknownLane", err)
	}
	if _, err := lanes.Work(context.Background(), LaneBulk); !errors.Is(err, ErrUnknownLane) {
		t.Fatalf("Work(bulk) = %v; want ErrUnknownLane", err)
	}
}

func TestKeyedMutex(t *testing.T) {
	var k KeyedMutex
	unlockA, err := k.Lock(context.Background(), "gpu-a")
	if err != nil {
		t.Fatal(err)
	}
	// Another key is independent.
	unlockB, err := k.Lock(context.Background(), "gpu-b")
	if err != nil {
		t.Fatal(err)
	}
	unlockB()

	ctx, cancel := context.WithTimeout(context.Background(), blockedFor)
	defer cancel()
	if _, err := k.Lock(ctx, "gpu-a"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second Lock(gpu-a) = %v; want to block", err)
	}

	locked := make(chan func(), 1)
	go func() {
		unlock, err := k.Lock(context.Background(), "gpu-a")
		if err != nil {
			t.Error(err)
		}
		locked <- unlock
	}()
	select {
	case <-locked:
		t.Fatal("Lock(gpu-a) succeeded while held")
	case <-time.After(blockedFor):
	}
	unlockA()
	unlockA()
	select {
	case unlock := <-locked:
		unlock()
	case <-time.After(5 * time.Second):
		t.Fatal("Lock(gpu-a) did not succeed after unlock")
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if len(k.locks) != 0 {
		t.Fatalf("%d keys still tracked after every unlock", len(k.locks))
	}
}

type nopHandler struct{}

func (nopHandler) Run(context.Context, Command) (journal.Result, error) {
	return journal.Result{Outcome: journal.OutcomeSucceeded}, nil
}

func TestRegistry(t *testing.T) {
	reg, err := NewRegistry(Kind{Name: "diag.nvml", Lane: LaneControl, Roles: []Role{RoleNode, RoleRamdisk}, Handler: nopHandler{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := reg.Lookup("diag.nvml", RoleNode); !ok {
		t.Fatal("diag.nvml not found for the node role")
	}
	if _, ok := reg.Lookup("diag.nvml", RoleSite); ok {
		t.Fatal("diag.nvml allowed for the site role")
	}
	if _, ok := reg.Lookup("node.reboot", RoleNode); ok {
		t.Fatal("unregistered kind found")
	}
	var empty *Registry
	if _, ok := empty.Lookup("diag.nvml", RoleNode); ok {
		t.Fatal("nil registry found a kind")
	}

	invalid := [][]Kind{
		{{Name: "a", Lane: LaneControl, Roles: []Role{RoleNode}}},
		{{Name: "a", Lane: Lane(0), Roles: []Role{RoleNode}, Handler: nopHandler{}}},
		{{Name: "a", Lane: LaneControl, Handler: nopHandler{}}},
		{
			{Name: "a", Lane: LaneControl, Roles: []Role{RoleNode}, Handler: nopHandler{}},
			{Name: "a", Lane: LaneBulk, Roles: []Role{RoleNode}, Handler: nopHandler{}},
		},
	}
	for _, kinds := range invalid {
		if _, err := NewRegistry(kinds...); err == nil {
			t.Errorf("NewRegistry(%+v) succeeded", kinds)
		}
	}
}

func TestPrecheck(t *testing.T) {
	now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)
	reg, err := NewRegistry(Kind{Name: "diag.nvml", Lane: LaneControl, Roles: []Role{RoleNode}, Handler: nopHandler{}})
	if err != nil {
		t.Fatal(err)
	}
	live := now.Add(time.Minute)
	cmd := func(kind string, notAfter time.Time, minGeneration uint64) Command {
		return Command{NodeID: "node_1", Kind: kind, NotAfter: notAfter, MinGeneration: minGeneration}
	}
	env := func(role Role, applied uint64, deferred bool) Env {
		return Env{Now: now, NodeID: "node_1", Role: role, AppliedGeneration: applied, Deferred: deferred}
	}
	foreign := cmd("diag.nvml", live, 0)
	foreign.NodeID = "node_2"
	cases := []struct {
		name string
		cmd  Command
		env  Env
		want Verdict
	}{
		{"accepted", cmd("diag.nvml", live, 0), env(RoleNode, 0, false), Verdict{}},
		{"another node's command", foreign, env(RoleNode, 0, false), Verdict{Reject: RejectUnsupported}},
		{"unknown kind", cmd("gpu.reset", live, 0), env(RoleNode, 0, false), Verdict{Reject: RejectUnsupported}},
		{"role not allowed", cmd("diag.nvml", live, 0), env(RoleSite, 0, false), Verdict{Reject: RejectUnsupported}},
		{"past not_after", cmd("diag.nvml", now, 0), env(RoleNode, 0, false), Verdict{Reject: RejectExpired}},
		{"missing not_after", cmd("diag.nvml", time.Time{}, 0), env(RoleNode, 0, false), Verdict{Reject: RejectExpired}},
		{"spec behind", cmd("diag.nvml", live, 3), env(RoleNode, 2, false), Verdict{Defer: true}},
		{"spec caught up", cmd("diag.nvml", live, 3), env(RoleNode, 3, false), Verdict{}},
		{"deferred until not_after", cmd("diag.nvml", now, 3), env(RoleNode, 2, true), Verdict{Reject: RejectStaleGeneration}},
		{"first seen stale and late", cmd("diag.nvml", now, 3), env(RoleNode, 2, false), Verdict{Reject: RejectExpired}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Precheck(tc.cmd, reg, tc.env)
			if got != tc.want {
				t.Fatalf("Precheck = %+v, want %+v", got, tc.want)
			}
			if got.Accepted() != (tc.want == Verdict{}) {
				t.Fatalf("Accepted() = %v for %+v", got.Accepted(), got)
			}
		})
	}
}

func TestCommandDelivery(t *testing.T) {
	c := Command{ID: "cmd_1", Kind: "node.reboot", RetrySafe: false, SelfTerminating: true}
	want := journal.Delivery{ID: "cmd_1", Kind: "node.reboot", SelfTerminating: true}
	if got := c.Delivery(); got != want {
		t.Fatalf("Delivery() = %+v, want %+v", got, want)
	}
}
