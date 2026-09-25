package journal

import (
	"bytes"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)

func runtimeOf(boot, incarnation string) Runtime {
	return Runtime{BootID: boot, Incarnation: incarnation, Now: t0}
}

// deliverNew delivers d for the first time and accepts it, as the dispatcher does.
func deliverNew(t *testing.T, j Journal, d Delivery, rt Runtime) {
	t.Helper()
	mustResolve(t, j, d, rt, ActionExecute)
	if err := Accept(j, d, rt); err != nil {
		t.Fatalf("Accept(%s): %v", d.ID, err)
	}
}

func mustResolve(t *testing.T, j Journal, d Delivery, rt Runtime, want Action) Decision {
	t.Helper()
	dec, err := Resolve(j, d, rt)
	if err != nil {
		t.Fatalf("Resolve(%s): %v", d.ID, err)
	}
	if dec.Action != want {
		t.Fatalf("Resolve(%s) = %s, want %s", d.ID, dec.Action, want)
	}
	return dec
}

func TestDoneCommandResendsStoredResult(t *testing.T) {
	j := NewMemory("node_1", MemoryOptions{})
	first := runtimeOf("boot-1", "inc-1")
	d := Delivery{ID: "cmd_1", Kind: "diag.nvml", RetrySafe: true}
	deliverNew(t, j, d, first)
	if err := MarkRunning(j, d.ID, first); err != nil {
		t.Fatal(err)
	}
	want := Result{Outcome: OutcomeSucceeded, Payload: []byte(`{"gpus":8}`)}
	if err := Complete(j, d.ID, want, t0); err != nil {
		t.Fatal(err)
	}
	// The same result comes back in this process, after a restart and after a reboot.
	for _, rt := range []Runtime{first, runtimeOf("boot-1", "inc-2"), runtimeOf("boot-2", "inc-3")} {
		dec := mustResolve(t, j, d, rt, ActionResend)
		if dec.Result == nil || !reflect.DeepEqual(*dec.Result, want) {
			t.Fatalf("resent %+v, want %+v", dec.Result, want)
		}
	}
}

func TestInFlightCommandReattaches(t *testing.T) {
	j := NewMemory("node_1", MemoryOptions{})
	rt := runtimeOf("boot-1", "inc-1")
	d := Delivery{ID: "cmd_1", Kind: "wipe"}
	deliverNew(t, j, d, rt)
	mustResolve(t, j, d, rt, ActionReattach)
	if err := MarkRunning(j, d.ID, rt); err != nil {
		t.Fatal(err)
	}
	mustResolve(t, j, d, rt, ActionReattach)
	c, ok, err := j.Command(d.ID)
	if err != nil || !ok || c.State != StateRunning || c.BootID != "boot-1" {
		t.Fatalf("entry = %+v, %v, %v; want running in boot-1", c, ok, err)
	}
}

func TestCrashRules(t *testing.T) {
	cases := []struct {
		name            string
		running         bool
		retrySafe       bool
		selfTerminating bool
		rebooted        bool
		want            Action
		outcome         Outcome
		wantRebooted    bool
	}{
		{"accepted, not retry-safe", false, false, false, false, ActionReport, OutcomeFailed, false},
		{"accepted, retry-safe", false, true, false, false, ActionReexecute, "", false},
		{"running, not retry-safe", true, false, false, false, ActionReport, OutcomeFailed, false},
		{"running, retry-safe", true, true, false, false, ActionReexecute, "", false},
		{"self-terminating running across a reboot", true, false, true, true, ActionReport, OutcomeSucceeded, true},
		{"retry-safe self-terminating running across a reboot is never replayed", true, true, true, true, ActionReport, OutcomeSucceeded, true},
		{"self-terminating running, same boot", true, false, true, false, ActionReport, OutcomeFailed, false},
		{"self-terminating accepted, never started, across a reboot", false, false, true, true, ActionReport, OutcomeFailed, false},
		{"retry-safe self-terminating accepted across a reboot", false, true, true, true, ActionReexecute, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			j := NewMemory("node_1", MemoryOptions{})
			before := runtimeOf("boot-1", "inc-1")
			after := runtimeOf("boot-1", "inc-2")
			if tc.rebooted {
				after.BootID = "boot-2"
			}
			d := Delivery{ID: "cmd_1", Kind: "k", RetrySafe: tc.retrySafe, SelfTerminating: tc.selfTerminating}
			deliverNew(t, j, d, before)
			if tc.running {
				if err := MarkRunning(j, d.ID, before); err != nil {
					t.Fatal(err)
				}
			}
			dec := mustResolve(t, j, d, after, tc.want)
			if tc.want == ActionReexecute {
				// Resolve writes nothing: the dispatcher re-runs the checks, then accepts again.
				if err := Accept(j, d, after); err != nil {
					t.Fatal(err)
				}
				mustResolve(t, j, d, after, ActionReattach)
				return
			}
			if dec.Result == nil || dec.Result.Outcome != tc.outcome || dec.Result.Rebooted != tc.wantRebooted {
				t.Fatalf("result = %+v, want %s with rebooted=%v", dec.Result, tc.outcome, tc.wantRebooted)
			}
			if tc.outcome == OutcomeFailed && dec.Result.Reason != ReasonInterrupted {
				t.Fatalf("reason = %q, want %q", dec.Result.Reason, ReasonInterrupted)
			}
			// The outcome is journaled, so the next duplicate resends it instead of deciding again.
			again := mustResolve(t, j, d, after, ActionResend)
			if !reflect.DeepEqual(again.Result, dec.Result) {
				t.Fatalf("resent %+v, want %+v", again.Result, dec.Result)
			}
		})
	}
}

func TestRulesUseTheAcceptedFlags(t *testing.T) {
	j := NewMemory("node_1", MemoryOptions{})
	d := Delivery{ID: "cmd_1", Kind: "wipe"}
	deliverNew(t, j, d, runtimeOf("boot-1", "inc-1"))
	// A redelivery claiming retry_safe does not turn an interrupted wipe into a re-execution.
	d.RetrySafe = true
	dec := mustResolve(t, j, d, runtimeOf("boot-1", "inc-2"), ActionReport)
	if dec.Result.Outcome != OutcomeFailed {
		t.Fatalf("result = %+v, want failed", dec.Result)
	}
}

func TestRecover(t *testing.T) {
	j := NewMemory("node_1", MemoryOptions{})
	before := runtimeOf("boot-1", "inc-1")
	deliveries := []Delivery{
		{ID: "a-reboot", Kind: "node.reboot", SelfTerminating: true},
		{ID: "b-wipe", Kind: "wipe"},
		{ID: "c-refresh", Kind: "inventory.refresh", RetrySafe: true},
		{ID: "d-diag", Kind: "diag.nvml", RetrySafe: true},
	}
	for _, d := range deliveries {
		deliverNew(t, j, d, before)
	}
	if err := MarkRunning(j, "a-reboot", before); err != nil {
		t.Fatal(err)
	}
	if err := Complete(j, "d-diag", Result{Outcome: OutcomeSucceeded}, t0); err != nil {
		t.Fatal(err)
	}

	after := runtimeOf("boot-2", "inc-2")
	completed, err := Recover(j, after)
	if err != nil {
		t.Fatal(err)
	}
	if len(completed) != 2 || completed[0].ID != "a-reboot" || completed[1].ID != "b-wipe" {
		t.Fatalf("completed = %+v; want a-reboot and b-wipe", completed)
	}
	if r := completed[0].Result; r.Outcome != OutcomeSucceeded || !r.Rebooted {
		t.Fatalf("a-reboot = %+v, want succeeded{rebooted}", r)
	}
	if r := completed[1].Result; r.Outcome != OutcomeFailed || r.Reason != ReasonInterrupted {
		t.Fatalf("b-wipe = %+v, want failed{interrupted}", r)
	}
	if completed[0].ResultAcked || completed[1].ResultAcked {
		t.Fatal("recovered results must be unacked so Hello reports them")
	}
	// The retry-safe entry waits for the server's redelivery.
	mustResolve(t, j, deliveries[2], after, ActionReexecute)

	again, err := Recover(j, after)
	if err != nil || len(again) != 0 {
		t.Fatalf("second Recover = %+v, %v; want nothing", again, err)
	}
}

func TestSweep(t *testing.T) {
	j := NewMemory("node_1", MemoryOptions{})
	rt := runtimeOf("boot-1", "inc-1")
	for _, id := range []string{"old", "recent", "pending"} {
		deliverNew(t, j, Delivery{ID: id, Kind: "diag.nvml"}, rt)
	}
	if err := Complete(j, "old", Result{Outcome: OutcomeSucceeded}, t0); err != nil {
		t.Fatal(err)
	}
	sixDays := t0.Add(6 * 24 * time.Hour)
	if err := Complete(j, "recent", Result{Outcome: OutcomeSucceeded}, sixDays); err != nil {
		t.Fatal(err)
	}
	now := t0.Add(CommandTTL + time.Hour)
	removed, err := Sweep(j, now, CommandTTL, rt.Incarnation)
	if err != nil || removed != 1 {
		t.Fatalf("Sweep = %d, %v; want 1", removed, err)
	}
	all, err := j.Commands()
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, c := range all {
		ids = append(ids, c.ID)
	}
	if strings.Join(ids, ",") != "pending,recent" {
		t.Fatalf("kept %v; want pending,recent", ids)
	}
	// A later process: "pending" was left accepted by an earlier incarnation and never redelivered.
	removed, err = Sweep(j, now, CommandTTL, "inc-2")
	if err != nil || removed != 1 {
		t.Fatalf("Sweep (later incarnation) = %d, %v; want 1", removed, err)
	}
}

func TestRecordRejectionAndRebootedPayload(t *testing.T) {
	j := NewMemory("node_1", MemoryOptions{})
	rt := runtimeOf("boot-1", "inc-1")
	d := Delivery{ID: "rej", Kind: "diag.nvml"}
	r, err := RecordRejection(j, d, "EXPIRED", rt)
	if err != nil || r.Outcome != OutcomeRejected || r.BootID != "boot-1" {
		t.Fatalf("RecordRejection = %+v, %v", r, err)
	}
	dec, err := Resolve(j, d, rt)
	if err != nil || dec.Action != ActionResend || dec.Result.Reason != "EXPIRED" {
		t.Fatalf("duplicate of a rejection = %+v, %v", dec, err)
	}

	reboot := Delivery{ID: "rb", Kind: "node.reboot", SelfTerminating: true}
	deliverNew(t, j, reboot, rt)
	if err := MarkRunning(j, "rb", rt); err != nil {
		t.Fatal(err)
	}
	after := runtimeOf("boot-2", "inc-2")
	after.RebootedPayload = func(c Command) []byte { return []byte(c.BootID) }
	done, err := Recover(j, after)
	if err != nil || len(done) != 1 {
		t.Fatalf("Recover = %+v, %v", done, err)
	}
	if res := done[0].Result; !res.Rebooted || res.BootID != "boot-2" || string(res.Payload) != "boot-1" {
		t.Fatalf("rebooted result = %+v", res)
	}
	if err := Complete(j, "x", Result{Outcome: OutcomeCancelled}, t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cancelled is a valid outcome; got %v", err)
	}
}

func TestLifecycleErrors(t *testing.T) {
	j := NewMemory("node_1", MemoryOptions{})
	rt := runtimeOf("boot-1", "inc-1")
	if err := MarkRunning(j, "missing", rt); !errors.Is(err, ErrNotFound) {
		t.Fatalf("MarkRunning(missing) = %v; want ErrNotFound", err)
	}
	if err := Complete(j, "missing", Result{Outcome: OutcomeFailed}, t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Complete(missing) = %v; want ErrNotFound", err)
	}
	d := Delivery{ID: "cmd_1", Kind: "diag.nvml"}
	deliverNew(t, j, d, rt)
	if err := Complete(j, d.ID, Result{Outcome: "maybe"}, t0); err == nil {
		t.Fatal("Complete accepted an invalid outcome")
	}
	if err := Complete(j, d.ID, Result{Outcome: OutcomeSucceeded}, t0); err != nil {
		t.Fatal(err)
	}
	if err := Complete(j, d.ID, Result{Outcome: OutcomeFailed}, t0); err == nil {
		t.Fatal("Complete overwrote a done command")
	}
	if err := MarkRunning(j, d.ID, rt); err == nil {
		t.Fatal("MarkRunning moved a done command")
	}
	if err := Accept(j, d, rt); err == nil {
		t.Fatal("Accept overwrote a done command")
	}
	if err := AckResult(j, d.ID); err != nil {
		t.Fatal(err)
	}
	if c, _, _ := j.Command(d.ID); !c.ResultAcked {
		t.Fatal("AckResult did not mark the result acked")
	}
}

func TestEventsDropMetricsOldestFirst(t *testing.T) {
	j := NewMemory("node_1", MemoryOptions{MaxEvents: 3})
	appendEvent := func(class EventClass, kind string) (uint64, error) {
		e, err := j.AppendEvent(Event{Class: class, Kind: kind})
		return e.Seq, err
	}
	kinds := func() string {
		events, err := j.UnackedEvents()
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, e := range events {
			out = append(out, e.Kind)
		}
		return strings.Join(out, ",")
	}
	for i, kind := range []string{"m1", "t1", "m2"} {
		class := ClassMetric
		if kind == "t1" {
			class = ClassTransition
		}
		if seq, err := appendEvent(class, kind); err != nil || seq != uint64(i+1) {
			t.Fatalf("append %s = %d, %v", kind, seq, err)
		}
	}
	// Full: a result evicts the oldest metric, then a transition evicts the next one.
	if seq, err := appendEvent(ClassResult, "r1"); err != nil || seq != 4 {
		t.Fatalf("append r1 = %d, %v", seq, err)
	}
	if seq, err := appendEvent(ClassTransition, "t2"); err != nil || seq != 5 {
		t.Fatalf("append t2 = %d, %v", seq, err)
	}
	if got := kinds(); got != "t1,r1,t2" {
		t.Fatalf("events = %s; want t1,r1,t2", got)
	}
	// Only results and transitions remain, and those are never dropped: both classes are refused.
	if _, err := appendEvent(ClassResult, "r2"); !errors.Is(err, ErrFull) {
		t.Fatalf("append r2 = %v; want ErrFull", err)
	}
	if _, err := appendEvent(ClassMetric, "m3"); !errors.Is(err, ErrFull) {
		t.Fatalf("append m3 = %v; want ErrFull", err)
	}
	stats, err := j.EventStats()
	if err != nil || stats.Count != 3 || stats.DroppedMetrics != 3 {
		t.Fatalf("stats = %+v, %v; want 3 events and 3 dropped metrics", stats, err)
	}
	// A cumulative ack frees room, and seqs continue without reuse.
	if err := j.AckEvents(4); err != nil {
		t.Fatal(err)
	}
	if got := kinds(); got != "t2" {
		t.Fatalf("after ack: events = %s; want t2", got)
	}
	if seq, err := appendEvent(ClassResult, "r2"); err != nil || seq != 6 {
		t.Fatalf("append r2 after ack = %d, %v", seq, err)
	}
	if meta, _ := j.Meta(); meta.EventSeq != 6 {
		t.Fatalf("meta event seq = %d, want 6", meta.EventSeq)
	}
}

func TestEventsByteCap(t *testing.T) {
	j := NewMemory("node_1", MemoryOptions{MaxBytes: 100})
	metric := Event{Class: ClassMetric, Kind: "m", Payload: make([]byte, 10)}
	for i := 0; i < 3; i++ {
		if _, err := j.AppendEvent(metric); err != nil {
			t.Fatalf("append metric %d: %v", i, err)
		}
	}
	stats, _ := j.EventStats()
	if stats.Count != 2 || stats.Bytes > 100 || stats.DroppedMetrics != 1 {
		t.Fatalf("stats = %+v; want 2 metrics within 100 bytes, 1 dropped", stats)
	}
	// An event larger than the whole cap is refused without dropping the backlog.
	huge := Event{Class: ClassResult, Kind: "r", Payload: make([]byte, 100)}
	if _, err := j.AppendEvent(huge); !errors.Is(err, ErrFull) {
		t.Fatalf("append huge = %v; want ErrFull", err)
	}
	if after, _ := j.EventStats(); after.Count != 2 {
		t.Fatalf("stats after huge = %+v; want the 2 metrics kept", after)
	}
	if _, err := j.AppendEvent(Event{Class: 0, Kind: "x"}); err == nil {
		t.Fatal("AppendEvent accepted an event without a class")
	}
}

func TestMetaOwnsJournalIDAndEventSeq(t *testing.T) {
	j := NewMemory("node_1", MemoryOptions{})
	meta, _ := j.Meta()
	if !strings.HasPrefix(meta.JournalID, "jrn_") || meta.NodeID != "node_1" {
		t.Fatalf("meta = %+v", meta)
	}
	if err := j.SaveMeta(Meta{NodeID: "node_1", JournalID: "forged", EventSeq: 99, LastEpoch: 7, AppliedGeneration: 3}); err != nil {
		t.Fatal(err)
	}
	got, _ := j.Meta()
	want := Meta{NodeID: "node_1", JournalID: meta.JournalID, LastEpoch: 7, AppliedGeneration: 3}
	if got != want {
		t.Fatalf("meta = %+v, want %+v", got, want)
	}
	other, _ := NewMemory("node_1", MemoryOptions{}).Meta()
	if other.JournalID == meta.JournalID {
		t.Fatal("two journals share a journal_id")
	}
}

func TestSpecGenerationNeverRegresses(t *testing.T) {
	j := NewMemory("node_1", MemoryOptions{})
	if _, ok, _ := j.Spec(); ok {
		t.Fatal("new journal has a spec")
	}
	for _, g := range []uint64{5, 5, 6} {
		if err := j.SaveSpec(Spec{Generation: g, Body: []byte("spec")}); err != nil {
			t.Fatalf("SaveSpec(%d): %v", g, err)
		}
	}
	if err := j.SaveSpec(Spec{Generation: 4}); !errors.Is(err, ErrStaleSpec) {
		t.Fatalf("SaveSpec(4) = %v; want ErrStaleSpec", err)
	}
	if s, ok, _ := j.Spec(); !ok || s.Generation != 6 {
		t.Fatalf("spec = %+v, %v; want generation 6", s, ok)
	}
}

func TestTicketsAreSingleUse(t *testing.T) {
	j := NewMemory("node_1", MemoryOptions{})
	exp := t0.Add(time.Minute)
	if fresh, err := j.RememberTicket("jti-1", exp, t0); err != nil || !fresh {
		t.Fatalf("first use = %v, %v; want fresh", fresh, err)
	}
	if fresh, _ := j.RememberTicket("jti-1", exp, t0.Add(time.Second)); fresh {
		t.Fatal("a replayed jti was accepted")
	}
	if fresh, _ := j.RememberTicket("jti-2", t0, t0); fresh {
		t.Fatal("an expired ticket was accepted")
	}
	// Expired jtis are forgotten, which keeps the set bounded; their tickets fail the exp check first.
	later := exp.Add(time.Second)
	if fresh, _ := j.RememberTicket("jti-3", later.Add(time.Minute), later); !fresh {
		t.Fatal("a new jti was refused")
	}
	if len(j.tickets) != 1 {
		t.Fatalf("tickets = %v; want only jti-3", j.tickets)
	}
}

func TestMemoryReturnsCopies(t *testing.T) {
	j := NewMemory("node_1", MemoryOptions{})
	payload := []byte("result")
	if err := j.PutCommand(Command{ID: "cmd_1", State: StateDone, Result: &Result{Outcome: OutcomeSucceeded, Payload: payload}}); err != nil {
		t.Fatal(err)
	}
	payload[0] = 'X'
	c, _, _ := j.Command("cmd_1")
	c.Result.Payload[1] = 'Y'
	again, _, _ := j.Command("cmd_1")
	if !bytes.Equal(again.Result.Payload, []byte("result")) {
		t.Fatalf("stored payload = %q; want it isolated from callers", again.Result.Payload)
	}

	event := []byte("event")
	if _, err := j.AppendEvent(Event{Class: ClassTransition, Kind: "k", Payload: event}); err != nil {
		t.Fatal(err)
	}
	event[0] = 'X'
	events, _ := j.UnackedEvents()
	if !bytes.Equal(events[0].Payload, []byte("event")) {
		t.Fatalf("stored event = %q; want it isolated from callers", events[0].Payload)
	}

	if err := j.SaveCerts(Certs{Chain: [][]byte{[]byte("leaf")}}); err != nil {
		t.Fatal(err)
	}
	certs, _, _ := j.Certs()
	certs.Chain[0][0] = 'X'
	if again, _, _ := j.Certs(); string(again.Chain[0]) != "leaf" {
		t.Fatalf("stored chain = %q; want it isolated from callers", again.Chain[0])
	}
}

func TestNewID(t *testing.T) {
	a, b := NewID("inc"), NewID("inc")
	if !strings.HasPrefix(a, "inc_") || len(a) != len("inc_")+32 || a == b {
		t.Fatalf("NewID = %q, %q", a, b)
	}
}
