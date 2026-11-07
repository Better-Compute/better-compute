package aws

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"
)

const spotPath = "/latest/meta-data/spot/instance-action"

func TestSpotNoticeParsed(t *testing.T) {
	n, err := ParseSpotNotice([]byte(`{"action": "terminate", "time": "2026-11-05T10:02:00Z"}`))
	if err != nil {
		t.Fatal(err)
	}
	if n.Action != "terminate" || !n.Time.Equal(time.Date(2026, 11, 5, 10, 2, 0, 0, time.UTC)) {
		t.Fatalf("notice %+v", n)
	}
	for _, bad := range []string{
		`{"action":"reboot","time":"2026-11-05T10:02:00Z"}`, // not an interruption action
		`{"action":"stop"}`, // no time
		`{"action":"stop","time":"soon"}`,
		`not json`,
	} {
		if _, err := ParseSpotNotice([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	for _, action := range []string{"terminate", "stop", "hibernate"} {
		if _, err := ParseSpotNotice([]byte(`{"action":"` + action + `","time":"2026-11-05T10:02:00Z"}`)); err != nil {
			t.Errorf("%s: %v", action, err)
		}
	}
}

func TestSpotActionReadsTheMetadata(t *testing.T) {
	f, srv := newFakeIMDS(t)
	c := ec2Client(t, srv)
	if n, err := c.SpotAction(context.Background()); err != nil || n != nil {
		t.Fatalf("no notice: %v %v", n, err)
	}
	f.mu.Lock()
	f.paths[spotPath] = `{"action":"stop","time":"2026-11-05T10:02:00Z"}`
	f.mu.Unlock()
	n, err := c.SpotAction(context.Background())
	if err != nil || n == nil || n.Action != "stop" {
		t.Fatalf("notice %v %v", n, err)
	}
}

func TestWatchSpotReportsChanges(t *testing.T) {
	f, srv := newFakeIMDS(t)
	c := ec2Client(t, srv)
	var mu sync.Mutex
	var seen []*SpotNotice
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		c.WatchSpot(ctx, 5*time.Millisecond, func(n *SpotNotice) {
			mu.Lock()
			seen = append(seen, n)
			mu.Unlock()
		})
		close(done)
	}()
	wait := func(n int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			mu.Lock()
			got := len(seen)
			mu.Unlock()
			if got >= n {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("%d notices, want %d", got, n)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	time.Sleep(30 * time.Millisecond) // several polls without a notice: nothing reported
	f.mu.Lock()
	f.paths[spotPath] = `{"action":"terminate","time":"2026-11-05T10:02:00Z"}`
	f.mu.Unlock()
	wait(1)
	time.Sleep(30 * time.Millisecond) // the same notice again: not reported twice
	f.mu.Lock()
	delete(f.paths, spotPath)
	f.mu.Unlock()
	wait(2)
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 || seen[0] == nil || seen[0].Action != "terminate" || seen[1] != nil {
		t.Fatalf("notices %v", seen)
	}
	if DefaultSpotInterval != 5*time.Second {
		t.Fatal("the plan's poll interval is 5 s")
	}
}

// A notice that is present (200) but does not parse is still an interruption: AWS serves the path
// only once it has scheduled one. It is reported, never dropped (fail closed).
func TestSpotActionMalformedNoticeStillInterrupts(t *testing.T) {
	f, srv := newFakeIMDS(t)
	c := ec2Client(t, srv)
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	c.Now = func() time.Time { return now }
	for _, tc := range []struct {
		body, action string
		at           time.Time
	}{
		// An action outside terminate/stop/hibernate with a good time: the time stands.
		{`{"action":"reboot","time":"2026-11-05T10:02:00Z"}`, "unknown", time.Date(2026, 11, 5, 10, 2, 0, 0, time.UTC)},
		// A known action with a bad time: AWS's fixed two minutes from now.
		{`{"action":"stop","time":"soon"}`, "stop", now.Add(SpotWarning)},
		// Neither.
		{`not json`, "unknown", now.Add(SpotWarning)},
	} {
		f.mu.Lock()
		f.paths[spotPath] = tc.body
		f.mu.Unlock()
		n, err := c.SpotAction(context.Background())
		if err != nil || n == nil {
			t.Fatalf("%s: notice %v, error %v", tc.body, n, err)
		}
		if n.Action != tc.action || !n.Time.Equal(tc.at) || n.Unparsed == nil {
			t.Errorf("%s: notice %+v, want %s at %s, unparsed", tc.body, n, tc.action, tc.at)
		}
	}
	if SpotWarning != 2*time.Minute {
		t.Fatal("AWS gives two minutes' warning")
	}
}

func TestWatchSpotReportsAMalformedNoticeOnce(t *testing.T) {
	f, srv := newFakeIMDS(t)
	c := ec2Client(t, srv)
	var clock sync.Mutex
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	c.Now = func() time.Time {
		clock.Lock()
		defer clock.Unlock()
		now = now.Add(time.Second) // every poll is later: the estimate must not move with it
		return now
	}
	f.paths[spotPath] = `{"action":"stop","time":"soon"}`
	var mu sync.Mutex
	var seen []*SpotNotice
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		c.WatchSpot(ctx, 5*time.Millisecond, func(n *SpotNotice) {
			mu.Lock()
			seen = append(seen, n)
			mu.Unlock()
		})
		close(done)
	}()
	time.Sleep(80 * time.Millisecond)
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 1 || seen[0] == nil || seen[0].Action != "stop" || seen[0].Unparsed == nil {
		t.Fatalf("notices %v, want one estimated stop", seen)
	}
}

// A token PUT that answers 404 is a failed read, not "no notice": SpotAction errs and WatchSpot
// keeps the standing notice (fail closed; withdrawing it would clear NoSchedule on a node about to
// be terminated).
func TestSpotTokenNotFoundKeepsTheNotice(t *testing.T) {
	f, srv := newFakeIMDS(t)
	c := ec2Client(t, srv)
	f.paths[spotPath] = `{"action":"terminate","time":"2026-11-05T10:02:00Z"}`
	if n, err := c.SpotAction(context.Background()); err != nil || n == nil {
		t.Fatalf("notice %v %v", n, err)
	}
	f.mu.Lock()
	f.expireNext, f.tokenStatus = true, http.StatusNotFound
	f.mu.Unlock()
	if n, err := c.SpotAction(context.Background()); err == nil || n != nil {
		t.Fatalf("after a token 404: notice %v, error %v; want an error", n, err)
	}

	f2, srv2 := newFakeIMDS(t)
	c2 := ec2Client(t, srv2)
	f2.paths[spotPath] = `{"action":"terminate","time":"2026-11-05T10:02:00Z"}`
	var mu sync.Mutex
	var seen []*SpotNotice
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		c2.WatchSpot(ctx, 5*time.Millisecond, func(n *SpotNotice) {
			mu.Lock()
			seen = append(seen, n)
			mu.Unlock()
		})
		close(done)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		got := len(seen)
		mu.Unlock()
		if got >= 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no notice")
		}
		time.Sleep(5 * time.Millisecond)
	}
	f2.mu.Lock()
	f2.expireNext, f2.tokenStatus = true, http.StatusNotFound
	f2.mu.Unlock()
	time.Sleep(60 * time.Millisecond)
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 1 || seen[0] == nil || seen[0].Action != "terminate" {
		t.Fatalf("notices %v, want the terminate notice kept", seen)
	}
}
