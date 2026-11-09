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

// chFixture is a cloud-hypervisor runtime over the fakes, with an image server.
type chFixture struct {
	c    *CloudHypervisor
	ch   *fakeCH
	dir  string
	spec func(id string) *agentv1.InstanceSpec
	// kill, when set, stands for bcd being killed at that command: Ensure never returns.
	kill string
}

func newCHFixture(t *testing.T) *chFixture {
	t.Helper()
	image := qcow2Image(2<<30, "", "", []byte("base image"))
	sum := sha256.Sum256(image)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(image) }))
	t.Cleanup(srv.Close)
	f := &chFixture{dir: t.TempDir()}
	f.ch = &fakeCH{virt: &fakeVirt{domains: map[string]*fakeDomain{}}, vmms: map[string]*fakeVMM{}, units: map[string]string{}}
	f.c = f.runtime(t, srv.Client())
	f.spec = func(id string) *agentv1.InstanceSpec {
		return &agentv1.InstanceSpec{InstanceId: id, Runtime: "cloud-hypervisor", Vcpu: 2, MemoryBytes: 1 << 30, DiskBytes: 10 << 30,
			Image: &agentv1.ImageRef{Url: srv.URL + "/a.qcow2", Sha256: sum[:], Format: "qcow2"},
			Nics:  []*agentv1.InstanceNic{{Network: "br0", Mac: "52:54:00:00:00:07"}}}
	}
	return f
}

// runtime is a runtime object over the fixture's directory (a new one: bcd restarted).
func (f *chFixture) runtime(t *testing.T, client *http.Client) *CloudHypervisor {
	return &CloudHypervisor{Dir: f.dir, API: f.ch.api, HTTP: client, Poll: 1, ShutdownTimeout: 1, Chown: f.ch.chown,
		OpenTap:   func(string) (*os.File, error) { return os.CreateTemp(t.TempDir(), "tap") },
		VFIOGroup: func(string) (string, error) { return "42", nil }, VFIO: &fakeVFIO{},
		GPUAddress: func(id string) (string, bool) { return map[string]string{"GPU-1": "0000:3b:00.0"}[id], id == "GPU-1" },
		Exec: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			if f.kill != "" && name == f.kill {
				panic("bcd killed at " + name)
			}
			return f.ch.exec(ctx, name, args...)
		}}
}

// killedEnsure runs Ensure with bcd "killed" at command: nothing after it runs, no cleanup either.
func (f *chFixture) killedEnsure(c *CloudHypervisor, spec *agentv1.InstanceSpec, command string) {
	f.kill = command
	defer func() {
		f.kill = ""
		_ = recover()
	}()
	_ = c.Ensure(context.Background(), spec, []byte("#cloud-config\nhostname: web\n"), nil)
}

// A bcd killed in the middle of Ensure leaves an instance directory. It must not wedge its id: the
// directory is bcd's own, known as unfinished, never listed or started, and made again or removed.
func TestCloudHypervisorKilledMidEnsure(t *testing.T) {
	f := newCHFixture(t)
	c, ctx := f.c, context.Background()
	if _, err := c.List(ctx); err != nil { // the start's sweep is behind us
		t.Fatal(err)
	}
	web := filepath.Join(f.dir, "instances", "inst_web")

	f.killedEnsure(c, f.spec("inst_web"), "qemu-img")
	if _, err := os.Stat(web); err != nil {
		t.Fatalf("the killed Ensure left no directory to recover from: %v", err)
	}
	if domains, err := c.List(ctx); err != nil || len(domains) != 0 {
		t.Fatalf("an unfinished instance is listed: %+v, %v", domains, err)
	}
	if err := c.SetState(ctx, "inst_web", StateRunning); err == nil {
		t.Fatal("an unfinished instance started")
	}
	// The next pass makes it again, with its user data.
	if err := c.Ensure(ctx, f.spec("inst_web"), []byte("#cloud-config\nhostname: web\n"), nil); err != nil {
		t.Fatalf("Ensure after a killed Ensure = %v", err)
	}
	if seed, _ := os.ReadFile(filepath.Join(web, "seed.iso")); !bytes.Contains(seed, []byte("hostname: web")) {
		t.Fatalf("seed = %q", seed)
	}
	if rec, _ := os.ReadFile(filepath.Join(web, "vm.json")); bytes.Contains(rec, []byte(`"creating"`)) {
		t.Fatalf("the finished instance is still marked as being created:\n%s", rec)
	}
	if domains, _ := c.List(ctx); len(domains) != 1 || domains[0].ID != "inst_web" || domains[0].State != StateStopped {
		t.Fatalf("list = %+v", domains)
	}
	if err := c.SetState(ctx, "inst_web", StateRunning); err != nil {
		t.Fatal(err)
	}

	// Killed again, earlier and later; then no longer wanted: Destroy removes what is left.
	for _, at := range []string{"qemu-img", "genisoimage"} {
		gone := filepath.Join(f.dir, "instances", "inst_gone")
		f.killedEnsure(c, f.spec("inst_gone"), at)
		if _, err := os.Stat(gone); err != nil {
			t.Fatalf("killed at %s: %v", at, err)
		}
		if err := c.Destroy(ctx, "inst_gone"); err != nil {
			t.Fatalf("Destroy of an unfinished instance (killed at %s) = %v", at, err)
		}
		if _, err := os.Stat(gone); err == nil {
			t.Fatalf("killed at %s: the unfinished instance's directory stayed", at)
		}
	}

	// An Ensure that fails after its disk exists (a GPU this host does not have) leaves nothing that
	// refuses the corrected spec.
	bad := f.spec("inst_gpu")
	bad.GpuDeviceIds = []string{"GPU-unknown"}
	if err := c.Ensure(ctx, bad, nil, nil); err == nil || !strings.Contains(err.Error(), "no PCI address") {
		t.Fatalf("Ensure with an unknown GPU = %v", err)
	}
	if err := c.Ensure(ctx, f.spec("inst_gpu"), nil, nil); err != nil {
		t.Fatalf("Ensure after a failed Ensure = %v", err)
	}

	// bcd restarted: what the kill left is removed at its first List, the running instance kept.
	f.killedEnsure(c, f.spec("inst_left"), "genisoimage")
	stray := filepath.Join(f.dir, "instances", newDirPrefix+"123")
	_ = os.MkdirAll(stray, 0o700)
	foreign := filepath.Join(f.dir, "instances", "someone-elses")
	_ = os.MkdirAll(foreign, 0o700)
	restarted := f.runtime(t, c.HTTP)
	domains, err := restarted.List(ctx)
	if err != nil || len(domains) != 2 {
		t.Fatalf("list after a restart = %+v, %v", domains, err)
	}
	for _, p := range []string{filepath.Join(f.dir, "instances", "inst_left"), stray} {
		if _, err := os.Stat(p); err == nil {
			t.Fatalf("%s survived the restart", p)
		}
	}
	// A directory without bcd's record is still nobody's to touch.
	if _, err := os.Stat(foreign); err != nil {
		t.Fatal("a directory bcd did not make was removed")
	}
	if got, _, _ := restarted.state(ctx, "inst_web"); got != StateRunning {
		t.Fatalf("inst_web = %s after the restart", got)
	}
}

// The record is the first thing in a new instance's directory: at no step is there a directory
// without the vm.json that says it is bcd's.
func TestCloudHypervisorRecordComesFirst(t *testing.T) {
	f := newCHFixture(t)
	web := filepath.Join(f.dir, "instances", "inst_web")
	seen := 0
	inner := f.c.Exec
	f.c.Exec = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if _, err := os.Stat(web); err == nil {
			seen++
			rec, err := os.ReadFile(filepath.Join(web, "vm.json"))
			if err != nil || !bytes.Contains(rec, []byte(`"creating": true`)) {
				t.Errorf("at %s the directory exists without a record marked creating: %v\n%s", name, err, rec)
			}
		}
		return inner(ctx, name, args...)
	}
	if err := f.c.Ensure(context.Background(), f.spec("inst_web"), nil, nil); err != nil {
		t.Fatal(err)
	}
	if seen == 0 {
		t.Fatal("no command ran while the instance was being created")
	}
}

// A VMM whose API fails says nothing about its VM: the state comes from its unit, and when the unit
// runs and the API does not answer it is unknown, never "stopped". Nothing that needs a stopped VM
// (an offline resize, a start that recreates the taps, a disk copy) runs on an unknown one.
func TestCloudHypervisorUnknownStateIsNotStopped(t *testing.T) {
	f := newCHFixture(t)
	c, ctx := f.c, context.Background()
	spec := f.spec("inst_web")
	if err := c.Ensure(ctx, spec, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.SetState(ctx, "inst_web", StateRunning); err != nil {
		t.Fatal(err)
	}
	mark := func() (int, int) {
		f.ch.mu.Lock()
		defer f.ch.mu.Unlock()
		f.ch.virt.mu.Lock()
		defer f.ch.virt.mu.Unlock()
		return len(f.ch.calls), len(f.ch.virt.calls)
	}
	since := func(chFrom, virtFrom int) string {
		f.ch.mu.Lock()
		defer f.ch.mu.Unlock()
		f.ch.virt.mu.Lock()
		defer f.ch.virt.mu.Unlock()
		return strings.Join(append(append([]string(nil), f.ch.calls[chFrom:]...), f.ch.virt.calls[virtFrom:]...), "\n")
	}

	// The VM runs; its API socket stops answering.
	f.ch.apiDown = true
	chFrom, virtFrom := mark()
	if st, _, err := c.state(ctx, "inst_web"); err == nil {
		t.Fatalf("state with a running unit and a dead API = %q, want an error", st)
	}
	domains, err := c.List(ctx)
	if err != nil || len(domains) != 1 || domains[0].State != StateError || !strings.Contains(domains[0].Message, "unknown") {
		t.Fatalf("list = %+v, %v", domains, err)
	}
	grown := f.spec("inst_web")
	grown.DiskBytes = 20 << 30
	if err := c.Ensure(ctx, grown, nil, nil); err == nil {
		t.Fatal("a disk grew while its VM's state was unknown")
	}
	if err := c.SetState(ctx, "inst_web", StateRunning); err == nil {
		t.Fatal("a VM whose state is unknown was started again")
	}
	if _, err := c.Snapshot(ctx, "inst_web", false, "", &bytes.Buffer{}); err == nil {
		t.Fatal("a VM whose state is unknown was snapshotted")
	}
	calls := since(chFrom, virtFrom)
	for _, never := range []string{"qemu-img resize", "qemu-img convert", "ip link delete", "ip tuntap add", "systemd-run"} {
		if strings.Contains(calls, never) {
			t.Fatalf("%q ran on a VM whose state was unknown:\n%s", never, calls)
		}
	}

	// systemd cannot be asked either: still unknown.
	f.ch.systemdDown = true
	if st, _, err := c.state(ctx, "inst_web"); err == nil {
		t.Fatalf("state without systemd = %q, want an error", st)
	}
	f.ch.systemdDown = false

	// A stop still goes through (it ends in the unit's own state), and then the state is known again
	// with the API as silent as before: the unit is gone.
	if err := c.SetState(ctx, "inst_web", StateStopped); err != nil {
		t.Fatalf("stopping a VM whose state is unknown = %v", err)
	}
	if st, _, err := c.state(ctx, "inst_web"); err != nil || st != StateStopped {
		t.Fatalf("state after the stop = %q, %v", st, err)
	}
	f.ch.apiDown = false
	if err := c.Ensure(ctx, grown, nil, nil); err != nil {
		t.Fatalf("growing the stopped VM's disk = %v", err)
	}

	// A VMM that runs and answers that it has no VM is stopped (a start that failed after its launch).
	socket := c.socket("inst_web")
	f.ch.mu.Lock()
	f.ch.vmms[socket] = &fakeVMM{}
	f.ch.units[unitName("inst_web")] = socket
	f.ch.mu.Unlock()
	if st, _, err := c.state(ctx, "inst_web"); err != nil || st != StateStopped {
		t.Fatalf("state of a VMM without a VM = %q, %v", st, err)
	}
	if err := c.SetState(ctx, "inst_web", StateRunning); err != nil {
		t.Fatal(err)
	}
	if st, _, err := c.state(ctx, "inst_web"); err != nil || st != StateRunning {
		t.Fatalf("state = %q, %v", st, err)
	}
}
