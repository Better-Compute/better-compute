package agent

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/json"
	"io"
	"runtime"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/pki"
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
