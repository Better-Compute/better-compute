package runtime

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// A base image downloads on the converge path with the runtime's lock held: it stays on https
// through every redirect, fits in MaxImageBytes, and ends when it stops moving.
func TestBaseImageDownloadIsBounded(t *testing.T) {
	image := qcow2Image(1<<30, "", "", []byte(strings.Repeat("image bytes ", 512)))
	sum := sha256.Sum256(image)
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(image) }))
	defer plain.Close()
	release := make(chan struct{})
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/to-http":
			http.Redirect(w, r, plain.URL+"/image.qcow2", http.StatusFound)
		case "/to-https":
			http.Redirect(w, r, "/image.qcow2", http.StatusFound)
		case "/unsized": // no Content-Length: the size is known only as it arrives
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			_, _ = w.Write(image)
		case "/stalls":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(image[:64])
			w.(http.Flusher).Flush()
			select {
			case <-r.Context().Done():
			case <-release:
			}
		default:
			_, _ = w.Write(image)
		}
	}))
	defer srv.Close()
	defer close(release)
	dir := t.TempDir()
	l := &Libvirt{Dir: dir, Exec: (&fakeVirt{domains: map[string]*fakeDomain{}}).exec, HTTP: srv.Client()}
	ref := func(path string) *agentv1.ImageRef {
		return &agentv1.ImageRef{Url: srv.URL + path, Sha256: sum[:], Format: "qcow2"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	nothingKept := func(when string) {
		t.Helper()
		entries, _ := os.ReadDir(filepath.Join(dir, "images"))
		if len(entries) != 0 {
			t.Fatalf("%s: images/ holds %v", when, entries[0].Name())
		}
	}

	// https to http: refused, although the bytes there are the pinned ones.
	if _, err := l.baseImage(ctx, ref("/to-http")); err == nil || !strings.Contains(err.Error(), "non-https") {
		t.Fatalf("an image redirected to http = %v", err)
	}
	nothingKept("a redirect to http")

	// Larger than the cap: refused by its Content-Length, and by its bytes when it states none.
	l.MaxImageBytes = int64(len(image)) - 1
	for _, path := range []string{"/image.qcow2", "/unsized"} {
		if _, err := l.baseImage(ctx, ref(path)); err == nil || !strings.Contains(err.Error(), "larger than") {
			t.Fatalf("%s over the cap = %v", path, err)
		}
		nothingKept(path + " over the cap")
	}
	l.MaxImageBytes = 0

	// A server that stops sending: the download ends, it does not hold the lock for good.
	l.pullIdle = 200 * time.Millisecond
	started := time.Now()
	if _, err := l.baseImage(ctx, ref("/stalls")); err == nil || !strings.Contains(err.Error(), "stalled") {
		t.Fatalf("a stalled image download = %v", err)
	}
	if took := time.Since(started); took > 10*time.Second {
		t.Fatalf("a stalled image download took %s", took)
	}
	nothingKept("a stalled download")
	l.pullIdle = 0

	// An https redirect is followed, and an image exactly at the cap is taken.
	l.MaxImageBytes = int64(len(image))
	base, err := l.baseImage(ctx, ref("/to-https"))
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(base); sha256.Sum256(got) != sum {
		t.Fatal("the base image is not the pinned bytes")
	}
}
