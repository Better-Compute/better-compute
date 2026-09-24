package session

import (
	"math/rand"
	"reflect"
	"testing"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/journal"
)

var t0 = time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)

var node = Identity{NodeID: "node_1", Role: dispatch.RoleNode, DaemonVersion: "0.1.0", Capabilities: []string{"cdi"}}

func TestNewHelloReportsJournalState(t *testing.T) {
	j := journal.NewMemory("node_1", journal.MemoryOptions{})
	old := journal.Runtime{BootID: "boot-1", Incarnation: "inc-1", Now: t0}
	now := journal.Runtime{BootID: "boot-2", Incarnation: "inc-2", Now: t0}

	accept := func(rt journal.Runtime, d journal.Delivery) {
		t.Helper()
		if err := journal.Accept(j, d, rt); err != nil {
			t.Fatal(err)
		}
	}
	// Left by the previous process: a reboot it caused, and an acked result.
	accept(old, journal.Delivery{ID: "a-reboot", Kind: "node.reboot", SelfTerminating: true})
	if err := journal.MarkRunning(j, "a-reboot", old); err != nil {
		t.Fatal(err)
	}
	accept(old, journal.Delivery{ID: "b-acked", Kind: "diag.nvml"})
	if err := journal.Complete(j, "b-acked", journal.Result{Outcome: journal.OutcomeSucceeded}, t0); err != nil {
		t.Fatal(err)
	}
	if err := journal.AckResult(j, "b-acked"); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.Recover(j, now); err != nil {
		t.Fatal(err)
	}
	// This process: one command running.
	accept(now, journal.Delivery{ID: "c-running", Kind: "inventory.refresh", RetrySafe: true})

	if _, err := j.AppendEvent(journal.Event{Class: journal.ClassTransition, Kind: "node.booted"}); err != nil {
		t.Fatal(err)
	}
	if err := j.SaveMeta(journal.Meta{NodeID: "node_1", LastEpoch: 4, AppliedGeneration: 2}); err != nil {
		t.Fatal(err)
	}
	if err := j.SaveSpec(journal.Spec{Generation: 2, Hash: []byte{0xab}}); err != nil {
		t.Fatal(err)
	}

	hashes := map[string][]byte{"gpus": {1, 2, 3}}
	h, err := NewHello(j, node, now, hashes)
	if err != nil {
		t.Fatal(err)
	}
	meta, _ := j.Meta()
	if h.NodeID != "node_1" || h.BootID != "boot-2" || h.JournalID != meta.JournalID || h.Role != dispatch.RoleNode {
		t.Fatalf("identity fields = %+v", h)
	}
	if h.ProtoMin != ProtoMin || h.ProtoMax != ProtoMax || h.DaemonVersion != "0.1.0" || !reflect.DeepEqual(h.Capabilities, []string{"cdi"}) {
		t.Fatalf("version fields = %+v", h)
	}
	if h.LastEpoch != 4 || h.AppliedGeneration != 2 || h.LastEventSeq != 1 {
		t.Fatalf("cursors = epoch %d, generation %d, event seq %d", h.LastEpoch, h.AppliedGeneration, h.LastEventSeq)
	}
	if len(h.UnackedResults) != 1 || h.UnackedResults[0].ID != "a-reboot" || !h.UnackedResults[0].Result.Rebooted {
		t.Fatalf("unacked results = %+v; want only the rebooted a-reboot", h.UnackedResults)
	}
	if !reflect.DeepEqual(h.RunningCommandIDs, []string{"c-running"}) {
		t.Fatalf("running = %v; want [c-running]", h.RunningCommandIDs)
	}
	if !reflect.DeepEqual(h.InventoryHashes, hashes) || !reflect.DeepEqual(h.AppliedSpecHash, []byte{0xab}) {
		t.Fatalf("inventory hashes = %v, applied spec hash = %x", h.InventoryHashes, h.AppliedSpecHash)
	}
}

func TestNewHelloRefusesAnotherNodesJournal(t *testing.T) {
	j := journal.NewMemory("node_2", journal.MemoryOptions{})
	if _, err := NewHello(j, node, journal.Runtime{BootID: "b", Incarnation: "i"}, nil); err == nil {
		t.Fatal("NewHello used another node's journal")
	}
}

func TestApplyWelcome(t *testing.T) {
	j := journal.NewMemory("node_1", journal.MemoryOptions{})
	for _, kind := range []string{"e1", "e2", "e3"} {
		if _, err := j.AppendEvent(journal.Event{Class: journal.ClassTransition, Kind: kind}); err != nil {
			t.Fatal(err)
		}
	}
	w := Welcome{Epoch: 5, AckedEventSeq: 2, ServerTime: t0}
	if err := ApplyWelcome(j, w); err != nil {
		t.Fatal(err)
	}
	meta, _ := j.Meta()
	if meta.LastEpoch != 5 {
		t.Fatalf("last epoch = %d, want 5", meta.LastEpoch)
	}
	events, _ := j.UnackedEvents()
	if len(events) != 1 || events[0].Kind != "e3" {
		t.Fatalf("unacked events = %+v; want only e3", events)
	}
	if got := w.ClockOffset(t0.Add(-3 * time.Second)); got != 3*time.Second {
		t.Fatalf("clock offset = %v, want 3s", got)
	}
	if w.Heartbeat() != DefaultHeartbeat {
		t.Fatalf("heartbeat = %v, want the default", w.Heartbeat())
	}
	w.HeartbeatInterval = 5 * time.Second
	if w.Heartbeat() != 5*time.Second {
		t.Fatalf("heartbeat = %v, want 5s", w.Heartbeat())
	}
}

func TestApplyAck(t *testing.T) {
	j := journal.NewMemory("node_1", journal.MemoryOptions{})
	rt := journal.Runtime{BootID: "boot-1", Incarnation: "inc-1", Now: t0}
	for _, id := range []string{"done", "running"} {
		if err := journal.Accept(j, journal.Delivery{ID: id, Kind: "diag.nvml"}, rt); err != nil {
			t.Fatal(err)
		}
	}
	if err := journal.Complete(j, "done", journal.Result{Outcome: journal.OutcomeSucceeded}, t0); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"e1", "e2"} {
		if _, err := j.AppendEvent(journal.Event{Class: journal.ClassTransition, Kind: kind}); err != nil {
			t.Fatal(err)
		}
	}
	meta, _ := j.Meta()

	// An Ack for another journal acks no events, but results are acked by command id.
	if err := ApplyAck(j, Ack{JournalID: "jrn_other", EventSeq: 2, CommandIDs: []string{"done", "running", "unknown"}}); err != nil {
		t.Fatal(err)
	}
	if stats, _ := j.EventStats(); stats.Count != 2 {
		t.Fatalf("events after a foreign ack = %d, want 2", stats.Count)
	}
	if c, _, _ := j.Command("done"); !c.ResultAcked {
		t.Fatal("the done command's result is still unacked")
	}
	if c, _, _ := j.Command("running"); c.State != journal.StateAccepted || c.ResultAcked {
		t.Fatalf("an unfinished command changed: %+v", c)
	}
	if err := ApplyAck(j, Ack{JournalID: meta.JournalID, EventSeq: 1}); err != nil {
		t.Fatal(err)
	}
	if stats, _ := j.EventStats(); stats.Count != 1 {
		t.Fatalf("events after ack 1 = %d, want 1", stats.Count)
	}

	h, err := NewHello(j, node, rt, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.UnackedResults) != 0 || !reflect.DeepEqual(h.RunningCommandIDs, []string{"running"}) {
		t.Fatalf("hello = %+v", h)
	}
}

func TestBackoff(t *testing.T) {
	b := DefaultBackoff
	want := []time.Duration{1, 2, 4, 8, 16, 32, 60, 60}
	for attempt, seconds := range want {
		if got := b.Ceiling(attempt); got != seconds*time.Second {
			t.Fatalf("Ceiling(%d) = %v, want %v", attempt, got, seconds*time.Second)
		}
	}
	if got := b.Ceiling(1000); got != time.Minute {
		t.Fatalf("Ceiling(1000) = %v, want 1m", got)
	}
	r := rand.New(rand.NewSource(1))
	for attempt := 0; attempt < 10; attempt++ {
		for i := 0; i < 100; i++ {
			if d := b.Delay(attempt, r); d < 0 || d > b.Ceiling(attempt) {
				t.Fatalf("Delay(%d) = %v outside [0, %v]", attempt, d, b.Ceiling(attempt))
			}
		}
	}
	if d := (Backoff{}).Delay(3, r); d != 0 {
		t.Fatalf("zero backoff delay = %v", d)
	}
}
