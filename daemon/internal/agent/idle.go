package agent

import (
	"io"

	"github.com/better-compute/better-compute/daemon/internal/transfer"
)

// Long transfers (snapshot uploads and restores) are bounded by progress, not by size: one that
// moves fewer than transferMinBytes in any transferIdle window is cancelled (a byte now and then
// does not keep it alive), and none runs longer than transferMax, so a stalled or trickling peer
// never pins a worker. The watchdog itself is internal/transfer's, shared with the runtimes' base
// image downloads.
const (
	transferIdle     = transfer.Idle
	transferMinBytes = transfer.MinBytes
	transferMax      = transfer.Max
)

// withProgress returns a context cancelled after max, or after a window of idle moving fewer than
// minBytes (counted by the watchdog's Touch).
var withProgress = transfer.WithProgress

// progressReader counts the bytes every read moves.
type progressReader struct {
	r io.Reader
	w *transfer.Watchdog
}

func (p progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.w.Touch(n)
	return n, err
}

// touchWriter counts the bytes a runtime producing a snapshot writes.
type touchWriter struct{ w *transfer.Watchdog }

func (t touchWriter) Write(b []byte) (int, error) {
	t.w.Touch(len(b))
	return len(b), nil
}

// httpsOnly refuses a redirect anywhere but https: a snapshot may hold a tenant's memory.
var httpsOnly = transfer.HTTPSOnly
