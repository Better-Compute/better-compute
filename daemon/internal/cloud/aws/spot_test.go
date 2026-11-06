package aws

import (
	"context"
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
