package transport

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // RFC 6455's Sec-WebSocket-Accept is defined over SHA-1
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/proto"
)

// The WebSocket fallback (PLAN.md §7.1, v0.4) for networks whose TLS-inspecting proxy strips client
// certificates. The Session's frames travel as the same length-prefixed messages inside WebSocket
// binary messages (subprotocol bc.agent.v1). Each side proves itself in band, so a proxy can relay
// frames but not impersonate either side:
//   - bcd sends a proof JWT (typ bc-agent-proof+jwt, ES256 by the node key, x5c = its chain, sub, aud,
//     iat/exp, a single-use jti and the connection nonce);
//   - the gateway answers the upgrade with x-bc-gateway-proof, a JWS over that nonce whose x5c chain
//     must reach the pinned serving CA (for server auth).
// @better-compute/gateway ws-client.ts (connectGatewayWs) is the reference client.

// WSSubprotocol is the WebSocket subprotocol of the agent session.
const WSSubprotocol = "bc.agent.v1"

// maxWSMessage bounds one WebSocket message and one length-prefixed frame.
const maxWSMessage = 16 << 20

// WSOptions configure a WebSocket session dial.
type WSOptions struct {
	// URL is the gateway's WS endpoint, wss://host[:port][/v1/session].
	URL string
	// ServingCAPin is the SPKI SHA-256 of the gateway serving CA: the gateway proof must chain to it.
	ServingCAPin []byte
	// ProxyRoots, when set, are trusted for the TLS connection only (a TLS-inspecting proxy's CA);
	// the connection is otherwise verified like the gRPC one (the pinned serving CA).
	ProxyRoots *x509.CertPool
	// NodeID, Key and Chain (DER, leaf first) are the node's identity for the proof.
	NodeID string
	Key    *ecdsa.PrivateKey
	Chain  [][]byte
	// Audience is the gateway's public host the proof names (default: the URL's host name).
	Audience string
	// ServerName is the TLS name the endpoint's certificate must carry when the URL names an address
	// (gateway_server_name; default: the URL's host).
	ServerName string
	// Proxy returns the HTTP proxy for the request (default http.ProxyFromEnvironment).
	Proxy func(*http.Request) (*url.URL, error)
	// DialTimeout bounds the TCP, proxy and TLS setup (default 10 s).
	DialTimeout time.Duration
	// Now is the clock of the proofs (default time.Now).
	Now func() time.Time
}

// WSStream is an agent Session over the WebSocket fallback. Send and Receive may run concurrently.
type WSStream struct {
	conn      net.Conn
	br        *bufio.Reader
	wmu       sync.Mutex
	pending   []byte
	closeOnce sync.Once
	// GatewayID is the gateway the verified gateway proof names.
	GatewayID string
}

// WSRejected is an upgrade the gateway refused, with its reason and pushback.
type WSRejected struct {
	Status     int
	Reason     string
	RetryAfter time.Duration
}

func (e *WSRejected) Error() string {
	return fmt.Sprintf("transport: the gateway refused the WebSocket session (HTTP %d): %s", e.Status, e.Reason)
}

// wsConn connects to the WS endpoint's host: through an HTTP CONNECT proxy when the environment
// names one, then TLS verified against the pinned serving CA or the configured proxy CA (transport
// only: the in-band proofs authenticate the gateway).
func wsConn(ctx context.Context, o *WSOptions) (net.Conn, *url.URL, error) {
	u, err := url.Parse(o.URL)
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "wss" && u.Scheme != "ws") {
		return nil, nil, fmt.Errorf("transport: bad WebSocket URL %q", o.URL)
	}
	if len(o.ServingCAPin) == 0 || o.Key == nil || len(o.Chain) == 0 || o.NodeID == "" {
		return nil, nil, errors.New("transport: a WebSocket session needs the serving CA pin and the node identity")
	}
	if o.DialTimeout == 0 {
		o.DialTimeout = 10 * time.Second
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Proxy == nil {
		o.Proxy = http.ProxyFromEnvironment
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = map[string]string{"wss": "443", "ws": "80"}[u.Scheme]
	}
	conn, err := dialThroughProxy(ctx, *o, u, net.JoinHostPort(host, port))
	if err != nil {
		return nil, nil, err
	}
	if o.ServerName != "" {
		host = o.ServerName
	}
	if u.Scheme == "wss" {
		tlsConn := tls.Client(conn, &tls.Config{
			MinVersion:         tls.VersionTLS12,
			ServerName:         host,
			NextProtos:         []string{"http/1.1"},
			InsecureSkipVerify: true, //nolint:gosec // replaced by VerifyConnection
			VerifyConnection: func(cs tls.ConnectionState) error {
				if verifyPinned(cs.PeerCertificates, host, o.ServingCAPin, time.Now()) == nil {
					return nil
				}
				if o.ProxyRoots == nil || len(cs.PeerCertificates) == 0 {
					return errors.New("transport: the WebSocket endpoint's certificate is neither the pinned gateway's nor the configured proxy's")
				}
				inter := x509.NewCertPool()
				for _, c := range cs.PeerCertificates[1:] {
					inter.AddCert(c)
				}
				_, err := cs.PeerCertificates[0].Verify(x509.VerifyOptions{DNSName: host, Roots: o.ProxyRoots, Intermediates: inter})
				return err
			},
		})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, nil, fmt.Errorf("transport: TLS to the WebSocket endpoint: %w", err)
		}
		conn = tlsConn
	}
	return conn, u, nil
}

// DialSession opens the Session over the WebSocket fallback; ctx bounds the setup and, once
// connected, ends the stream when it is done.
func DialSession(ctx context.Context, o WSOptions) (*WSStream, error) {
	if o.DialTimeout == 0 {
		o.DialTimeout = 10 * time.Second
	}
	setup, cancel := context.WithTimeout(ctx, o.DialTimeout)
	defer cancel()
	conn, u, err := wsConn(setup, &o)
	if err != nil {
		return nil, err
	}
	path := u.EscapedPath()
	if path == "" || path == "/" {
		path = "/v1/session"
	}
	audience := o.Audience
	if audience == "" {
		audience = u.Hostname()
	}
	s, err := upgrade(setup, conn, o, u.Host, path, audience)
	if err != nil {
		conn.Close()
		return nil, err
	}
	go func() {
		<-ctx.Done()
		s.Close()
	}()
	return s, nil
}

// maxRenewBody bounds a RenewResponse (a certificate chain).
const maxRenewBody = 1 << 20

// RenewOverWS renews the node certificate in WS mode: POST <ws origin>/v1/renew with the
// RenewRequest bytes (it authenticates itself: the chain and a renew-pop by the current key), over
// the same transport as the session, since a proxy that strips client certificates breaks the
// gRPC Renew.
func RenewOverWS(ctx context.Context, o WSOptions, req *agentv1.RenewRequest) (*agentv1.RenewResponse, error) {
	if o.DialTimeout == 0 {
		o.DialTimeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, 3*o.DialTimeout)
	defer cancel()
	conn, u, err := wsConn(ctx, &o)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	body, err := proto.Marshal(req)
	if err != nil {
		return nil, err
	}
	head := "POST /v1/renew HTTP/1.1\r\nHost: " + u.Host + "\r\nContent-Type: application/x-protobuf\r\n" +
		"Content-Length: " + strconv.Itoa(len(body)) + "\r\nConnection: close\r\nUser-Agent: bcd\r\n\r\n"
	if _, err := conn.Write(append([]byte(head), body...)); err != nil {
		return nil, err
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodPost})
	if err != nil {
		return nil, fmt.Errorf("transport: renew over WS: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxRenewBody+1))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		reason, _ := url.QueryUnescape(resp.Header.Get("X-Bc-Reason"))
		if reason == "" {
			reason = resp.Status
		}
		rejected := &WSRejected{Status: resp.StatusCode, Reason: reason}
		if ms, err := strconv.Atoi(resp.Header.Get("Grpc-Retry-Pushback-Ms")); err == nil && ms >= 0 {
			rejected.RetryAfter = time.Duration(ms) * time.Millisecond
		} else if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && s >= 0 {
			rejected.RetryAfter = time.Duration(s) * time.Second
		}
		return nil, rejected
	}
	if len(data) > maxRenewBody {
		return nil, errors.New("transport: renew answer too large")
	}
	out := &agentv1.RenewResponse{}
	if err := proto.Unmarshal(data, out); err != nil {
		return nil, fmt.Errorf("transport: renew answer: %w", err)
	}
	return out, nil
}

// dialThroughProxy connects to addr, through an HTTP CONNECT proxy when the environment names one.
func dialThroughProxy(ctx context.Context, o WSOptions, u *url.URL, addr string) (net.Conn, error) {
	d := &net.Dialer{Timeout: o.DialTimeout, KeepAlive: 30 * time.Second}
	target := &url.URL{Scheme: map[string]string{"wss": "https", "ws": "http"}[u.Scheme], Host: u.Host}
	proxyURL, err := o.Proxy(&http.Request{URL: target})
	if err != nil || proxyURL == nil {
		return d.DialContext(ctx, "tcp", addr)
	}
	proxyAddr := proxyURL.Host
	if proxyURL.Port() == "" {
		proxyAddr = net.JoinHostPort(proxyURL.Hostname(), "80")
	}
	conn, err := d.DialContext(ctx, "tcp", proxyAddr)
	if err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	req := "CONNECT " + addr + " HTTP/1.1\r\nHost: " + addr + "\r\n"
	if user := proxyURL.User; user != nil {
		pass, _ := user.Password()
		req += "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(user.Username()+":"+pass)) + "\r\n"
	}
	if _, err := io.WriteString(conn, req+"\r\n"); err != nil {
		conn.Close()
		return nil, err
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodConnect})
	if err != nil || resp.StatusCode != http.StatusOK {
		conn.Close()
		if err == nil {
			err = fmt.Errorf("proxy CONNECT: %s", resp.Status)
		}
		return nil, fmt.Errorf("transport: %w", err)
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func randomB64(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b64url(b)
}

// AgentProof is the proof JWT bcd sends with the upgrade (exported for tests and the gateway's
// interop check).
func AgentProof(key *ecdsa.PrivateKey, chain [][]byte, nodeID, audience, nonce string, now time.Time) (string, error) {
	x5c := make([]string, len(chain))
	for i, der := range chain {
		x5c[i] = base64.StdEncoding.EncodeToString(der)
	}
	header, _ := json.Marshal(map[string]any{"alg": "ES256", "typ": "bc-agent-proof+jwt", "x5c": x5c})
	iat := now.Unix()
	claims, _ := json.Marshal(map[string]any{"sub": nodeID, "aud": audience, "iat": iat, "exp": iat + 60, "jti": randomB64(16), "nonce": nonce})
	input := b64url(header) + "." + b64url(claims)
	sig, err := pki.SignP1363(key, []byte(input))
	if err != nil {
		return "", err
	}
	return input + "." + b64url(sig), nil
}

// VerifyGatewayProof checks x-bc-gateway-proof: typ bc-gateway-proof+jwt, an x5c chain reaching the
// pinned serving CA for server auth, a signature by its leaf, aud this node, this connection's
// nonce, iat within 60 s. It returns the gateway id (iss).
func VerifyGatewayProof(token string, pin []byte, nodeID, nonce string, now time.Time) (string, error) {
	deny := func(why string) error { return errors.New("transport: gateway proof rejected: " + why) }
	if len(token) == 0 || len(token) > 16384 {
		return "", deny("malformed")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", deny("malformed")
	}
	var header struct {
		Alg string   `json:"alg"`
		Typ string   `json:"typ"`
		X5c []string `json:"x5c"`
	}
	var claims struct {
		Iss   *string  `json:"iss"`
		Aud   string   `json:"aud"`
		Nonce string   `json:"nonce"`
		Iat   *float64 `json:"iat"`
	}
	hb, err1 := base64.RawURLEncoding.DecodeString(parts[0])
	cb, err2 := base64.RawURLEncoding.DecodeString(parts[1])
	sig, err3 := base64.RawURLEncoding.DecodeString(parts[2])
	if err1 != nil || err2 != nil || err3 != nil || json.Unmarshal(hb, &header) != nil || json.Unmarshal(cb, &claims) != nil {
		return "", deny("malformed")
	}
	if header.Alg != "ES256" || header.Typ != "bc-gateway-proof+jwt" || len(header.X5c) == 0 || len(header.X5c) > 4 {
		return "", deny("wrong alg, typ or x5c")
	}
	var chain []*x509.Certificate
	for _, c := range header.X5c {
		der, err := base64.StdEncoding.DecodeString(c)
		if err != nil {
			return "", deny("x5c")
		}
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			return "", deny("x5c")
		}
		chain = append(chain, cert)
	}
	if err := verifyPinned(chain, "", pin, now); err != nil {
		return "", deny("serving chain not trusted")
	}
	leaf, ok := chain[0].PublicKey.(*ecdsa.PublicKey)
	if !ok || !pki.VerifyP1363(leaf, []byte(parts[0]+"."+parts[1]), sig) {
		return "", deny("bad signature")
	}
	if claims.Aud != nodeID || claims.Nonce != nonce {
		return "", deny("not for this connection")
	}
	if claims.Iat == nil || now.Sub(time.Unix(int64(*claims.Iat), 0)).Abs() > 60*time.Second {
		return "", deny("stale")
	}
	if claims.Iss == nil {
		return "", deny("iss required")
	}
	return *claims.Iss, nil
}

// upgrade sends the WebSocket upgrade with the proof and checks the gateway's answer.
func upgrade(ctx context.Context, conn net.Conn, o WSOptions, hostHeader, path, audience string) (*WSStream, error) {
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	nonce := randomB64(32)
	proof, err := AgentProof(o.Key, o.Chain, o.NodeID, audience, nonce, o.Now())
	if err != nil {
		return nil, err
	}
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	key := base64.StdEncoding.EncodeToString(raw)
	req := "GET " + path + " HTTP/1.1\r\nHost: " + hostHeader + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: " + WSSubprotocol + "\r\n" +
		"X-Bc-Nonce: " + nonce + "\r\nX-Bc-Proof: " + proof + "\r\nUser-Agent: bcd\r\n\r\n"
	if _, err := io.WriteString(conn, req); err != nil {
		return nil, err
	}
	br := bufio.NewReaderSize(conn, 64<<10)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		return nil, fmt.Errorf("transport: WebSocket upgrade: %w", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		reason, _ := url.QueryUnescape(resp.Header.Get("X-Bc-Reason"))
		if reason == "" {
			reason = resp.Status
		}
		rejected := &WSRejected{Status: resp.StatusCode, Reason: reason}
		if ms, err := strconv.Atoi(resp.Header.Get("Grpc-Retry-Pushback-Ms")); err == nil && ms >= 0 {
			rejected.RetryAfter = time.Duration(ms) * time.Millisecond
		} else if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && s >= 0 {
			rejected.RetryAfter = time.Duration(s) * time.Second
		}
		return nil, rejected
	}
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")) //nolint:gosec // RFC 6455
	if resp.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
		return nil, errors.New("transport: WebSocket upgrade: bad Sec-WebSocket-Accept")
	}
	if resp.Header.Get("Sec-WebSocket-Protocol") != WSSubprotocol {
		return nil, errors.New("transport: the gateway did not select " + WSSubprotocol)
	}
	gatewayID, err := VerifyGatewayProof(resp.Header.Get("X-Bc-Gateway-Proof"), o.ServingCAPin, o.NodeID, nonce, o.Now())
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return &WSStream{conn: conn, br: br, GatewayID: gatewayID}, nil
}

// Send writes one AgentFrame as a length-prefixed message in one binary WebSocket message.
func (s *WSStream) Send(f *agentv1.AgentFrame) error {
	b, err := proto.Marshal(f)
	if err != nil {
		return err
	}
	msg := make([]byte, 5, 5+len(b))
	binary.BigEndian.PutUint32(msg[1:], uint32(len(b)))
	return s.writeFrame(0x2, append(msg, b...))
}

// Receive returns the next ServerFrame; the length-prefixed messages may span WebSocket messages.
func (s *WSStream) Receive() (*agentv1.ServerFrame, error) {
	for {
		if len(s.pending) >= 5 {
			if s.pending[0] != 0 {
				return nil, errors.New("transport: compressed frames are not supported")
			}
			n := int(binary.BigEndian.Uint32(s.pending[1:5]))
			if n > maxWSMessage {
				return nil, errors.New("transport: frame too large")
			}
			if len(s.pending) >= 5+n {
				f := &agentv1.ServerFrame{}
				err := proto.Unmarshal(s.pending[5:5+n], f)
				s.pending = s.pending[5+n:]
				if err != nil {
					return nil, fmt.Errorf("transport: undecodable frame: %w", err)
				}
				return f, nil
			}
		}
		msg, err := s.readMessage()
		if err != nil {
			return nil, err
		}
		s.pending = append(s.pending, msg...)
	}
}

// readMessage reads one data message, answering pings and the close handshake.
func (s *WSStream) readMessage() ([]byte, error) {
	var msg []byte
	for {
		fin, opcode, payload, err := s.readFrame()
		if err != nil {
			return nil, err
		}
		switch opcode {
		case 0x8: // close
			_ = s.writeFrame(0x8, payload[:min(len(payload), 2)])
			s.Close()
			return nil, io.EOF
		case 0x9: // ping
			if err := s.writeFrame(0xA, payload); err != nil {
				return nil, err
			}
			continue
		case 0xA: // pong
			continue
		case 0x0, 0x1, 0x2:
			msg = append(msg, payload...)
			if len(msg) > maxWSMessage {
				return nil, errors.New("transport: WebSocket message too large")
			}
			if fin {
				return msg, nil
			}
		default:
			return nil, fmt.Errorf("transport: unknown WebSocket opcode %d", opcode)
		}
	}
}

func (s *WSStream) readFrame() (fin bool, opcode byte, payload []byte, err error) {
	var h [2]byte
	if _, err = io.ReadFull(s.br, h[:]); err != nil {
		return
	}
	fin, opcode = h[0]&0x80 != 0, h[0]&0x0f
	masked := h[1]&0x80 != 0
	n := uint64(h[1] & 0x7f)
	switch n {
	case 126:
		var b [2]byte
		if _, err = io.ReadFull(s.br, b[:]); err != nil {
			return
		}
		n = uint64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err = io.ReadFull(s.br, b[:]); err != nil {
			return
		}
		n = binary.BigEndian.Uint64(b[:])
	}
	if n > maxWSMessage {
		return false, 0, nil, errors.New("transport: WebSocket frame too large")
	}
	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(s.br, mask[:]); err != nil {
			return
		}
	}
	payload = make([]byte, n)
	if _, err = io.ReadFull(s.br, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return fin, opcode, payload, nil
}

// writeFrame writes one final frame, masked as a client must.
func (s *WSStream) writeFrame(opcode byte, payload []byte) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	head := []byte{0x80 | opcode}
	switch n := len(payload); {
	case n < 126:
		head = append(head, 0x80|byte(n))
	case n <= 0xffff:
		head = append(head, 0x80|126, byte(n>>8), byte(n))
	default:
		head = append(head, 0x80|127)
		head = binary.BigEndian.AppendUint64(head, uint64(n))
	}
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	head = append(head, mask[:]...)
	masked := make([]byte, len(payload))
	for i, b := range payload {
		masked[i] = b ^ mask[i%4]
	}
	_, err := s.conn.Write(append(head, masked...))
	return err
}

// Ping sends a WebSocket ping (keepalive through proxies).
func (s *WSStream) Ping() error { return s.writeFrame(0x9, nil) }

// Close ends the connection.
func (s *WSStream) Close() {
	s.closeOnce.Do(func() { _ = s.conn.Close() })
}

// CloseRequest and CloseResponse end the stream (the agent Stream interface).
func (s *WSStream) CloseRequest() error  { s.Close(); return nil }
func (s *WSStream) CloseResponse() error { s.Close(); return nil }
