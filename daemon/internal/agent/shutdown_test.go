package agent

import (
	"context"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// slowUndo is a runtime whose Ensure, once cancelled, takes a moment to undo what it had begun.
type slowUndo struct {
	*runtime.Fake
	entered chan struct{}
	once    sync.Once
	undone  atomic.Bool
	// stuck: the undo never returns.
	stuck bool
}

func (s *slowUndo) Ensure(ctx context.Context, _ *agentv1.InstanceSpec, _ []byte, _ *runtime.Restore) error {
	s.once.Do(func() { close(s.entered) })
	<-ctx.Done()
	if s.stuck {
		select {}
	}
	time.Sleep(300 * time.Millisecond)
	s.undone.Store(true)
	return ctx.Err()
}

// bcd stopping mid-pass: Run returns only once the cancelled pass has returned (what it was creating
// is cleaned up), and no later than ShutdownGrace when the pass does not return.
func TestRunWaitsForTheConvergerOnShutdown(t *testing.T) {
	for _, stuck := range []bool{false, true} {
		rt := &slowUndo{entered: make(chan struct{}), stuck: stuck,
			Fake: &runtime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}}
		h := newHarness(t, func(o *Options) {
			o.Runtimes = []runtime.Runtime{rt}
			o.ShutdownGrace = 3 * time.Second
			if stuck {
				o.ShutdownGrace = 200 * time.Millisecond
			}
		})
		s, _ := h.open()
		s.push(desired(1, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{
			vm("inst_web", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)}}}))
		select {
		case <-rt.entered:
		case <-time.After(5 * time.Second):
			t.Fatal("the pass never reached Ensure")
		}
		stopping := time.Now()
		h.cancel()
		select {
		case <-h.done:
		case <-time.After(4 * time.Second):
			t.Fatalf("stuck=%v: Run did not return", stuck)
		}
		if !stuck && !rt.undone.Load() {
			t.Fatal("Run returned while the cancelled pass was still undoing its work")
		}
		if stuck && time.Since(stopping) > 2*time.Second {
			t.Fatalf("Run waited %s for a pass that never returns", time.Since(stopping))
		}
	}
}
