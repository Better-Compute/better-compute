package runtime

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// fakeRoot plays bcd helper's ch.* ops: its launch is CHLaunch's (root's own check and unit), run by
// the fake systemd.
type fakeRoot struct {
	ch     *fakeCH
	policy CHRootPolicy
	mu     sync.Mutex
	ops    []string
}

func (f *fakeRoot) log(op string) {
	f.mu.Lock()
	f.ops = append(f.ops, op)
	f.mu.Unlock()
}

func (f *fakeRoot) Taps(_ context.Context, id string, networks []string) error {
	f.log("taps " + id + " " + strings.Join(networks, ","))
	return nil
}
func (f *fakeRoot) Untaps(_ context.Context, id string, nics int) error {
	f.log("untaps " + id)
	return nil
}
func (f *fakeRoot) BindVFIO(_ context.Context, id string) error { f.log("vfio " + id); return nil }
func (f *fakeRoot) ReleaseVFIO(_ context.Context, id string, _ []string) error {
	f.log("unvfio " + id)
	return nil
}
func (f *fakeRoot) Launch(ctx context.Context, id string) error {
	args, err := CHLaunch(ctx, f.policy, id)
	if err != nil {
		return err
	}
	f.log("launch " + id)
	_, err = f.ch.exec(ctx, "systemd-run", args...)
	return err
}
func (f *fakeRoot) Stop(ctx context.Context, id string) (string, error) {
	f.log("stop " + id)
	_, _ = f.ch.exec(ctx, "systemctl", "stop", unitName(id))
	out, err := f.ch.exec(ctx, "systemctl", "show", "--property=ActiveState", "--value", unitName(id))
	return strings.TrimSpace(string(out)), err
}

// Under the helper the node never runs systemd-run, ip or chown: root's ops do, from the record root
// checks itself; the files stay the node's, the VMM's user let in by ACLs.
func TestCloudHypervisorUnderTheHelper(t *testing.T) {
	image := qcow2Image(2<<30, "", "", []byte("ubuntu base image"))
	sum := sha256.Sum256(image)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(image) }))
	defer srv.Close()
	ch := &fakeCH{virt: &fakeVirt{domains: map[string]*fakeDomain{}}, vmms: map[string]*fakeVMM{}, units: map[string]string{}}
	dir := t.TempDir()
	root := &fakeRoot{ch: ch, policy: CHRootPolicy{
		Dir: dir, Volumes: filepath.Join(dir, "volumes"), Binary: "/usr/bin/cloud-hypervisor",
		CheckFile: func(string) error { return nil }, PCI: map[string]bool{},
		LiveUIDs: func(context.Context) (map[string]uint32, error) {
			return map[string]uint32{"inst_other": vmmUIDBase + 7}, nil
		},
	}}
	c := &CloudHypervisor{Dir: dir, Exec: ch.exec, API: ch.api, HTTP: srv.Client(), Poll: 1, ShutdownTimeout: 1, Chown: ch.chown,
		OpenTap: func(string) (*os.File, error) { return os.CreateTemp(t.TempDir(), "tap") }, Privileged: root, NodeUID: 1000}
	ctx := context.Background()
	spec := &agentv1.InstanceSpec{
		InstanceId: "inst_h", Runtime: "cloud-hypervisor", Vcpu: 2, MemoryBytes: 2 << 30, DiskBytes: 10 << 30,
		Image: &agentv1.ImageRef{Ref: "ubuntu", Url: srv.URL + "/u.qcow2", Sha256: sum[:], Format: "qcow2"},
		Nics:  []*agentv1.InstanceNic{{Network: "br0", Mac: "52:54:00:00:00:31"}},
	}
	if err := c.Ensure(ctx, spec, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.SetState(ctx, "inst_h", StateRunning); err != nil {
		if errors.Is(err, errors.ErrUnsupported) {
			t.Skip("no POSIX ACLs on this filesystem")
		}
		t.Fatal(err)
	}
	if st, _ := c.state(ctx, "inst_h"); st != StateRunning {
		t.Fatalf("state %s", st)
	}
	// Live usage is read as the node itself: the VMM unit's cgroup (world-readable) and its taps' counters, no
	// ch.* operation.
	fake := t.TempDir()
	oldCg, oldNet := cgroupRoot, sysClassNet
	cgroupRoot, sysClassNet = filepath.Join(fake, "cgroup"), filepath.Join(fake, "net")
	t.Cleanup(func() { cgroupRoot, sysClassNet = oldCg, oldNet })
	for path, content := range map[string]string{
		filepath.Join(cgroupRoot, "bcd-instances.slice", unitName("inst_h"), "cpu.stat"):       "usage_usec 2500000\n",
		filepath.Join(cgroupRoot, "bcd-instances.slice", unitName("inst_h"), "memory.current"): "1073741824\n",
		filepath.Join(sysClassNet, TapName("inst_h", 0), "statistics", "tx_bytes"):             "900\n",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o444); err != nil {
			t.Fatal(err)
		}
	}
	before := len(root.ops)
	usage, err := c.Usage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if u := usage["inst_h"]; u.CPUSeconds != 2.5 || u.MemoryBytes != 1<<30 || u.NetRxBytes != 900 {
		t.Fatalf("usage = %+v", usage)
	}
	if len(root.ops) != before {
		t.Fatalf("reading usage asked root: %v", root.ops[before:])
	}
	if err := c.SetState(ctx, "inst_h", StateStopped); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"taps inst_h br0", "launch inst_h", "stop inst_h", "untaps inst_h"} {
		if !slices.Contains(root.ops, want) {
			t.Errorf("root was not asked to %s: %v", want, root.ops)
		}
	}
	var unit string
	for _, call := range ch.calls {
		if strings.HasPrefix(call, "ip ") || strings.HasPrefix(call, "systemctl ") && !strings.Contains(call, unitName("inst_h")) {
			t.Errorf("the node ran %s", call)
		}
		if strings.HasPrefix(call, "systemd-run ") {
			unit = call
		}
	}
	if len(ch.chowns) != 0 {
		t.Errorf("the node chowned %v", ch.chowns)
	}
	// Root's unit: its binary, the shared umask, the record's user.
	for _, want := range []string{"-- /usr/bin/cloud-hypervisor --api-socket", "UMask=0007", "User=" + strconv.Itoa(vmmUIDBase)} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit lacks %s: %s", want, unit)
		}
	}
	// The VMM's user reads and writes the instance's files through ACL entries.
	if entries, err := readACLEntries(filepath.Join(dir, "instances", "inst_h", "disk.qcow2"), aclXattr); err == nil {
		found := false
		for _, e := range entries {
			found = found || e.tag == aclUser && e.id == vmmUIDBase && e.perm == aclRW
		}
		if !found {
			t.Errorf("disk ACL = %+v", entries)
		}
	}
}

// Root refuses a record that names anything but bcd's own files of that instance, or another
// running unit's VMM user.
func TestCHRecordRefusals(t *testing.T) {
	dir := t.TempDir()
	c := &CloudHypervisor{Dir: dir}
	policy := CHRootPolicy{Dir: dir, Volumes: filepath.Join(dir, "volumes"), Binary: "/usr/bin/cloud-hypervisor",
		CheckFile: func(string) error { return nil }, PCI: map[string]bool{"0000:3b:00.0": true},
		GPUAddress: func(id string) (string, bool) {
			return map[string]string{"GPU-1": "0000:3b:00.0", "GPU-2": "0000:5e:00.0"}[id], true
		},
		LiveUIDs: func(context.Context) (map[string]uint32, error) {
			return map[string]uint32{"inst_other": vmmUIDBase}, nil
		},
	}
	write := func(mut func(r *chRecord)) {
		t.Helper()
		r := &chRecord{ID: "inst_r", Managed: chManaged, UID: vmmUIDBase + 1, VCPU: 2, MemoryBytes: 1 << 30}
		mut(r)
		if err := os.MkdirAll(c.instanceDir("inst_r"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := c.save(r); err != nil {
			t.Fatal(err)
		}
	}
	for name, mut := range map[string]func(r *chRecord){
		"uid outside the range": func(r *chRecord) { r.UID = 0 },
		"another unit's uid":    func(r *chRecord) { r.UID = vmmUIDBase },
		"a foreign base":        func(r *chRecord) { r.Base, r.BaseFormat = "/etc/shadow", "raw" },
		"a foreign volume": func(r *chRecord) {
			r.Volumes = []AttachedVolume{{Volume: Volume{ID: "vol_a", Path: "/dev/sda"}}}
		},
		"a GPU not allowed": func(r *chRecord) { r.GPUs = []string{"GPU-2"} },
		"too much memory":   func(r *chRecord) { r.MemoryBytes = 1 << 50 },
		"a bad cpu list":    func(r *chRecord) { r.Placement = &Placement{CPUList: "0-3;rm -rf"} },
	} {
		write(mut)
		if _, err := CHLaunch(context.Background(), policy, "inst_r"); err == nil {
			t.Errorf("%s: launched", name)
		}
	}
	// A symlink in the instance's directory is refused.
	write(func(*chRecord) {})
	if err := os.Symlink("/etc/shadow", filepath.Join(c.instanceDir("inst_r"), "seed.iso")); err != nil {
		t.Fatal(err)
	}
	if _, err := CHLaunch(context.Background(), policy, "inst_r"); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("a symlink: %v", err)
	}
	_ = os.Remove(filepath.Join(c.instanceDir("inst_r"), "seed.iso"))
	args, err := CHLaunch(context.Background(), policy, "inst_r")
	if err != nil || !strings.Contains(strings.Join(args, " "), "--unit="+unitName("inst_r")) {
		t.Fatalf("a good record: %v %v", args, err)
	}
	if _, err := CHLaunch(context.Background(), policy, "../etc"); err == nil {
		t.Fatal("a path as an instance id")
	}
}
