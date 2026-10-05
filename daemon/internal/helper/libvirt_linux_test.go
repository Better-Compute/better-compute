package helper

import (
	"context"
	"errors"
	"net"
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
	if err := op("start", LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab", Paused: true}); err != nil || fake.calls[len(fake.calls)-1] != "start inst_01k5w0000000000000000000ab --paused" {
		t.Fatalf("paused start: %v %q", err, fake.calls[len(fake.calls)-1])
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
	// The balloon: live, in KiB, on bcd's own domains only.
	if err := op("setmem", LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab", Bytes: 3 << 30}); err != nil || fake.calls[len(fake.calls)-1] != "setmem inst_01k5w0000000000000000000ab 3145728 --live" {
		t.Fatalf("setmem: %v %q", err, fake.calls[len(fake.calls)-1])
	}
	if err := op("setmem", LibvirtRequest{Domain: "legacy-vm", Bytes: 1 << 30}); err == nil {
		t.Fatal("a foreign domain's balloon was resized")
	}
	if err := op("setmem", LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab"}); err == nil {
		t.Fatal("setmem without a size")
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
	// restore: the definition must be given, checked, and name the same domain. Without one, virsh
	// would start the definition the node-written state file embeds.
	calls := len(fake.calls)
	if err := op("restore", LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab", File: filepath.Join(state, "memory.state")}); err == nil || !strings.Contains(err.Error(), "needs the domain's definition") {
		t.Fatalf("a restore without a definition: %v", err)
	}
	for _, c := range fake.calls[calls:] {
		if strings.HasPrefix(c, "restore") {
			t.Fatalf("virsh restore ran for a refused restore: %v", fake.calls[calls:])
		}
	}
	if err := op("restore", LibvirtRequest{Domain: "inst_01k5w0000000000000000000zz", File: filepath.Join(state, "memory.state"), XML: []byte(goodDomain)}); err == nil {
		t.Fatal("a restore under another domain's definition was taken")
	}
	if err := op("restore", LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab", File: filepath.Join(state, "memory.state"), XML: []byte(goodDomain)}); err != nil {
		t.Fatal(err)
	}
}

// The console's pty travels as a descriptor over the helper socket, for bcd's domains only.
func TestHelperConsoleHandsTheDescriptor(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "helper.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	r, w, err := os.Pipe() // stands in for the pty
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	var opened []string
	srv := &Server{
		Ops: &fakeOps{}, Root: t.TempDir(), Allowed: me,
		Virsh: func(_ context.Context, args ...string) ([]byte, error) {
			if args[1] == "inst_01k5w0000000000000000000ab" {
				return []byte(`<domain><metadata><bc:instance xmlns:bc="https://better-compute.dev/libvirt/1" id="inst_01k5w0000000000000000000ab"/></metadata><devices><console type="pty" tty="/dev/pts/7"><source path="/dev/pts/7"/></console></devices></domain>`), nil
			}
			return []byte(`<domain><devices><console type="pty"><source path="/dev/pts/3"/></console></devices></domain>`), nil
		},
		OpenConsole: func(path string) (*os.File, error) { opened = append(opened, path); return r, nil },
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = srv.Serve(ctx, ln) }()
	c := Client{Socket: sock}

	f, err := c.Console(ctx, "inst_01k5w0000000000000000000ab")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := w.Write([]byte("login: ")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 16)
	n, err := f.Read(buf)
	if err != nil || string(buf[:n]) != "login: " || len(opened) != 1 || opened[0] != "/dev/pts/7" {
		t.Fatalf("read %q %v, opened %v", buf[:n], err, opened)
	}
	if _, err := c.Console(ctx, "legacy-vm"); err == nil {
		t.Fatal("a name that is no instance id got a console")
	}
	if _, err := c.Console(ctx, "inst_01k5w0000000000000000000zz"); err == nil || !strings.Contains(err.Error(), "not bcd's") {
		t.Fatalf("a foreign domain's console: %v", err)
	}
}

// do2 runs a libvirt verb as the socket would (tests call it directly).
func (s *Server) do2(ctx context.Context, verb string, req *LibvirtRequest) error {
	return s.libvirt(ctx, verb, req)
}

// libvirt's managed hostdevs unbind a domain's GPUs from nvidia: persistence goes off for exactly
// those before start, and on again after destroy; a foreign or unknown domain toggles nothing.
func TestHelperLibvirtGPUPersistence(t *testing.T) {
	s, _, _ := libvirtServer(t)
	inner := s.Virsh
	s.Virsh = func(ctx context.Context, args ...string) ([]byte, error) {
		if args[0] == "dumpxml" && args[1] == "inst_01k5w0000000000000000000ab" {
			return []byte(`<domain><metadata><bc:instance xmlns:bc="https://better-compute.dev/libvirt/1" id="inst_01k5w0000000000000000000ab"/></metadata>` +
				`<devices><hostdev mode="subsystem" type="pci" managed="yes"><source><address domain="0x0000" bus="0x3b" slot="0x00" function="0x0"/></source></hostdev></devices></domain>`), nil
		}
		return inner(ctx, args...)
	}
	var calls []string
	s.GPUPersistence = func(addr string, on bool) error {
		calls = append(calls, addr+map[bool]string{true: "=on", false: "=off"}[on])
		return nil
	}
	ctx := context.Background()
	for _, verb := range []string{"start", "destroy"} {
		if err := s.do2(ctx, verb, &LibvirtRequest{Domain: "inst_01k5w0000000000000000000ab"}); err != nil {
			t.Fatal(err)
		}
	}
	_ = s.do2(ctx, "start", &LibvirtRequest{Domain: "legacy-vm"})
	if got := strings.Join(calls, " "); got != "0000:3b:00.0=off 0000:3b:00.0=on" {
		t.Fatalf("persistence: %s", got)
	}
}