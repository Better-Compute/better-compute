package journal

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func openBolt(t *testing.T, path string, opts BoltOptions) *Bolt {
	t.Helper()
	b, err := OpenBolt(path, opts)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Everything the command rules and Hello rely on survives a process restart (a reopen).
func TestBoltSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.db")
	b := openBolt(t, path, BoltOptions{})
	meta, _ := b.Meta()
	if meta.JournalID == "" {
		t.Fatal("no journal id")
	}
	now := time.Unix(1_700_000_000, 0)
	rt := Runtime{BootID: "boot-1", Incarnation: "inc_1", Now: now}
	if err := b.SaveMeta(Meta{NodeID: "node_1", LastEpoch: 7, AppliedGeneration: 3}); err != nil {
		t.Fatal(err)
	}
	d := Delivery{ID: "cmd_1", Kind: "node.reboot", SelfTerminating: true}
	if err := Accept(b, d, rt); err != nil {
		t.Fatal(err)
	}
	if err := MarkRunning(b, "cmd_1", rt); err != nil {
		t.Fatal(err)
	}
	if err := Accept(b, Delivery{ID: "cmd_2", Kind: "diag.nvml"}, rt); err != nil {
		t.Fatal(err)
	}
	if _, err := b.AppendEvent(Event{Class: ClassTransition, Kind: "allocation.bound", Payload: []byte{1, 2}}); err != nil {
		t.Fatal(err)
	}
	if err := b.SaveSpec(Spec{Generation: 3, Hash: []byte{9}, Body: []byte("spec")}); err != nil {
		t.Fatal(err)
	}
	if err := b.SaveCerts(Certs{Chain: [][]byte{{1}}, NotAfter: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if fresh, err := b.RememberTicket("jti-1", now.Add(time.Minute), now); !fresh || err != nil {
		t.Fatalf("ticket: %v %v", fresh, err)
	}
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}

	// The process restarts after the reboot the self-terminating command caused.
	b = openBolt(t, path, BoltOptions{})
	defer b.Close()
	again, _ := b.Meta()
	if again.JournalID != meta.JournalID || again.NodeID != "node_1" || again.LastEpoch != 7 || again.AppliedGeneration != 3 || again.EventSeq != 1 {
		t.Fatalf("meta after reopen = %+v", again)
	}
	rt2 := Runtime{BootID: "boot-2", Incarnation: "inc_2", Now: now.Add(time.Minute)}
	done, err := Recover(b, rt2)
	if err != nil {
		t.Fatal(err)
	}
	if len(done) != 2 {
		t.Fatalf("recovered %d commands, want 2", len(done))
	}
	for _, c := range done {
		switch c.ID {
		case "cmd_1":
			if !c.Result.Rebooted || c.Result.Outcome != OutcomeSucceeded {
				t.Fatalf("cmd_1 = %+v", c.Result)
			}
		case "cmd_2":
			if c.Result.Outcome != OutcomeFailed || c.Result.Reason != ReasonInterrupted {
				t.Fatalf("cmd_2 = %+v", c.Result)
			}
		}
	}
	events, _ := b.UnackedEvents()
	if len(events) != 1 || events[0].Seq != 1 || events[0].Kind != "allocation.bound" {
		t.Fatalf("events = %+v", events)
	}
	if s, ok, _ := b.Spec(); !ok || s.Generation != 3 || string(s.Body) != "spec" {
		t.Fatalf("spec = %+v %v", s, ok)
	}
	if c, ok, _ := b.Certs(); !ok || len(c.Chain) != 1 {
		t.Fatalf("certs = %+v %v", c, ok)
	}
	if fresh, _ := b.RememberTicket("jti-1", now.Add(time.Minute), now.Add(time.Second)); fresh {
		t.Fatal("a replayed ticket was fresh after reopen")
	}
	if err := b.SaveSpec(Spec{Generation: 2}); !errors.Is(err, ErrStaleSpec) {
		t.Fatalf("older spec: %v", err)
	}
}

func TestBoltEventCapsAndAcks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.db")
	b := openBolt(t, path, BoltOptions{MaxEvents: 3})
	for i := 0; i < 2; i++ {
		if _, err := b.AppendEvent(Event{Class: ClassMetric, Kind: "m"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := b.AppendEvent(Event{Class: ClassResult, Kind: "r"}); err != nil {
		t.Fatal(err)
	}
	// Full: a transition drops the oldest metric; once only non-metrics are left, it is ErrFull.
	if e, err := b.AppendEvent(Event{Class: ClassTransition, Kind: "t"}); err != nil || e.Seq != 4 {
		t.Fatalf("append = %+v %v", e, err)
	}
	if _, err := b.AppendEvent(Event{Class: ClassTransition, Kind: "t2"}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.AppendEvent(Event{Class: ClassTransition, Kind: "t3"}); !errors.Is(err, ErrFull) {
		t.Fatalf("want ErrFull, got %v", err)
	}
	stats, _ := b.EventStats()
	if stats.Count != 3 || stats.DroppedMetrics != 2 {
		t.Fatalf("stats = %+v", stats)
	}
	if err := b.AckEvents(4); err != nil {
		t.Fatal(err)
	}
	b.Close()
	b = openBolt(t, path, BoltOptions{MaxEvents: 3})
	defer b.Close()
	events, _ := b.UnackedEvents()
	if len(events) != 1 || events[0].Kind != "t2" {
		t.Fatalf("after ack and reopen = %+v", events)
	}
	stats, _ = b.EventStats()
	if stats.DroppedMetrics != 2 {
		t.Fatalf("dropped count lost on reopen: %+v", stats)
	}
}

func TestBoltCorruptFileStartsANewJournal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.db")
	if err := os.WriteFile(path, []byte("not a bolt file"), 0o600); err != nil {
		t.Fatal(err)
	}
	b := openBolt(t, path, BoltOptions{})
	defer b.Close()
	if meta, _ := b.Meta(); meta.JournalID == "" {
		t.Fatal("no journal id")
	}
	matches, _ := filepath.Glob(path + ".corrupt-*")
	if len(matches) != 1 {
		t.Fatalf("corrupt file not moved aside: %v", matches)
	}
}
