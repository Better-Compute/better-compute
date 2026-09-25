package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
	"google.golang.org/protobuf/proto"
)

func TestSnapshotAndRestore(t *testing.T) {
	var fake *runtime.Fake
	h := newHarness(t, func(o *Options) {
		fake = &runtime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}
		o.Runtimes = []runtime.Runtime{fake}
		// Restores settle a pass or two after their downloads; under a loaded test run the retry
		// (default 30 s) must not be what brings the next pass.
		o.ConvergeRetry = 100 * time.Millisecond
	})
	var uploaded []byte
	store := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			uploaded, _ = io.ReadAll(r.Body)
		case http.MethodGet:
			_, _ = w.Write(uploaded)
		}
	}))
	defer store.Close()
	h.agent.o.HTTPClient = store.Client()
	s, _ := h.open()
	web := vm("inst_web", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	s.push(desired(1, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web}}}))
	s.next(t, "running", func(f *agentv1.AgentFrame) bool { return len(f.GetStatus().GetInstances()) == 1 })

	snap := body("s1", "instance.snapshot", &agentv1.InstanceSnapshotRequest{InstanceId: "inst_web", UploadUrl: store.URL + "/snap", IncludeMemory: true})
	snap.Lane = commonv1.Lane_LANE_BULK
	s.push(command(snap))
	done := s.update(t, "s1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	res := &agentv1.InstanceSnapshotResult{}
	_ = proto.Unmarshal(done.GetResult(), res)
	sum := sha256.Sum256(uploaded)
	if res.GetRuntime() != "libvirt-kvm" || res.GetCpuModel() != h.agent.cpuModel() || res.GetCpuModel() == "" ||
		string(res.GetSha256()) != string(sum[:]) || res.GetUploadedBytes() != uint64(len(uploaded)) {
		t.Fatalf("snapshot = %v", res)
	}

	// A clone boots from it after its digest is verified; a wrong digest never restores.
	clone := vm("inst_clone", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	clone.Image = nil
	clone.RestoreFrom = &agentv1.ImageRef{Url: store.URL + "/snap", Sha256: sum[:]}
	bad := vm("inst_bad", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	bad.Image = nil
	wrong := sha256.Sum256([]byte("other"))
	bad.RestoreFrom = &agentv1.ImageRef{Url: store.URL + "/snap", Sha256: wrong[:]}
	s.push(desired(2, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web, clone, bad}}}))
	// Snapshots download in the background: the instances settle a pass or two later.
	status := s.next(t, "restored", func(f *agentv1.AgentFrame) bool {
		got := instanceStates(f.GetStatus())
		return got["inst_clone"] == agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING && got["inst_bad"] == agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR
	}).GetStatus()
	got := instanceStates(status)
	if got["inst_clone"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING || got["inst_bad"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR {
		t.Fatalf("instances = %v", status.GetInstances())
	}
	domains, _ := fake.List(context.Background())
	for _, d := range domains {
		if d.ID == "inst_clone" && d.RestoredFrom != hex.EncodeToString(sum[:]) {
			t.Fatalf("clone = %+v", d)
		}
	}

	// A memory snapshot taken on another CPU model does not restore here.
	var foreign map[string]any
	_ = json.Unmarshal(uploaded, &foreign)
	foreign["cpuModel"] = "Some Other CPU"
	uploaded, _ = json.Marshal(foreign)
	other := sha256.Sum256(uploaded)
	migrant := vm("inst_migrant", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	migrant.Image = nil
	migrant.RestoreFrom = &agentv1.ImageRef{Url: store.URL + "/snap", Sha256: other[:]}
	s.push(desired(3, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web, clone, migrant}}}))
	status = s.next(t, "cpu mismatch", func(f *agentv1.AgentFrame) bool {
		return instanceStates(f.GetStatus())["inst_migrant"] == agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR
	}).GetStatus()
	if instanceStates(status)["inst_migrant"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR {
		t.Fatalf("migrant = %v", status.GetInstances())
	}
	restored := filepath.Join(h.agent.o.DataDir, "snapshots", hex.EncodeToString(sum[:]))
	if _, err := os.Stat(restored); err != nil {
		t.Fatalf("the clone's snapshot is gone while the clone exists: %v", err)
	}

	// The snapshot goes with the last instance restored from it; http:// is never fetched.
	plain := vm("inst_plain", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	plain.Image = nil
	plain.RestoreFrom = &agentv1.ImageRef{Url: "http://" + strings.TrimPrefix(store.URL, "https://") + "/snap", Sha256: sum[:]}
	_ = os.Remove(restored)
	s.push(desired(4, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web, plain}}}))
	status = s.next(t, "clone dropped", func(f *agentv1.AgentFrame) bool {
		return instanceStates(f.GetStatus())["inst_plain"] == agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR
	}).GetStatus()
	if st := instanceStates(status)["inst_plain"]; st != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR {
		t.Fatalf("a snapshot over http = %v", status.GetInstances())
	}
	s.push(desired(5, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web}}}))
	s.next(t, "only web", func(f *agentv1.AgentFrame) bool { return f.GetStatus().GetAppliedGeneration() == 5 })
	if entries, _ := os.ReadDir(filepath.Join(h.agent.o.DataDir, "snapshots")); len(entries) != 0 {
		t.Fatalf("snapshot files left: %v", entries)
	}
}
