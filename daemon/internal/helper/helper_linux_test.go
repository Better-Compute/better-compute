package helper

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type fakeOps struct {
	mu    sync.Mutex
	calls []string
}

func (f *fakeOps) record(s string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, s)
	return nil
}
func (f *fakeOps) Reboot(reason string) error                 { return f.record("reboot " + reason) }
func (f *fakeOps) ResetGPU(_ context.Context, u string) error { return f.record("reset " + u) }
func (f *fakeOps) ApplyFirewall(context.Context, string) error {
	return f.record("firewall")
}
func (f *fakeOps) CheckFirewall(context.Context, int) error { return f.record("check") }
func (f *fakeOps) ReloadSSH() error                         { return f.record("ssh") }

func serve(t *testing.T, allowed func(Peer) error) (Client, *fakeOps, string) {
	t.Helper()
	root := t.TempDir()
	sock := filepath.Join(t.TempDir(), "helper.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	ops := &fakeOps{}
	srv := &Server{Ops: ops, Root: root, Allowed: allowed, KnownGPU: func(u string) bool { return u == "GPU-11111111-2222" }}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = srv.Serve(ctx, ln) }()
	return Client{Socket: sock}, ops, root
}

func me(p Peer) error {
	if p.UID != uint32(os.Getuid()) || p.PID <= 0 {
		return errors.New("not me")
	}
	return nil
}

func TestHelperFiles(t *testing.T) {
	c, _, root := serve(t, me)
	ctx := context.Background()
	if err := c.WriteFile(ctx, "/etc/cdi/bcd-alloc_1.json", []byte(`{"cdiVersion":"0.6.0"}`)); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(root, "etc/cdi/bcd-alloc_1.json"))
	if err != nil || string(b) != `{"cdiVersion":"0.6.0"}` {
		t.Fatalf("cdi = %q, %v", b, err)
	}
	for _, p := range []string{"/run/bcd/allocations/alloc_1.env", "/etc/ssh/sshd_config.d/10-better-compute.conf", "/etc/ssh/bc_ca.pub", "/etc/ssh/bc_krl", "/etc/ssh/bc_principals/root"} {
		if err := c.WriteFile(ctx, p, []byte("x")); err != nil {
			t.Fatalf("%s: %v", p, err)
		}
	}
	if err := c.RemoveFile(ctx, "/etc/ssh/bc_principals/root"); err != nil {
		t.Fatal(err)
	}
	if err := c.RemoveFile(ctx, "/etc/ssh/bc_principals/root"); err != nil {
		t.Fatalf("removing an absent file: %v", err)
	}
	// Paths outside the table never classify; a crafted kind or name is refused by the helper.
	for _, p := range []string{"/etc/shadow", "/etc/cdi/other.json", "/etc/cdi/bcd-../x.json", "/etc/ssh/bc_principals/../../passwd"} {
		if err := c.WriteFile(ctx, p, []byte("x")); err == nil {
			t.Errorf("%s was written", p)
		}
	}
	for _, req := range []Request{
		{Op: "file.write", Kind: "passwd", Name: "x"},
		{Op: "file.write", Kind: "cdi", Name: "../../etc/shadow"},
		{Op: "file.write", Kind: "ssh-ca", Name: "extra"},
		{Op: "file.write", Kind: "cdi", Name: "big", Data: make([]byte, MaxFile+1)},
	} {
		if err := c.Do(ctx, req); err == nil {
			t.Errorf("%s %s/%s was accepted", req.Op, req.Kind, req.Name)
		}
	}
	// A symlinked directory on the way down is refused, never followed.
	if err := os.RemoveAll(filepath.Join(root, "etc/ssh/bc_principals")); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "etc/ssh/bc_principals")); err != nil {
		t.Fatal(err)
	}
	if err := c.WriteFile(ctx, "/etc/ssh/bc_principals/root", []byte("x")); err == nil || !strings.Contains(err.Error(), "not a plain directory") {
		t.Fatalf("through a symlinked directory: %v", err)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatal("a file was written through the symlink")
	}
}

func TestHelperOperations(t *testing.T) {
	c, ops, _ := serve(t, me)
	ctx := context.Background()
	ruleset := "table bridge bcd_instances\ndelete table bridge bcd_instances\ntable bridge bcd_instances {\n\tchain forward {\n\t\ttype filter hook forward priority filter; policy accept;\n\t\tiifname \"bc*\" udp sport { 67, 547 } drop\n\t}\n}\n"
	for _, req := range []Request{
		{Op: "reboot", Reason: strings.Repeat("r", 500)},
		{Op: "gpu.reset", GPU: "GPU-11111111-2222"},
		{Op: "firewall.apply", Ruleset: ruleset},
		{Op: "firewall.check", Rules: 3},
		{Op: "ssh.reload"},
	} {
		if err := c.Do(ctx, req); err != nil {
			t.Fatalf("%s: %v", req.Op, err)
		}
	}
	if len(ops.calls) != 5 || len(ops.calls[0]) != len("reboot ")+200 {
		t.Fatalf("calls = %v", ops.calls)
	}
	for name, req := range map[string]Request{
		"unknown gpu":   {Op: "gpu.reset", GPU: "GPU-99999999-0000"},
		"not a gpu":     {Op: "gpu.reset", GPU: "0000:18:00.0; reboot"},
		"other table":   {Op: "firewall.apply", Ruleset: "table inet filter {\n}\n"},
		"other family":  {Op: "firewall.apply", Ruleset: "table ip bcd_taps {\n}\n"},
		"flush ruleset": {Op: "firewall.apply", Ruleset: "flush ruleset\n"},
		"include":       {Op: "firewall.apply", Ruleset: "include \"/etc/x\"\n"},
		"rule outside":  {Op: "firewall.apply", Ruleset: "add rule inet filter input drop\n"},
		"nested table":  {Op: "firewall.apply", Ruleset: "table bridge bcd_instances {\ntable inet filter {\n}\n}\n"},
		"unbalanced":    {Op: "firewall.apply", Ruleset: "table bridge bcd_instances {\n"},
		"unknown op":    {Op: "exec"},
	} {
		if err := c.Do(ctx, req); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if len(ops.calls) != 5 {
		t.Fatalf("a refused request reached the host: %v", ops.calls)
	}
}

func TestHelperStrictProtocol(t *testing.T) {
	c, ops, _ := serve(t, me)
	raw := func(body string) Response {
		t.Helper()
		conn, err := net.Dial("unix", c.Socket)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		_, _ = conn.Write([]byte(body + "\n"))
		var resp Response
		_ = json.NewDecoder(conn).Decode(&resp)
		return resp
	}
	if r := raw(`{"v":2,"op":"ssh.reload"}`); r.OK || !strings.Contains(r.Error, "protocol version") {
		t.Fatalf("another version: %+v", r)
	}
	if r := raw(`{"v":1,"op":"ssh.reload","path":"/etc/shadow"}`); r.OK {
		t.Fatalf("an unknown field: %+v", r)
	}
	if r := raw(`{"v":1,"op":"ssh.reload"}`); !r.OK || r.V != Version {
		t.Fatalf("a good request: %+v", r)
	}
	if len(ops.calls) != 1 {
		t.Fatalf("calls = %v", ops.calls)
	}
	// A peer the policy refuses gets nothing.
	c2, ops2, _ := serve(t, func(Peer) error { return errors.New("not the node") })
	if err := c2.Do(context.Background(), Request{Op: "reboot"}); err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("refused peer: %v", err)
	}
	if len(ops2.calls) != 0 {
		t.Fatal("a refused peer reached the host")
	}
}

func TestClassify(t *testing.T) {
	for abs, want := range map[string][2]string{
		"/etc/cdi/bcd-alloc_1.json":                     {"cdi", "alloc_1"},
		"/run/bcd/allocations/alloc_1.env":              {"allocation-env", "alloc_1"},
		"/etc/ssh/sshd_config.d/10-better-compute.conf": {"ssh-dropin", ""},
		"/etc/ssh/bc_principals/ubuntu":                 {"ssh-principals", "ubuntu"},
	} {
		kind, name, ok := Classify(abs)
		if !ok || kind != want[0] || name != want[1] {
			t.Errorf("Classify(%s) = %s %s %v", abs, kind, name, ok)
		}
	}
}
