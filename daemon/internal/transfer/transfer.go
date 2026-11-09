// Package transfer bounds long downloads and uploads (snapshots, release binaries, base images) by
// progress rather than by a total timeout, and keeps their redirects on https.
package transfer

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync/atomic"
	"time"
)

// A transfer that moves fewer than MinBytes in any Idle window is cancelled (a byte now and then
// does not keep it alive), and none runs longer than Max, so a stalled or trickling peer never pins
// a worker or a lock.
const (
	Idle     = 2 * time.Minute
	MinBytes = 1 << 20
	Max      = 6 * time.Hour
)

// ErrStalled is the cause (context.Cause) of a context a Watchdog cancelled for lack of progress.
var ErrStalled = errors.New("the transfer stalled")

// ErrTooLong is the cause of a context that ran past its maximum.
var ErrTooLong = errors.New("the transfer took too long")

// Watchdog cancels a context when a window passes with less than its minimum of bytes moved.
type Watchdog struct {
	moved    atomic.Int64
	min      int64
	stop     chan struct{}
	disarmed atomic.Bool
}

// WithProgress returns a context cancelled after max, or after a window of idle moving fewer than
// minBytes (counted by Touch). The returned function stops the watchdog and cancels the context.
func WithProgress(ctx context.Context, idle time.Duration, minBytes int64, max time.Duration) (context.Context, *Watchdog, context.CancelFunc) {
	ctx, cancelMax := context.WithTimeoutCause(ctx, max, ErrTooLong)
	ctx, cancel := context.WithCancelCause(ctx)
	w := &Watchdog{min: minBytes, stop: make(chan struct{})}
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
				if moved := w.moved.Swap(0); moved < w.min && !w.disarmed.Load() {
					cancel(ErrStalled)
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
		cancel(context.Canceled)
		cancelMax()
	}
}

// Touch counts n bytes moved.
func (w *Watchdog) Touch(n int) { w.moved.Add(int64(n)) }

// Disarm suspends the idle check for a phase that moves no bytes past the watchdog (a hypervisor
// saving a guest's memory, a disk being flattened, before the first byte of the transfer itself).
// The maximum duration still applies.
func (w *Watchdog) Disarm() { w.disarmed.Store(true) }

// Arm starts the idle check after Disarm (and does nothing otherwise): the window under way when it
// is called is not held against the transfer, the first one judged is the next full one.
func (w *Watchdog) Arm() {
	if w.disarmed.Load() {
		w.moved.Add(w.min)
		w.disarmed.Store(false)
	}
}

// Reader counts the bytes every read of R moves.
type Reader struct {
	R io.Reader
	W *Watchdog
}

func (p Reader) Read(b []byte) (int, error) {
	n, err := p.R.Read(b)
	p.W.Touch(n)
	return n, err
}

// Writer counts the bytes written to it (and keeps none).
type Writer struct{ W *Watchdog }

func (t Writer) Write(b []byte) (int, error) {
	t.W.Touch(len(b))
	return len(b), nil
}

// HTTPSOnly is an http.Client's CheckRedirect that refuses a redirect anywhere but https (a
// snapshot may hold a tenant's memory; an image is fetched over https only), and more than ten.
func HTTPSOnly(req *http.Request, via []*http.Request) error {
	if req.URL.Scheme != "https" {
		return errors.New("redirect to a non-https URL refused")
	}
	if len(via) >= 10 {
		return errors.New("too many redirects")
	}
	return nil
}
