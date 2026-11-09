package runtime

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func gone(t *testing.T, paths ...string) {
	t.Helper()
	for _, p := range paths {
		if _, err := os.Lstat(p); err == nil {
			t.Errorf("%s survived the start", p)
		}
	}
}

// What a bcd killed mid-download or mid-snapshot left is removed when the next one starts; a guest
// a killed memory snapshot left saved keeps its memory.
func TestLibvirtSweepsLeftoversAtStart(t *testing.T) {
	image := qcow2Image(2<<30, "", "", []byte("base image"))
	sum := sha256.Sum256(image)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(image) }))
	defer srv.Close()
	virt := &fakeVirt{domains: map[string]*fakeDomain{}}
	dir := t.TempDir()
	first := &Libvirt{Dir: dir, Exec: virt.exec, HTTP: srv.Client()}
	ctx := context.Background()
	spec := func(id string) *agentv1.InstanceSpec {
		return &agentv1.InstanceSpec{InstanceId: id, Runtime: "libvirt-kvm", Vcpu: 1, MemoryBytes: 1 << 30, DiskBytes: 10 << 30,
			Image: &agentv1.ImageRef{Url: srv.URL + "/a.qcow2", Sha256: sum[:], Format: "qcow2"}}
	}
	for _, id := range []string{"inst_a", "inst_b"} {
		if err := first.Ensure(ctx, spec(id), nil, nil); err != nil {
			t.Fatal(err)
		}
		if err := first.SetState(ctx, id, StateRunning); err != nil {
			t.Fatal(err)
		}
	}
	instances := filepath.Join(dir, "instances")
	// A download cut short; a disk-only snapshot's work directory; a memory snapshot killed while
	// libvirt was still saving (inst_a runs on: the file is partial).
	pull := filepath.Join(dir, "images", ".pull-123")
	mustWrite(t, pull, "half an image")
	diskOnly := filepath.Join(instances, "inst_a", ".snapshot-1")
	mustWrite(t, filepath.Join(diskOnly, "disk.qcow2"), "flat")
	partial := filepath.Join(instances, "inst_a", ".snapshot-2")
	mustWrite(t, filepath.Join(partial, "memory.state"), "half a memory")
	// A memory snapshot killed after `virsh save`: inst_b is off, its memory only in the work directory.
	saved := filepath.Join(instances, "inst_b", ".snapshot-3")
	if err := os.MkdirAll(saved, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := first.virsh(ctx, "save", "inst_b", filepath.Join(saved, "memory.state")); err != nil {
		t.Fatal(err)
	}
	// An Ensure killed mid-creation, for an instance nobody asks for again.
	unfinished := filepath.Join(instances, "inst_c")
	mustWrite(t, filepath.Join(unfinished, creatingMarker), "")
	mustWrite(t, filepath.Join(unfinished, "disk.qcow2"), "half a disk")

	// bcd starts again. libvirt does not answer at first: nothing that needs its word is decided.
	restarted := &Libvirt{Dir: dir, Exec: virt.exec, HTTP: srv.Client()}
	virt.down = true
	if _, err := restarted.List(ctx); err == nil {
		t.Fatal("List with libvirt down")
	}
	gone(t, pull, diskOnly)
	for _, p := range []string{filepath.Join(saved, "memory.state"), unfinished} {
		if _, err := os.Lstat(p); err != nil {
			t.Fatalf("%s was removed while libvirt could not say what it is", p)
		}
	}
	virt.down = false
	domains, err := restarted.List(ctx)
	if err != nil || len(domains) != 2 {
		t.Fatalf("list = %+v, %v", domains, err)
	}
	gone(t, pull, diskOnly, partial, saved, unfinished, filepath.Join(instances, "inst_a", "memory.state"))
	kept, err := os.ReadFile(filepath.Join(instances, "inst_b", "memory.state"))
	if err != nil || string(kept) != "memory of inst_b" {
		t.Fatalf("the saved guest's memory was not kept: %q, %v", kept, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "images", fileName(sum))); err != nil {
		t.Fatalf("the base image: %v", err)
	}
	// The saved guest starts from its memory.
	if err := restarted.SetState(ctx, "inst_b", StateRunning); err != nil {
		t.Fatal(err)
	}
	if countCalls(virt.calls, "virsh restore "+filepath.Join(instances, "inst_b", "memory.state")) != 1 {
		t.Fatal("inst_b did not start from its kept memory")
	}
}

func fileName(sum [32]byte) string {
	const hexdigits = "0123456789abcdef"
	out := make([]byte, 0, 70)
	for _, b := range sum {
		out = append(out, hexdigits[b>>4], hexdigits[b&15])
	}
	return string(out) + ".qcow2"
}

func TestCloudHypervisorSweepsLeftoversAtStart(t *testing.T) {
	f := newCHFixture(t)
	ctx := context.Background()
	if err := f.c.Ensure(ctx, f.spec("inst_web"), nil, nil); err != nil {
		t.Fatal(err)
	}
	pull := filepath.Join(f.dir, "images", ".pull-9")
	mustWrite(t, pull, "half an image")
	work := filepath.Join(f.dir, "instances", "inst_web", ".snapshot-9")
	mustWrite(t, filepath.Join(work, "ch", "memory-ranges"), "half a memory")
	foreign := filepath.Join(f.dir, "instances", "someone-elses", ".snapshot-1")
	mustWrite(t, filepath.Join(foreign, "x"), "not bcd's")

	restarted := f.runtime(t, f.c.HTTP)
	domains, err := restarted.List(ctx)
	if err != nil || len(domains) != 1 {
		t.Fatalf("list = %+v, %v", domains, err)
	}
	gone(t, pull, work)
	if _, err := os.Stat(foreign); err != nil {
		t.Fatal("a directory that is not bcd's was swept")
	}
	if entries, _ := os.ReadDir(filepath.Join(f.dir, "images")); len(entries) != 1 {
		t.Fatalf("images/ = %v", entries)
	}
}
