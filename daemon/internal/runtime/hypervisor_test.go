package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// fakeHelper plays bcd helper's libvirt ops on a fakeVirt (as root would through virsh).
type fakeHelper struct {
	virt *fakeVirt
	dir  string
	ops  []string
}

func (h *fakeHelper) Libvirt(_ context.Context, verb string, op LibvirtOp) error {
	h.virt.mu.Lock()
	defer h.virt.mu.Unlock()
	h.ops = append(h.ops, strings.TrimSpace(verb+" "+op.Domain))
	staged := func(xml []byte) string {
		f, _ := os.CreateTemp(h.dir, "domain-*.xml")
		_, _ = f.Write(xml)
		f.Close()
		return f.Name()
	}
	var err error
	switch verb {
	case "define":
		_, err = h.virt.virsh([]string{"define", staged(op.XML)})
	case "start", "shutdown", "destroy", "suspend", "resume", "undefine":
		args := []string{verb, op.Domain}
		if op.Paused {
			args = append(args, "--paused")
		}
		_, err = h.virt.virsh(args)
	case "save":
		_, err = h.virt.virsh([]string{"save", op.Domain, op.File})
	case "restore":
		args := []string{"restore", op.File}
		if len(op.XML) > 0 {
			args = append(args, "--xml", staged(op.XML))
		}
		if op.Paused {
			args = append(args, "--paused")
		}
		_, err = h.virt.virsh(args)
	case "attach-disk":
		go func() { _ = guestAck(op.File) }()
	case "blockresize", "detach-disk":
	}
	return err
}

func (h *fakeHelper) Console(_ context.Context, domain string) (*os.File, error) {
	h.ops = append(h.ops, "console "+domain)
	return os.CreateTemp(h.dir, "pty")
}

// Under bcd helper the node writes nothing through qemu:///system: reads use the read-only socket,
// everything else is the helper's, and QEMU reaches the files through the node's group.
func TestLibvirtUnderTheHelper(t *testing.T) {
	image := qcow2Image(2<<30, "", "", []byte("ubuntu base image"))
	sum := sha256.Sum256(image)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(image) }))
	defer srv.Close()
	virt := &fakeVirt{domains: map[string]*fakeDomain{}}
	helper := &fakeHelper{virt: virt, dir: t.TempDir()}
	dir := t.TempDir()
	l := &Libvirt{Dir: dir, Exec: virt.exec, HTTP: srv.Client(), Hypervisor: helper}
	ctx := context.Background()
	spec := &agentv1.InstanceSpec{
		InstanceId: "inst_h", Runtime: "libvirt-kvm", Vcpu: 2, MemoryBytes: 2 << 30, DiskBytes: 10 << 30,
		Image: &agentv1.ImageRef{Ref: "ubuntu", Url: srv.URL + "/u.qcow2", Sha256: sum[:], Format: "qcow2"},
		Nics:  []*agentv1.InstanceNic{{Network: "br0", Mac: "52:54:00:00:00:21"}},
	}
	if err := l.Ensure(ctx, spec, nil, nil); err != nil {
		t.Fatal(err)
	}
	inst := filepath.Join(dir, "instances", "inst_h")
	for path, want := range map[string]os.FileMode{filepath.Join(inst, "disk.qcow2"): 0o660, filepath.Join(inst, "seed.iso"): 0o640} {
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != want {
			t.Errorf("%s: %v %v, want %v", path, info.Mode(), err, want)
		}
	}
	if info, _ := os.Stat(inst); info.Mode().Perm()&0o010 == 0 {
		t.Errorf("the instance dir is not group-searchable: %v", info.Mode())
	}
	// A paused start (warm pools), then running, a memory snapshot, a stop.
	for _, state := range []string{StatePaused, StateRunning} {
		if err := l.SetState(ctx, "inst_h", state); err != nil {
			t.Fatal(err)
		}
		if got := virt.domains["inst_h"].state; got != map[string]string{StatePaused: "paused", StateRunning: "running"}[state] {
			t.Fatalf("%s: domain is %s", state, got)
		}
	}
	if _, err := l.Snapshot(ctx, "inst_h", true, "EPYC", &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if virt.domains["inst_h"].state != "running" {
		t.Fatalf("after the memory snapshot: %s", virt.domains["inst_h"].state)
	}
	console, err := l.Console(ctx, "inst_h")
	if err != nil {
		t.Fatal(err)
	}
	console.Close()
	if err := l.SetState(ctx, "inst_h", StateStopped); err != nil {
		t.Fatal(err)
	}
	if err := l.Destroy(ctx, "inst_h"); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"define", "start inst_h", "resume inst_h", "save inst_h", "restore inst_h", "console inst_h", "undefine inst_h"} {
		if !slices.Contains(helper.ops, want) {
			t.Errorf("the helper was not asked to %s: %v", want, helper.ops)
		}
	}
	for _, c := range virt.calls {
		if strings.HasPrefix(c, "virsh ") && !strings.HasPrefix(c, "virsh -r ") {
			t.Errorf("the node wrote through qemu:///system: %s", c)
		}
	}
}
