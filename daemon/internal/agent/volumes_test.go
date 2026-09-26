package agent

import (
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

func TestVolumeRefusalsKeepOneWriter(t *testing.T) {
	running := agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING
	stopped := agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_STOPPED
	paused := agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_PAUSED
	deleted := agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_DELETED
	attach := func(id string, state agentv1.InstanceDesiredState, vols ...*agentv1.InstanceVolume) *agentv1.InstanceSpec {
		return &agentv1.InstanceSpec{InstanceId: id, DesiredState: state, Volumes: vols}
	}
	rw := func(id string) *agentv1.InstanceVolume { return &agentv1.InstanceVolume{VolumeId: id} }
	ro := func(id string) *agentv1.InstanceVolume { return &agentv1.InstanceVolume{VolumeId: id, ReadOnly: true} }
	section := &agentv1.InstancesSection{
		Volumes: []*agentv1.HostVolume{{VolumeId: "vol_a"}, {VolumeId: "vol_b"}, {VolumeId: "vol_bad"}},
		Instances: []*agentv1.InstanceSpec{
			attach("inst_1", running, rw("vol_a")),
			attach("inst_2", running, ro("vol_a")), // beside a writer
			attach("inst_3", stopped, rw("vol_a")), // stopped: fine
			attach("inst_4", running, ro("vol_b")),
			attach("inst_5", paused, ro("vol_b")),  // readers share
			attach("inst_6", running, rw("vol_b")), // a writer beside readers
			attach("inst_7", running, rw("vol_gone")),
			attach("inst_8", running, rw("vol_bad")),
			attach("inst_9", deleted, rw("vol_a")),
		},
	}
	// What running domains have open counts first: inst_old keeps running with vol_c although its
	// spec dropped it (applies at its next start); inst_gone is being stopped, so its vol_d is free.
	section.Volumes = append(section.Volumes, &agentv1.HostVolume{VolumeId: "vol_c"}, &agentv1.HostVolume{VolumeId: "vol_d"})
	section.Instances = append(section.Instances,
		attach("inst_new", running, rw("vol_c")),
		attach("inst_old", running),
		attach("inst_gone", stopped),
		attach("inst_d", running, rw("vol_d")),
	)
	domains := map[string]runtime.Domain{
		"inst_old":  {ID: "inst_old", Managed: true, State: runtime.StateRunning, Volumes: []runtime.AttachedVolume{{Volume: runtime.Volume{ID: "vol_c"}}}},
		"inst_gone": {ID: "inst_gone", Managed: true, State: runtime.StateRunning, Volumes: []runtime.AttachedVolume{{Volume: runtime.Volume{ID: "vol_d"}}}},
		// Running with the volume its spec names: not a conflict with itself.
		"inst_1": {ID: "inst_1", Managed: true, State: runtime.StateRunning, Volumes: []runtime.AttachedVolume{{Volume: runtime.Volume{ID: "vol_a"}}}},
	}
	got := volumeRefusals(section, map[string]string{"vol_bad": "disk full"}, domains)
	want := map[string]string{
		"inst_2":   "volume vol_a is attached read-write to inst_1",
		"inst_6":   "volume vol_b is attached to inst_4: a read-write attachment is exclusive",
		"inst_7":   "volume vol_gone is not on this host",
		"inst_8":   "volume vol_bad: disk full",
		"inst_new": "volume vol_c is attached read-write to inst_old",
	}
	if len(got) != len(want) {
		t.Fatalf("refusals = %v", got)
	}
	for id, msg := range want {
		if got[id] != msg {
			t.Errorf("%s: %q, want %q", id, got[id], msg)
		}
	}
}

// A volume a running VM still has open is never destroyed, even unlisted and dropped from its spec.
func TestCollectVolumesKeepsWhatRunningDomainsHaveOpen(t *testing.T) {
	store := &runtime.Volumes{Dir: t.TempDir()}
	for _, id := range []string{"vol_open", "vol_free"} {
		if _, err := store.Ensure(&agentv1.HostVolume{VolumeId: id, SizeBytes: 1 << 20, Serial: "s"}); err != nil {
			t.Fatal(err)
		}
	}
	c := &instancesConverger{a: &Agent{log: slog.New(slog.NewTextHandler(io.Discard, nil))}, volumes: store}
	open := []runtime.AttachedVolume{{Volume: runtime.Volume{ID: "vol_open"}}}
	domains := map[string]runtime.Domain{"inst_a": {ID: "inst_a", Managed: true, State: runtime.StateRunning, Volumes: open}}
	section := &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{{InstanceId: "inst_a",
		DesiredState: agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING}}}
	c.collectVolumes(section, nil, domains)
	if ids, _ := store.List(); len(ids) != 1 || ids[0] != "vol_open" {
		t.Fatalf("volumes = %v", ids)
	}
	// Its delete failed this pass: still open, kept.
	section.Instances[0].DesiredState = agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_DELETED
	c.collectVolumes(section, map[string]string{"inst_a": "virsh: busy"}, domains)
	if ids, _ := store.List(); len(ids) != 1 {
		t.Fatalf("volumes = %v", ids)
	}
	// Deleted this pass: it let go, and the volume goes in the same pass.
	c.collectVolumes(section, nil, domains)
	if ids, _ := store.List(); len(ids) != 0 {
		t.Fatalf("volumes = %v", ids)
	}
}

// Volumes are created before their instances, handed to runtimes by path and serial, and destroyed
// once unlisted and unattached.
func TestVolumesLiveAcrossInstancesAndGoWhenUnlisted(t *testing.T) {
	kata := &kataPlugin{instances: map[string]coreInstanceStatus{}}
	h := newHarness(t, func(o *Options) {
		o.Drivers = []HostedDriver{{Manifest: &commonv1.DriverManifest{Id: "kata", Version: "1.2.0", Kinds: []string{"runtime"}}, Host: kata}}
		o.Runtimes = PluginRuntimes(o.Drivers, nil)
	})
	s, _ := h.open()
	store := &runtime.Volumes{Dir: runtime.VolumeDir(h.agent.o.DataDir)}
	volA := &agentv1.HostVolume{VolumeId: "vol_a", SizeBytes: 1 << 20, Serial: "bcv-a"}
	volB := &agentv1.HostVolume{VolumeId: "vol_b", SizeBytes: 1 << 20, Serial: "bcv-b"}
	withA := func(id string) *agentv1.InstanceSpec {
		sp := vm(id, agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
		sp.Runtime = "kata"
		sp.Volumes = []*agentv1.InstanceVolume{{VolumeId: "vol_a"}}
		return sp
	}
	pass := func(generation uint64, section *agentv1.InstancesSection) *agentv1.StatusReport {
		t.Helper()
		s.push(desired(generation, &agentv1.NodeSpec{Instances: section}))
		return s.next(t, "status", func(f *agentv1.AgentFrame) bool {
			return f.GetStatus().GetObservedGeneration() == generation
		}).GetStatus()
	}
	message := func(st *agentv1.StatusReport, id string) string {
		for _, i := range st.GetInstances() {
			if i.GetInstanceId() == id {
				return i.GetMessage()
			}
		}
		return ""
	}

	st := pass(1, &agentv1.InstancesSection{Volumes: []*agentv1.HostVolume{volA, volB}, Instances: []*agentv1.InstanceSpec{withA("inst_1"), withA("inst_2")}})
	if !strings.Contains(message(st, "inst_2"), "volume vol_a is attached read-write to inst_1") {
		t.Fatalf("inst_2: %q", message(st, "inst_2"))
	}
	kata.mu.Lock()
	applied := kata.applied[len(kata.applied)-1]
	kata.mu.Unlock()
	if applied.ID != "inst_1" || len(applied.Volumes) != 1 || applied.Volumes[0].Path != runtime.VolumeDir(h.agent.o.DataDir)+"/vol_a.raw" ||
		applied.Volumes[0].Serial != "bcv-a" || applied.Volumes[0].ReadOnly {
		t.Fatalf("applied = %+v", applied)
	}
	if ids, _ := store.List(); len(ids) != 2 {
		t.Fatalf("volumes = %v", ids)
	}

	// vol_b unlisted and unattached: destroyed. vol_a is unlisted too, but inst_1 still attaches it.
	st = pass(2, &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{withA("inst_1")}})
	if ids, _ := store.List(); len(ids) != 1 || ids[0] != "vol_a" {
		t.Fatalf("volumes = %v", ids)
	}
	if !strings.Contains(message(st, "inst_1"), "volume vol_a is not on this host") {
		t.Fatalf("inst_1: %q", message(st, "inst_1"))
	}
	// inst_1 deleted: vol_a goes with it.
	gone := withA("inst_1")
	gone.DesiredState = agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_DELETED
	pass(3, &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{gone}})
	if ids, _ := store.List(); len(ids) != 0 {
		t.Fatalf("volumes = %v", ids)
	}
	if _, err := os.Stat(runtime.VolumeDir(h.agent.o.DataDir) + "/vol_a.json"); !os.IsNotExist(err) {
		t.Fatalf("vol_a's serial outlived it: %v", err)
	}
}
