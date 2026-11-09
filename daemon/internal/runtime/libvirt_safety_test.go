package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

func countCalls(calls []string, prefix string) int {
	n := 0
	for _, c := range calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

// libvirtd restarting mid-pass answers nothing: that is not "the domain does not exist", and no disk
// is ever created over an existing one.
func TestLibvirtEnsureNeverRecreatesADisk(t *testing.T) {
	image := qcow2Image(2<<30, "", "", []byte("base image"))
	sum := sha256.Sum256(image)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(image) }))
	defer srv.Close()
	virt := &fakeVirt{domains: map[string]*fakeDomain{}}
	dir := t.TempDir()
	l := &Libvirt{Dir: dir, Exec: virt.exec, HTTP: srv.Client()}
	ctx := context.Background()
	spec := &agentv1.InstanceSpec{InstanceId: "inst_a", Runtime: "libvirt-kvm", Vcpu: 1, MemoryBytes: 1 << 30, DiskBytes: 10 << 30,
		Image: &agentv1.ImageRef{Url: srv.URL + "/a.qcow2", Sha256: sum[:], Format: "qcow2"}}
	if err := l.Ensure(ctx, spec, []byte("#cloud-config\n"), nil); err != nil {
		t.Fatal(err)
	}
	inst := filepath.Join(dir, "instances", "inst_a")
	disk := filepath.Join(inst, "disk.qcow2")
	if _, err := os.Stat(filepath.Join(inst, creatingMarker)); err == nil {
		t.Fatal("the creation marker stayed after the domain was defined")
	}
	// What the tenant wrote since.
	f, err := os.OpenFile(disk, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("the tenant's data")
	f.Close()
	before, _ := os.ReadFile(disk)
	seedBefore, _ := os.ReadFile(filepath.Join(inst, "seed.iso"))
	unchanged := func(when string) {
		t.Helper()
		after, err := os.ReadFile(disk)
		if err != nil || !bytes.Equal(before, after) {
			t.Fatalf("%s: the disk changed (%v)", when, err)
		}
		if seed, _ := os.ReadFile(filepath.Join(inst, "seed.iso")); !bytes.Equal(seed, seedBefore) {
			t.Fatalf("%s: the seed was rewritten", when)
		}
	}
	creates := countCalls(virt.calls, "qemu-img create")

	// libvirtd is restarting.
	virt.down = true
	if err := l.Ensure(ctx, spec, []byte("#cloud-config\nother: true\n"), nil); err == nil || !strings.Contains(err.Error(), "does not answer") {
		t.Fatalf("Ensure while libvirt is down = %v", err)
	}
	unchanged("Ensure while libvirt is down")
	if got := countCalls(virt.calls, "qemu-img create"); got != creates {
		t.Fatalf("qemu-img create ran %d more time(s) while libvirt was down", got-creates)
	}
	if err := l.Destroy(ctx, "inst_a"); err == nil {
		t.Fatal("Destroy while libvirt is down removed the files of a domain it could not read")
	}
	unchanged("Destroy while libvirt is down")
	if err := l.SetState(ctx, "inst_a", StateRunning); err == nil || strings.Contains(err.Error(), "no managed domain") {
		t.Fatalf("SetState while libvirt is down = %v", err)
	}
	virt.down = false

	// The domain's state cannot be read: its disk is not resized offline (it may be open).
	virt.failVerb = "domstate"
	spec.DiskBytes = 20 << 30
	if err := l.Ensure(ctx, spec, nil, nil); err == nil {
		t.Fatal("a disk grew while its domain's state was unreadable")
	}
	if countCalls(virt.calls, "qemu-img resize") != 0 {
		t.Fatal("qemu-img resize ran on a disk whose domain may be running")
	}
	unchanged("a grow with an unreadable state")
	virt.failVerb = ""
	spec.DiskBytes = 10 << 30

	// The definition is gone (libvirt answers and does not list it) but the disk is there: refused.
	virt.mu.Lock()
	delete(virt.domains, "inst_a")
	virt.mu.Unlock()
	if err := l.Ensure(ctx, spec, []byte("#cloud-config\n"), nil); err == nil || !strings.Contains(err.Error(), "does not create a disk over it") {
		t.Fatalf("Ensure over a disk without a domain = %v", err)
	}
	unchanged("Ensure over a disk without a domain")

	// What an Ensure killed mid-creation left (its marker is still there) is started over.
	half := filepath.Join(dir, "instances", "inst_b")
	_ = os.MkdirAll(half, 0o700)
	_ = os.WriteFile(filepath.Join(half, creatingMarker), nil, 0o600)
	_ = os.WriteFile(filepath.Join(half, "disk.qcow2"), []byte("half a disk"), 0o600)
	specB := &agentv1.InstanceSpec{InstanceId: "inst_b", Runtime: "libvirt-kvm", Vcpu: 1, MemoryBytes: 1 << 30, DiskBytes: 10 << 30, Image: spec.Image}
	if err := l.Ensure(ctx, specB, nil, nil); err != nil {
		t.Fatalf("Ensure after an unfinished creation = %v", err)
	}
	if _, err := readQcow2(filepath.Join(half, "disk.qcow2")); err != nil {
		t.Fatalf("the unfinished instance's disk was not created again: %v", err)
	}
	if _, err := os.Stat(filepath.Join(half, creatingMarker)); err == nil {
		t.Fatal("the creation marker stayed")
	}
	if _, ok := virt.domains["inst_b"]; !ok {
		t.Fatal("the unfinished instance was not defined")
	}
}

// After a memory snapshot the domain is restored from its saved state. When that fails the guest is
// off: Snapshot says so and keeps the state where the next start finds it, instead of removing it
// with its work directory and reporting success.
func TestLibvirtSnapshotKeepsTheMemoryOfADomainThatDidNotResume(t *testing.T) {
	image := qcow2Image(2<<30, "", "", []byte("base image"))
	sum := sha256.Sum256(image)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(image) }))
	defer srv.Close()
	virt := &fakeVirt{domains: map[string]*fakeDomain{}}
	dir := t.TempDir()
	l := &Libvirt{Dir: dir, Exec: virt.exec, HTTP: srv.Client()}
	ctx := context.Background()
	spec := &agentv1.InstanceSpec{InstanceId: "inst_a", Runtime: "libvirt-kvm", Vcpu: 1, MemoryBytes: 1 << 30, DiskBytes: 10 << 30,
		Image: &agentv1.ImageRef{Url: srv.URL + "/a.qcow2", Sha256: sum[:], Format: "qcow2"}}
	if err := l.Ensure(ctx, spec, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := l.SetState(ctx, "inst_a", StateRunning); err != nil {
		t.Fatal(err)
	}
	inst := filepath.Join(dir, "instances", "inst_a")

	// libvirt saves the guest, then cannot restore it (out of memory, a device gone).
	virt.failVerb = "restore"
	var snap bytes.Buffer
	_, err := l.Snapshot(ctx, "inst_a", true, "AMD EPYC 9654", &snap)
	if err == nil || !strings.Contains(err.Error(), "did not carry on") {
		t.Fatalf("Snapshot of a domain that did not resume = %v", err)
	}
	if virt.domains["inst_a"].state != "shut off" {
		t.Fatalf("the fake restored the domain: %s", virt.domains["inst_a"].state)
	}
	kept, readErr := os.ReadFile(filepath.Join(inst, "memory.state"))
	if readErr != nil || string(kept) != "memory of inst_a" {
		t.Fatalf("the guest's memory state was not kept: %q, %v", kept, readErr)
	}
	if left, _ := filepath.Glob(filepath.Join(inst, ".snapshot-*")); len(left) != 0 {
		t.Fatalf("the snapshot's work directory stayed: %v", left)
	}

	// The next start restores the guest from it, and then the state file goes.
	virt.failVerb = ""
	if err := l.SetState(ctx, "inst_a", StateRunning); err != nil {
		t.Fatal(err)
	}
	if virt.domains["inst_a"].state != "running" || countCalls(virt.calls, "virsh restore "+filepath.Join(inst, "memory.state")) != 1 {
		t.Fatalf("the domain did not start from its kept memory: %s\n%s", virt.domains["inst_a"].state, strings.Join(virt.calls, "\n"))
	}
	if _, err := os.Stat(filepath.Join(inst, "memory.state")); err == nil {
		t.Fatal("the memory state stayed after the restore")
	}

	// A disk-only snapshot's resume that fails is reported too (the domain stays paused).
	virt.failVerb = "resume"
	if _, err := l.Snapshot(ctx, "inst_a", false, "", &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "stayed paused") {
		t.Fatalf("Snapshot of a domain that stayed paused = %v", err)
	}
	virt.failVerb = ""
	// And a snapshot that goes well is still a success.
	_ = l.SetState(ctx, "inst_a", StateRunning)
	if _, err := l.Snapshot(ctx, "inst_a", true, "AMD EPYC 9654", &bytes.Buffer{}); err != nil || virt.domains["inst_a"].state != "running" {
		t.Fatalf("Snapshot = %v (%s)", err, virt.domains["inst_a"].state)
	}
}
