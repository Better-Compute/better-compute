package helper

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeLibvirt answers virsh for one bcd domain and one foreign one.
type fakeLibvirt struct {
	calls   []string
	defined map[string]string
}

func (f *fakeLibvirt) virsh(_ context.Context, args ...string) ([]byte, error) {
	f.calls = append(f.calls, strings.Join(args, " "))
	switch args[0] {
	case "list":
		return []byte("inst_01k5w0000000000000000000ab\nlegacy-vm\n"), nil
	case "dumpxml":
		if args[1] == "inst_01k5w0000000000000000000ab" {
			return []byte(`<domain><metadata><bc:instance xmlns:bc="https://better-compute.dev/libvirt/1" id="inst_01k5w0000000000000000000ab"/></metadata></domain>`), nil
		}
		if args[1] == "legacy-vm" {
			return []byte(`<domain><name>legacy-vm</name></domain>`), nil
		}
		return nil, errors.New("error: failed to get domain")
	case "define":
		raw, _ := os.ReadFile(args[1])
		f.defined[args[1]] = string(raw)
	case "save":
		return nil, os.WriteFile(args[2], []byte("memory"), 0o600)
	}
	return nil, nil
}

func libvirtServer(t *testing.T) (*Server, *fakeLibvirt, string) {
	t.Helper()
	fake := &fakeLibvirt{defined: map[string]string{}}
	state := t.TempDir()
	var checked []string
	policy := LibvirtPolicy{
		Domain:     domainPolicy(&checked),
		StateDirs:  []string{state},
		CheckState: func(string) error { return nil },
		NodeUID:    os.Getuid(),
		NodeGID:    os.Getgid(),
		Staging:    filepath.Join(t.TempDir(), "staging"),
	}
	return &Server{Virsh: fake.virsh, LibvirtPolicy: func() (LibvirtPolicy, error) { return policy, nil }}, fake, state
}

func TestHelperLibvirt(t *testing.T) {
	s, fake, state := libvirtServer(t)
	ctx := context.Background()
	op := func(verb string, req LibvirtRequest) error { return s.do2(ctx, verb, &req) }

	// define: checked, then virsh reads it from root's staging directory.
	if err := op("define", LibvirtRequest{XML: []byte(goodDomain)}); err != nil {
		t.Fatal(err)
	}
	if len(fake.defined) != 1 {
		t.Fatalf("defined %v", fake.defined)
	}
	for file := range fake.defined {
		if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("the staged definition was left behind")
		}
	}
	if err := op("define", LibvirtRequest{XML: []byte(strings.Replace(goodDomain, "bcnet0", "br0", 1))}); err == nil {
		t.Fatal("an unchecked definition was defined")
	}
	// Lifecycle only on bcd's own domains.
	if err := op("start", LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab"}); err != nil {
		t.Fatal(err)
	}
	if err := op("destroy", LibvirtRequest{Domain: "legacy-vm"}); err == nil {
		t.Fatal("a foreign domain was destroyed")
	}
	if err := op("undefine", LibvirtRequest{Domain: "inst_01k5w0000000000000000000zz"}); err == nil {
		t.Fatal("a domain that does not exist was undefined")
	}
	if err := op("blockresize", LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab", Target: "vda", Bytes: 10 << 30}); err != nil {
		t.Fatal(err)
	}
	if err := op("blockresize", LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab", Target: "sda", Bytes: 1}); err == nil {
		t.Fatal("a non-virtio target was resized")
	}
	if err := op("attach-disk", LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab", Target: "vdz", File: "/etc/shadow"}); err == nil {
		t.Fatal("a disk outside bcd's directories was attached")
	}
	if err := op("attach-disk", LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab", Target: "vdz", File: "/var/lib/bcd/libvirt/instances/inst_01k5w0000000000000000000ab/rebind.img"}); err != nil {
		t.Fatal(err)
	}
	if err := op("reboot", LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab"}); err == nil {
		t.Fatal("an unknown verb ran")
	}

	// save: written by root into its staging, handed to the node inside its state directory only.
	if err := op("save", LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab", File: filepath.Join(state, "memory.state")}); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(state, "memory.state")); err != nil || string(b) != "memory" {
		t.Fatalf("saved = %q %v", b, err)
	}
	outside := t.TempDir()
	_ = os.Symlink(outside, filepath.Join(state, "escape"))
	if err := op("save", LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab", File: filepath.Join(state, "escape", "memory.state")}); err == nil {
		t.Fatal("a save followed a symlink out of the state directory")
	}
	if _, err := os.Stat(filepath.Join(outside, "memory.state")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("root wrote through the symlink")
	}
	// restore: the definition must be checked and name the same domain.
	if err := op("restore", LibvirtRequest{Domain: "inst_01k5w0000000000000000000zz", File: filepath.Join(state, "memory.state"), XML: []byte(goodDomain)}); err == nil {
		t.Fatal("a restore under another domain's definition was taken")
	}
	if err := op("restore", LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab", File: filepath.Join(state, "memory.state"), XML: []byte(goodDomain)}); err != nil {
		t.Fatal(err)
	}
}

// do2 runs a libvirt verb as the socket would (tests call it directly).
func (s *Server) do2(ctx context.Context, verb string, req *LibvirtRequest) error {
	return s.libvirt(ctx, verb, req)
}
