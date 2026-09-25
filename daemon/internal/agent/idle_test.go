package agent

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A transfer that stops moving is cancelled; one that keeps moving is not.
func TestTransfersAreBoundedByProgress(t *testing.T) {
	stalled := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("first bytes"))
		w.(http.Flusher).Flush()
		<-r.Context().Done() // then nothing
	}))
	defer stalled.Close()
	ctx, watch, stop := withProgress(context.Background(), 200*time.Millisecond, time.Minute)
	defer stop()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, stalled.URL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	started := time.Now()
	_, err = io.Copy(io.Discard, progressReader{resp.Body, watch})
	if err == nil || time.Since(started) > 10*time.Second {
		t.Fatalf("a stalled download ended with %v after %s", err, time.Since(started))
	}

	// Progress keeps it alive past the idle time.
	ctx, watch, stop = withProgress(context.Background(), 100*time.Millisecond, time.Minute)
	defer stop()
	slow := &slowReader{left: 6, every: 50 * time.Millisecond}
	if _, err := io.Copy(io.Discard, progressReader{slow, watch}); err != nil || ctx.Err() != nil {
		t.Fatalf("a moving transfer was cancelled: %v %v", err, ctx.Err())
	}
	if err := httpsOnly(httptest.NewRequest(http.MethodGet, "http://plain/x", nil), nil); err == nil || !strings.Contains(err.Error(), "non-https") {
		t.Fatalf("a redirect to http = %v", err)
	}
}

type slowReader struct {
	left  int
	every time.Duration
}

func (s *slowReader) Read(b []byte) (int, error) {
	if s.left == 0 {
		return 0, io.EOF
	}
	time.Sleep(s.every)
	s.left--
	b[0] = 'x'
	return 1, nil
}
