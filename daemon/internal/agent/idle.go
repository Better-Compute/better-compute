package agent

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"
)

// Long transfers (snapshot uploads and restores) are bounded by progress, not by size: one that
// moves no bytes for transferIdle is cancelled, and none runs longer than transferMax, so a stalled
// peer never pins a worker or the instances converger.
const (
	transferIdle = 2 * time.Minute
	transferMax  = 6 * time.Hour
)

// watchdog cancels a context when touch has not been called for idle.
type watchdog struct {
	timer *time.Timer
	idle  time.Duration
}

// withProgress returns a context cancelled after max, or after idle without progress (touch).
func withProgress(ctx context.Context, idle, max time.Duration) (context.Context, *watchdog, context.CancelFunc) {
	ctx, cancel := context.WithTimeoutCause(ctx, max, errors.New("the transfer took too long"))
	w := &watchdog{idle: idle}
	w.timer = time.AfterFunc(idle, cancel)
	return ctx, w, func() { w.timer.Stop(); cancel() }
}

func (w *watchdog) touch() { w.timer.Reset(w.idle) }

// progressReader touches the watchdog on every read that moved bytes.
type progressReader struct {
	r io.Reader
	w *watchdog
}

func (p progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.w.touch()
	}
	return n, err
}

// touchWriter touches the watchdog on every write (a runtime producing a snapshot).
type touchWriter struct{ w *watchdog }

func (t touchWriter) Write(b []byte) (int, error) {
	if len(b) > 0 {
		t.w.touch()
	}
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
