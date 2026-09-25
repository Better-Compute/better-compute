package agent

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	bcruntime "github.com/better-compute/better-compute/daemon/internal/runtime"
)

type ticketIssuer struct {
	key *ecdsa.PrivateKey
	kid string
}

func newTicketIssuer(t *testing.T) *ticketIssuer {
	key, err := pki.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	return &ticketIssuer{key: key, kid: "k1"}
}

func (i *ticketIssuer) jwks(t *testing.T) string {
	jwk, err := pki.PublicJWK(&i.key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(map[string]any{"keys": []map[string]string{{"kty": "EC", "crv": "P-256", "x": jwk.X, "y": jwk.Y, "kid": i.kid, "alg": "ES256"}}})
	return string(b)
}

func (i *ticketIssuer) issue(t *testing.T, claims map[string]any) string {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	input := enc(map[string]string{"alg": "ES256", "typ": pki.ExecTicketType, "kid": i.kid}) + "." + enc(claims)
	sig, err := pki.SignP1363(i.key, []byte(input))
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}

type fakeTunnel struct {
	ctx  context.Context
	in   chan *agentv1.TunnelFrame
	out  chan *agentv1.TunnelFrame
	done chan struct{}
}

func (f *fakeTunnel) Send(fr *agentv1.TunnelFrame) error {
	select {
	case f.out <- fr:
		return nil
	case <-f.ctx.Done():
		return f.ctx.Err()
	}
}

func (f *fakeTunnel) Receive() (*agentv1.TunnelFrame, error) {
	select {
	case fr := <-f.in:
		return fr, nil
	case <-f.ctx.Done():
		return nil, io.EOF
	}
}

func (f *fakeTunnel) CloseRequest() error  { return nil }
func (f *fakeTunnel) CloseResponse() error { return nil }

func TestTunnelConsoleOverAPTY(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("pseudo-terminals need Linux")
	}
	issuer := newTicketIssuer(t)
	tunnels := make(chan *fakeTunnel, 4)
	h := newHarness(t, func(o *Options) {
		o.DialTunnel = func(ctx context.Context) (TunnelStream, error) {
			ft := &fakeTunnel{ctx: ctx, in: make(chan *agentv1.TunnelFrame, 16), out: make(chan *agentv1.TunnelFrame, 256)}
			tunnels <- ft
			return ft, nil
		}
	})
	s, _ := h.open()
	s.push(desired(1, &agentv1.NodeSpec{Access: &agentv1.AccessSection{ExecTicketJwksJson: issuer.jwks(t)}}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil })

	now := time.Now().Unix()
	claims := map[string]any{"iss": "test", "aud": "node:" + testNode, "sub": "user_1", "sid": "tun_1", "op": "console", "jti": "jti_1", "iat": now, "exp": now + 60}
	ticket := issuer.issue(t, claims)
	open := func(id, ticket string) {
		s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_OpenTunnel{OpenTunnel: &agentv1.OpenTunnel{TunnelId: id, Ticket: ticket}}})
	}
	open("tun_1", ticket)
	var ft *fakeTunnel
	select {
	case ft = <-tunnels:
	case <-time.After(5 * time.Second):
		t.Fatal("no tunnel was opened")
	}
	if first := <-ft.out; first.GetOpened() == nil || first.GetTunnelId() != "tun_1" {
		t.Fatalf("first frame = %v", first)
	}
	ft.in <- &agentv1.TunnelFrame{TunnelId: "tun_1", Body: &agentv1.TunnelFrame_Resize{Resize: &agentv1.TerminalSize{Rows: 40, Cols: 100}}}
	ft.in <- &agentv1.TunnelFrame{TunnelId: "tun_1", Body: &agentv1.TunnelFrame_Data{Data: []byte("echo hi-$((6*7)); stty size; exit 3\n")}}
	var output strings.Builder
	deadline := time.After(10 * time.Second)
	for {
		select {
		case fr := <-ft.out:
			if d := fr.GetData(); d != nil {
				output.Write(d)
				continue
			}
			if c := fr.GetClosed(); c != nil {
				if c.GetExitCode() != 3 || !strings.Contains(output.String(), "hi-42") || !strings.Contains(output.String(), "40 100") {
					t.Fatalf("closed %v after output %q", c, output.String())
				}
				goto replay
			}
		case <-deadline:
			t.Fatalf("the shell did not exit; output %q", output.String())
		}
	}
replay:
	// The same ticket again, and a ticket for another tunnel id: nothing opens.
	open("tun_1", ticket)
	claims["jti"], claims["sid"] = "jti_2", "tun_other"
	open("tun_2", issuer.issue(t, claims))
	select {
	case <-tunnels:
		t.Fatal("a replayed or mismatched ticket opened a tunnel")
	case <-time.After(500 * time.Millisecond):
	}
	// The jti is journaled: a restart does not forget it.
	if fresh, _ := h.j.RememberTicket("jti_1", time.Now().Add(time.Minute), time.Now()); fresh {
		t.Fatal("the ticket's jti was not journaled")
	}
}

func TestInstanceTicketsDialTheInstanceOnly(t *testing.T) {
	var fake *bcruntime.Fake
	h := newHarness(t, func(o *Options) {
		fake = &bcruntime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}
		o.Runtimes = []bcruntime.Runtime{fake}
	})
	s, hello := h.open()
	caps := strings.Join(hello.GetCapabilities(), ",")
	if !strings.Contains(caps, InstanceDialCapability) {
		t.Fatalf("capabilities = %s", caps)
	}
	web := vm("inst_web", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	web.Nics[0].Addresses = []string{"10.77.0.5/24"}
	lo := vm("inst_lo", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	lo.Nics[0].Addresses = []string{"127.0.0.1/8"}
	off := vm("inst_off", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_STOPPED)
	s.push(desired(1, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web, lo, off}}}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return len(f.GetStatus().GetInstances()) == 3 })

	// The dial goes to the instance's own address and port; the test answers it with an echo.
	var dialed []string
	prev := dialTCP
	defer func() { dialTCP = prev }()
	dialTCP = func(addr string) (net.Conn, error) {
		dialed = append(dialed, addr)
		server, client := net.Pipe()
		go func() { _, _ = io.Copy(server, server) }()
		return client, nil
	}
	tio := TunnelIO{Write: func(uint32, []byte) {}, Exit: func(int32, string) {}}
	ctx := context.Background()
	if _, err := h.agent.instanceTunnelProgram(ctx, pki.ExecTicketClaims{Op: "ssh", Inst: "inst_web"}, tio); err != nil {
		t.Fatal(err)
	}
	if _, err := h.agent.instanceTunnelProgram(ctx, pki.ExecTicketClaims{Op: "tcp", Inst: "inst_web", Port: 8443}, tio); err != nil {
		t.Fatal(err)
	}
	if strings.Join(dialed, ",") != "10.77.0.5:22,10.77.0.5:8443" {
		t.Fatalf("dialed %v", dialed)
	}
	for name, claims := range map[string]pki.ExecTicketClaims{
		"loopback address": {Op: "ssh", Inst: "inst_lo"},
		"stopped":          {Op: "ssh", Inst: "inst_off"},
		"elsewhere":        {Op: "ssh", Inst: "inst_elsewhere"},
		"exec":             {Op: "exec", Inst: "inst_web"},
		"stopped console":  {Op: "console", Inst: "inst_off"},
		"tcp without port": {Op: "tcp", Inst: "inst_web"},
	} {
		if _, err := h.agent.instanceTunnelProgram(ctx, claims, tio); err == nil {
			t.Errorf("%s: allowed", name)
		}
	}
	if len(dialed) != 2 {
		t.Fatalf("a refused ticket dialed: %v", dialed)
	}

	// console is the instance's serial console, from its runtime (no address, no host shell).
	got := make(chan string, 4)
	console, err := h.agent.instanceTunnelProgram(ctx, pki.ExecTicketClaims{Op: "console", Inst: "inst_web"},
		TunnelIO{Write: func(_ uint32, p []byte) { got <- string(p) }, Exit: func(int32, string) {}})
	if err != nil {
		t.Fatal(err)
	}
	console.Data([]byte("hello\n"), 0)
	select {
	case line := <-got:
		if line != "console: hello\n" {
			t.Fatalf("console answered %q", line)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the console did not answer")
	}
	console.Hangup()
}
