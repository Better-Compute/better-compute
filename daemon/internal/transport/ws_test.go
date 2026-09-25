package transport

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // RFC 6455
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/proto"
)

type testCA struct {
	cert *x509.Certificate
	der  []byte
	key  *ecdsa.PrivateKey
}

func newTestCA(t *testing.T) testCA {
	t.Helper()
	key, _ := pki.GenerateKey()
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "serving ca"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return testCA{cert: cert, der: der, key: key}
}

func (ca testCA) issue(t *testing.T, usage x509.ExtKeyUsage, names ...string) (*ecdsa.PrivateKey, []byte) {
	t.Helper()
	key, _ := pki.GenerateKey()
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "leaf"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{usage}, DNSNames: names,
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return key, der
}

func compactJWS(t *testing.T, header, claims map[string]any, key *ecdsa.PrivateKey) string {
	t.Helper()
	h, _ := json.Marshal(header)
	c, _ := json.Marshal(claims)
	input := b64url(h) + "." + b64url(c)
	sig, _ := pki.SignP1363(key, []byte(input))
	return input + "." + b64url(sig)
}

// wsGateway is a minimal gateway side of the WS fallback: it checks the agent proof's shape and
// nonce, answers with a gateway proof, then serves frames from handle.
type wsGateway struct {
	t        *testing.T
	ca       testCA
	key      *ecdsa.PrivateKey
	chain    [][]byte
	refuse   bool
	badProof bool
	proofs   chan map[string]any
}

func (g *wsGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/v1/renew" {
		body, _ := io.ReadAll(r.Body)
		req := &agentv1.RenewRequest{}
		if r.Header.Get("Content-Type") != "application/x-protobuf" || proto.Unmarshal(body, req) != nil || len(req.GetCsr()) == 0 {
			http.Error(w, "bad renew", http.StatusBadRequest)
			return
		}
		out, _ := proto.Marshal(&agentv1.RenewResponse{CertChain: [][]byte{req.GetCsr()}})
		_, _ = w.Write(out)
		return
	}
	if g.refuse {
		w.Header().Set("x-bc-reason", "gateway%20busy")
		w.Header().Set("grpc-retry-pushback-ms", "1500")
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	proof := r.Header.Get("X-Bc-Proof")
	parts := strings.Split(proof, ".")
	var claims map[string]any
	if len(parts) == 3 {
		raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
		_ = json.Unmarshal(raw, &claims)
	}
	nonce := r.Header.Get("X-Bc-Nonce")
	if claims == nil || claims["nonce"] != nonce || r.Header.Get("Sec-WebSocket-Protocol") != WSSubprotocol {
		http.Error(w, "bad proof", http.StatusUnauthorized)
		return
	}
	g.proofs <- claims
	x5c := []string{}
	for _, der := range g.chain {
		x5c = append(x5c, base64.StdEncoding.EncodeToString(der))
	}
	aud := claims["sub"]
	if g.badProof {
		aud = "node_someone_else"
	}
	gp := compactJWS(g.t, map[string]any{"alg": "ES256", "typ": "bc-gateway-proof+jwt", "x5c": x5c},
		map[string]any{"iss": "gw-test-1", "aud": aud, "nonce": nonce, "iat": time.Now().Unix()}, g.key)
	sum := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")) //nolint:gosec
	conn, brw, err := w.(http.Hijacker).Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(sum[:]) + "\r\nSec-WebSocket-Protocol: " + WSSubprotocol +
		"\r\nX-Bc-Gateway-Proof: " + gp + "\r\n\r\n")
	_ = brw.Flush()
	// One client frame in: it must be masked and hold a length-prefixed Hello.
	msg := readClientFrame(g.t, brw.Reader)
	if msg == nil {
		return // the client refused the gateway proof and hung up
	}
	hello := &agentv1.AgentFrame{}
	if len(msg) < 5 || proto.Unmarshal(msg[5:], hello) != nil || hello.GetHello() == nil {
		g.t.Errorf("first frame is not a Hello: %x", msg)
		return
	}
	// A ping (answered with a pong), then a Welcome split across two binary messages.
	writeServerFrame(brw.Writer, 0x9, []byte("hi"))
	body, _ := proto.Marshal(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Welcome{Welcome: &agentv1.Welcome{SessionId: "s-ws"}}})
	framed := binary.BigEndian.AppendUint32([]byte{0}, uint32(len(body)))
	framed = append(framed, body...)
	writeServerFrame(brw.Writer, 0x2, framed[:3])
	writeServerFrame(brw.Writer, 0x2, framed[3:])
	_ = brw.Flush()
	if pong := readClientFrame(g.t, brw.Reader); string(pong) != "hi" {
		g.t.Errorf("pong = %q", pong)
	}
	writeServerFrame(brw.Writer, 0x8, []byte{0x03, 0xe8})
	_ = brw.Flush()
	time.Sleep(50 * time.Millisecond)
}

func readClientFrame(t *testing.T, r *bufio.Reader) []byte {
	var h [2]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return nil
	}
	if h[1]&0x80 == 0 {
		t.Error("a client frame was not masked")
	}
	n := int(h[1] & 0x7f)
	switch n {
	case 126:
		var b [2]byte
		_, _ = io.ReadFull(r, b[:])
		n = int(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		_, _ = io.ReadFull(r, b[:])
		n = int(binary.BigEndian.Uint64(b[:]))
	}
	var mask [4]byte
	_, _ = io.ReadFull(r, mask[:])
	payload := make([]byte, n)
	_, _ = io.ReadFull(r, payload)
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return payload
}

func writeServerFrame(w *bufio.Writer, opcode byte, payload []byte) {
	_ = w.WriteByte(0x80 | opcode)
	_ = w.WriteByte(byte(len(payload)))
	_, _ = w.Write(payload)
}

func newWSGateway(t *testing.T) (*wsGateway, *httptest.Server) {
	ca := newTestCA(t)
	key, leaf := ca.issue(t, x509.ExtKeyUsageServerAuth, "localhost")
	g := &wsGateway{t: t, ca: ca, key: key, chain: [][]byte{leaf, ca.der}, proofs: make(chan map[string]any, 4)}
	srv := httptest.NewUnstartedServer(g)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{leaf, ca.der}, PrivateKey: key}}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return g, srv
}

func wsOptions(t *testing.T, g *wsGateway, srv *httptest.Server) WSOptions {
	nodeCA := newTestCA(t)
	nodeKey, nodeLeaf := nodeCA.issue(t, x509.ExtKeyUsageClientAuth)
	return WSOptions{
		URL:          strings.Replace(srv.URL, "https://", "wss://", 1) + "/v1/session",
		ServingCAPin: mustPin(t, g.ca.cert),
		NodeID:       "node_ws_test",
		Key:          nodeKey,
		Chain:        [][]byte{nodeLeaf, nodeCA.der},
		Audience:     "gw.test",
		Proxy:        func(*http.Request) (*url.URL, error) { return nil, nil },
	}
}

func mustPin(t *testing.T, cert *x509.Certificate) []byte {
	pin, err := pki.SPKISHA256(cert.PublicKey.(*ecdsa.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	return pin
}

func TestWSSessionAgainstAGateway(t *testing.T) {
	g, srv := newWSGateway(t)
	o := wsOptions(t, g, srv)
	s, err := DialSession(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	claims := <-g.proofs
	if claims["sub"] != "node_ws_test" || claims["aud"] != "gw.test" || claims["jti"] == "" {
		t.Fatalf("proof claims = %v", claims)
	}
	if s.GatewayID != "gw-test-1" {
		t.Fatalf("gateway id = %q", s.GatewayID)
	}
	if err := s.Send(&agentv1.AgentFrame{Msg: &agentv1.AgentFrame_Hello{Hello: &agentv1.Hello{NodeId: "node_ws_test"}}}); err != nil {
		t.Fatal(err)
	}
	f, err := s.Receive()
	if err != nil || f.GetWelcome().GetSessionId() != "s-ws" {
		t.Fatalf("Receive = %v, %v", f, err)
	}
	if _, err := s.Receive(); !errors.Is(err, io.EOF) {
		t.Fatalf("after close: %v", err)
	}
}

func TestWSRefusesAnUnprovenGateway(t *testing.T) {
	g, srv := newWSGateway(t)
	o := wsOptions(t, g, srv)
	// A gateway proof for another node.
	g.badProof = true
	if _, err := DialSession(context.Background(), o); err == nil || !strings.Contains(err.Error(), "gateway proof rejected") {
		t.Fatalf("DialSession = %v", err)
	}
	// Pinned to another serving CA: the TLS and the proof both fail.
	g.badProof = false
	o.ServingCAPin = mustPin(t, newTestCA(t).cert)
	if _, err := DialSession(context.Background(), o); err == nil {
		t.Fatal("an unpinned gateway was accepted")
	}
	// A proxy CA carries the transport only: the gateway proof still has to reach the pinned CA.
	o.ProxyRoots = x509.NewCertPool()
	o.ProxyRoots.AddCert(g.ca.cert)
	if _, err := DialSession(context.Background(), o); err == nil || !strings.Contains(err.Error(), "serving chain not trusted") {
		t.Fatalf("with only the proxy CA: %v", err)
	}
	// A refusal carries its pushback.
	o.ServingCAPin, o.ProxyRoots = mustPin(t, g.ca.cert), nil
	g.refuse = true
	_, err := DialSession(context.Background(), o)
	if d, ok := Pushback(err); !ok || d != 1500*time.Millisecond {
		t.Fatalf("pushback = %v %v (%v)", d, ok, err)
	}
}

func TestRenewOverWS(t *testing.T) {
	g, srv := newWSGateway(t)
	o := wsOptions(t, g, srv)
	resp, err := RenewOverWS(context.Background(), o, &agentv1.RenewRequest{Csr: []byte("csr")})
	if err != nil || len(resp.GetCertChain()) != 1 || string(resp.GetCertChain()[0]) != "csr" {
		t.Fatalf("RenewOverWS = %v, %v", resp, err)
	}
	if _, err := RenewOverWS(context.Background(), o, &agentv1.RenewRequest{}); err == nil {
		t.Fatal("a refused renew succeeded")
	}
}
