package agent

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/imds"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// countingRuntime counts how often it is listed.
type countingRuntime struct {
	*runtime.Fake
	lists atomic.Int64
}

func (c *countingRuntime) List(ctx context.Context) ([]runtime.Domain, error) {
	c.lists.Add(1)
	return c.Fake.List(ctx)
}

// A guest hammering the metadata service costs the host neither a listing of every runtime per
// request nor its gateway session.
func TestIMDSFloodNeitherListsTheRuntimesNorDropsTheSession(t *testing.T) {
	rt := &countingRuntime{Fake: &runtime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}}
	h := newHarness(t, func(o *Options) { o.Runtimes = []runtime.Runtime{rt} })
	s, _ := h.open()
	web := vm("inst_web", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	web.Nics[0].Addresses = []string{"10.0.0.5/24"}
	s.push(desired(1, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web}}}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return len(f.GetStatus().GetInstances()) == 1 })
	service := h.agent.IMDS()
	call := func(ctx context.Context, method, path, session string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil).WithContext(ctx)
		req.RemoteAddr = "10.0.0.5:40000"
		req.Header.Set(imds.SessionTTLHeader, "60")
		if session != "" {
			req.Header.Set(imds.SessionHeader, session)
		}
		rec := httptest.NewRecorder()
		service.ServeHTTP(rec, req)
		return rec
	}
	first := call(context.Background(), http.MethodPut, "/latest/api/token", "")
	if first.Code != http.StatusOK {
		t.Fatalf("session token = %d %s", first.Code, first.Body.String())
	}
	session := first.Body.String()

	// 2000 unauthenticated token requests from the instance.
	listed := rt.lists.Load()
	codes := map[int]int{}
	for i := 0; i < 2000; i++ {
		codes[call(context.Background(), http.MethodPut, "/latest/api/token", "").Code]++
	}
	// (The converger and the status report list too, now and then: a handful, not thousands.)
	if n := rt.lists.Load() - listed; n > 20 {
		t.Fatalf("2000 metadata requests listed the runtime %d times", n)
	}
	if codes[http.StatusOK] == 0 || codes[http.StatusTooManyRequests] == 0 || len(codes) != 2 {
		t.Fatalf("flood answers = %v, want some 200 and the rest 429", codes)
	}

	// The control plane stops answering and the instance (or anything else on the host) asks for
	// thousands of workload tokens: a bounded number wait, the rest are told to come back, and the
	// host's session stays.
	h.agent.mu.Lock()
	before := h.agent.sess
	h.agent.mu.Unlock()
	if before == nil {
		t.Fatal("no session")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	const asks = 6000
	var unavailable atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < asks; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := h.agent.RequestWorkloadToken(ctx, "inst_web", "sts"); errors.Is(err, ErrUnavailable) {
				unavailable.Add(1)
			}
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	for unavailable.Load() < asks-maxPendingWorkloads && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	h.agent.mu.Lock()
	now, pending := h.agent.sess, len(h.agent.workloads)
	h.agent.mu.Unlock()
	if now != before {
		t.Fatalf("the flood of workload-token requests dropped the host's session (%d were refused)", unavailable.Load())
	}
	if got := unavailable.Load(); got != asks-maxPendingWorkloads || pending != maxPendingWorkloads {
		t.Fatalf("%d of %d requests were refused and %d wait, want %d waiting", got, asks, pending, maxPendingWorkloads)
	}
	// While they wait, the guest's own identity-token request is a 503, not a refusal.
	if rec := call(context.Background(), http.MethodGet, "/latest/identity-token?audience=sts", session); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("identity token while the control plane is silent = %d %s", rec.Code, rec.Body.String())
	}
	cancel()
	wg.Wait()
}
