package agent

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync/atomic"
	"time"
)

// Long transfers (snapshot uploads and restores) are bounded by progress, not by size: one that
// moves fewer than transferMinBytes in any transferIdle window is cancelled (a byte now and then
// does not keep it alive), and none runs longer than transferMax, so a stalled or trickling peer
// never pins a worker.
const (
	transferIdle     = 2 * time.Minute
	transferMinBytes = 1 << 20
	transferMax      = 6 * time.Hour
)

// watchdog cancels a context when a window passes with less than its minimum of bytes moved.
type watchdog struct {
	moved  atomic.Int64
	min    int64
	cancel context.CancelFunc
	stop   chan struct{}
}

// withProgress returns a context cancelled after max, or after a window of idle moving fewer than
// minBytes (counted by touch).
func withProgress(ctx context.Context, idle time.Duration, minBytes int64, max time.Duration) (context.Context, *watchdog, context.CancelFunc) {
	ctx, cancel := context.WithTimeoutCause(ctx, max, errors.New("the transfer took too long"))
	w := &watchdog{min: minBytes, cancel: cancel, stop: make(chan struct{})}
	go func() {
		t := time.NewTicker(idle)
		defer t.Stop()
		for {
			select {
			case <-w.stop:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				if w.moved.Swap(0) < w.min {
					cancel()
					return
				}
			}
		}
	}()
	var once atomic.Bool
	return ctx, w, func() {
		if once.CompareAndSwap(false, true) {
			close(w.stop)
		}
		cancel()
	}
}

func (w *watchdog) touch(n int) { w.moved.Add(int64(n)) }

// progressReader counts the bytes every read moves.
type progressReader struct {
	r io.Reader
	w *watchdog
}

func (p progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.w.touch(n)
	return n, err
}

// touchWriter counts the bytes a runtime producing a snapshot writes.
type touchWriter struct{ w *watchdog }

func (t touchWriter) Write(b []byte) (int, error) {
	t.w.touch(len(b))
	return len(b), nil
}

// httpsOnly refuses a redirect anywhere but https: a snapshot may hold a tenant's memory.
func httpsOnly(req *http.Request, via []*http.Request) error {
	if req.URL.Scheme != "https" {
		return errors.New("redirect to a non-https URL refused")
	}
	if len(via) >= 10 {
		return errors.New("too many redirects")
	}
	return nil
}
