package runtime

import (
	"bytes"
	"path/filepath"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// The fake opens a spec's volumes at its next start, as a real runtime does, and refuses a memory
// snapshot beside a read-write one.
func TestFakeOpensVolumesAtStart(t *testing.T) {
	ctx := t.Context()
	f := &Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "fake.json"), BootID: "b1"}
	spec := &agentv1.InstanceSpec{InstanceId: "inst_f", Vcpu: 1, MemoryBytes: 1 << 30,
		Volumes: []*agentv1.InstanceVolume{{VolumeId: "vol_a"}}}
	open := func() []AttachedVolume {
		t.Helper()
		ds, err := f.List(ctx)
		if err != nil || len(ds) != 1 {
			t.Fatalf("list = %v, %v", ds, err)
		}
		return ds[0].Volumes
	}
	if err := f.Ensure(ctx, spec, nil, nil); err != nil {
		t.Fatal(err)
	}
	if v := open(); len(v) != 0 {
		t.Fatalf("stopped with %v open", v)
	}
	_ = f.SetState(ctx, "inst_f", StateRunning)
	if v := open(); len(v) != 1 || v[0].ID != "vol_a" || v[0].ReadOnly {
		t.Fatalf("open = %v", v)
	}
	if _, err := f.Snapshot(ctx, "inst_f", true, "cpu", &bytes.Buffer{}); err != ErrMemorySnapshotWithVolumes {
		t.Fatalf("memory snapshot: %v", err)
	}
	// Detached in the spec: still open until the next start.
	spec.Volumes = nil
	_ = f.Ensure(ctx, spec, nil, nil)
	if v := open(); len(v) != 1 {
		t.Fatalf("a detach closed a running VM's volume: %v", v)
	}
	_ = f.SetState(ctx, "inst_f", StateStopped)
	if v := open(); len(v) != 0 {
		t.Fatalf("stopped with %v open", v)
	}
}
