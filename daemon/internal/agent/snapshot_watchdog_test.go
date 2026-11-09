package agent

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// slowSnapshot is a runtime whose Snapshot first works without writing (virsh save, qemu-img
// convert), then writes its tar, or one byte of it and nothing more.
type slowSnapshot struct {
	*runtime.Fake
	before time.Duration
	stall  bool
}

func (s *slowSnapshot) Snapshot(ctx context.Context, id string, memory bool, cpu string, w io.Writer) (string, error) {
	select {
	case <-time.After(s.before):
	case <-ctx.Done():
		return "", context.Cause(ctx)
	}
	if s.stall {
		_, _ = w.Write([]byte("x"))
		<-ctx.Done()
		return "", context.Cause(ctx)
	}
	return s.Fake.Snapshot(ctx, id, memory, cpu, w)
}

// The progress watchdog of instance.snapshot covers the tar and the upload. The phase before them,
// in which the runtime saves memory and flattens the disk without writing a byte, may take several
// idle windows; a tar that stops moving is still cancelled.
func TestSnapshotWatchdogCoversOnlyTheTarAndTheUpload(t *testing.T) {
	const idle = 500 * time.Millisecond
	rt := &slowSnapshot{before: 3*idle + idle/5,
		Fake: &runtime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}}
	h := newHarness(t, func(o *Options) {
		o.Runtimes = []runtime.Runtime{rt}
		o.TransferIdle = idle
	})
	store := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.Copy(io.Discard, r.Body) }))
	defer store.Close()
	h.agent.o.HTTPClient = store.Client()
	s, _ := h.open()
	s.push(desired(1, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{
		vm("inst_web", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)}}}))
	s.next(t, "running", func(f *agentv1.AgentFrame) bool { return len(f.GetStatus().GetInstances()) == 1 })
	ended := func(id string) *agentv1.CommandUpdate {
		t.Helper()
		return s.next(t, id+" to end", func(f *agentv1.AgentFrame) bool {
			u := f.GetUpdate()
			return u != nil && u.GetCommandId() == id && (u.GetState() == commonv1.CommandState_COMMAND_STATE_SUCCEEDED ||
				u.GetState() == commonv1.CommandState_COMMAND_STATE_FAILED)
		}).GetUpdate()
	}
	snapshot := func(id string) *agentv1.CommandUpdate {
		t.Helper()
		b := body(id, "instance.snapshot", &agentv1.InstanceSnapshotRequest{InstanceId: "inst_web", UploadUrl: store.URL + "/snap", IncludeMemory: true})
		b.Lane = commonv1.Lane_LANE_BULK
		s.push(command(b))
		return ended(id)
	}

	// More than three idle windows of saving and converting, then the tar: not a stalled transfer.
	if u := snapshot("slow"); u.GetState() != commonv1.CommandState_COMMAND_STATE_SUCCEEDED {
		t.Fatalf("a snapshot whose save phase outlasts the idle window = %s: %s", u.GetState(), u.GetError().GetMessage())
	}

	// A tar that writes a byte and stops is cancelled as before.
	rt.before, rt.stall = 0, true
	started := time.Now()
	u := snapshot("stalled")
	if u.GetState() != commonv1.CommandState_COMMAND_STATE_FAILED || !strings.Contains(u.GetError().GetMessage(), "stalled") {
		t.Fatalf("a snapshot whose tar stalls = %s: %s", u.GetState(), u.GetError().GetMessage())
	}
	if took := time.Since(started); took > 4*time.Second {
		t.Fatalf("a stalled tar was cancelled only after %s", took)
	}
}
