package imds

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A guest decides how often it asks: each instance has its own budget, counted before anything is
// looked up for it, and a control plane that cannot be asked is a 503.
func TestRequestsAreLimitedPerInstance(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	lookups, mints := 0, 0
	var mintErr error
	svc := New(func(r *http.Request) (string, bool) {
		lookups++
		return r.Header.Get("X-Test-Instance"), true
	}, func(context.Context, string, string) (string, error) {
		mints++
		return "jwt", mintErr
	})
	svc.Now = func() time.Time { return now }
	svc.Claim = func(r *http.Request) (string, bool) {
		id := r.Header.Get("X-Test-Instance")
		return id, id != ""
	}
	svc.Requests, svc.Mints = Limit{PerSecond: 10, Burst: 20}, Limit{PerSecond: 1, Burst: 3}
	do := func(instance, method, path, session string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		req.RemoteAddr = "10.0.0.5:40000"
		if instance != "" {
			req.Header.Set("X-Test-Instance", instance)
		}
		req.Header.Set(SessionTTLHeader, "300")
		if session != "" {
			req.Header.Set(SessionHeader, session)
		}
		rec := httptest.NewRecorder()
		svc.ServeHTTP(rec, req)
		return rec
	}
	flood := func(instance string, n int) map[int]int {
		codes := map[int]int{}
		for i := 0; i < n; i++ {
			codes[do(instance, http.MethodPut, "/latest/api/token", "").Code]++
		}
		return codes
	}

	// 500 unauthenticated token requests from one instance: its burst is answered, the rest are
	// refused without a lookup.
	codes := flood("inst_a", 500)
	if codes[http.StatusOK] != 20 || codes[http.StatusTooManyRequests] != 480 {
		t.Fatalf("a flood of 500 = %v, want 20 answered and 480 refused", codes)
	}
	if lookups != 20 {
		t.Fatalf("the flood cost %d instance lookups, want 20", lookups)
	}
	if rec := do("inst_a", http.MethodPut, "/latest/api/token", ""); rec.Header().Get("Retry-After") == "" {
		t.Fatal("a refused request names no Retry-After")
	}
	// Another instance has its own budget.
	other := do("inst_b", http.MethodPut, "/latest/api/token", "")
	if other.Code != http.StatusOK {
		t.Fatalf("inst_b during inst_a's flood = %d", other.Code)
	}
	session := other.Body.String()
	// The budget refills: a second later, ten more.
	now = now.Add(time.Second)
	if codes := flood("inst_a", 50); codes[http.StatusOK] != 10 {
		t.Fatalf("a second later = %v, want 10 answered", codes)
	}
	// An address nobody holds is refused before any lookup.
	before := lookups
	if rec := do("", http.MethodPut, "/latest/api/token", ""); rec.Code != http.StatusNotFound || lookups != before {
		t.Fatalf("nobody's address = %d (%d lookups)", rec.Code, lookups-before)
	}

	// Identity tokens have their own, smaller budget: each is a request to the control plane.
	minted := map[int]int{}
	for i := 0; i < 10; i++ {
		minted[do("inst_b", http.MethodGet, "/latest/identity-token?audience=sts", session).Code]++
	}
	if minted[http.StatusOK] != 3 || minted[http.StatusTooManyRequests] != 7 || mints != 3 {
		t.Fatalf("10 identity-token requests = %v (%d minted), want 3 and 7", minted, mints)
	}
	// A control plane that cannot be asked now: 503 with a Retry-After, not a refusal.
	now = now.Add(10 * time.Second)
	mintErr = ErrUnavailable
	if rec := do("inst_b", http.MethodGet, "/latest/identity-token?audience=sts", session); rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("an unavailable control plane = %d", rec.Code)
	}
}
