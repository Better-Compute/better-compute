// Package transport is bcd's gRPC client of the gateway's AgentGateway service (PLAN.md §7.1;
// proto/bettercompute/agent/v1/session.proto): plain gRPC framing over HTTP/2 with connect-go, which
// the Node gateway serves (packages/gateway/src/http2.ts).
//
// Production is TLS. The gateway serving CA is pinned by its SPKI (config serving_ca_spki_pin): the
// server's chain must include a certificate with that key, the leaf must chain to it and name the
// gateway host. Join is server-authenticated only; Renew, Session and Tunnel present the node
// certificate (mTLS). The node never trusts the system roots for the gateway.
//
// For local development against a dev stack, an http:// URL speaks cleartext HTTP/2 (h2c) and, with
// TestNodeHeader, names the node in x-bc-test-node; only a gateway started with insecureHeaderAuth
// honours it. It is refused for any https:// URL.
package transport

import (
	"context"
	"crypto/ecdsa"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1/agentv1connect"
	"github.com/better-compute/better-compute/daemon/internal/pki"
)

// TestNodeHeader names the node on a dev gateway's h2c listener (tests and `dev` only).
const TestNodeHeader = "x-bc-test-node"

// MaxMessageBytes bounds a message in either direction (the gateway's MAX_FRAME_BYTES is 4 MiB).
const MaxMessageBytes = 4 << 20

// Options configure a Client.
type Options struct {
	// URL is the gateway: https://host[:port], or http://host:port for a dev gateway's h2c listener.
	URL string
	// ServingCAPin is the SHA-256 of the gateway serving CA's SPKI (https only; required there).
	ServingCAPin []byte
	// ServerName is the name the gateway certificate must carry (default: the URL host).
	ServerName string
	// ClientCertificate is the node certificate (mTLS); nil for Join.
	ClientCertificate *tls.Certificate
	// TestNode names the node in x-bc-test-node (http:// only).
	TestNode string
	// DialTimeout bounds connection setup (default 10 s).
	DialTimeout time.Duration
	// PingInterval and PingTimeout are HTTP/2 keepalives (default 20 s each, PLAN.md §7.5).
	PingInterval time.Duration
	PingTimeout  time.Duration
	// UserAgent is sent on every call (default "bcd").
	UserAgent string
}

// Client calls the gateway.
type Client struct {
	gateway agentv1connect.AgentGatewayClient
	http    *http.Client
	opts    Options
}

// New builds a client. It does not dial until the first call.
func New(opts Options) (*Client, error) {
	u, err := url.Parse(opts.URL)
	if err != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") {
		return nil, fmt.Errorf("transport: bad gateway URL %q", opts.URL)
	}
	if opts.DialTimeout == 0 {
		opts.DialTimeout = 10 * time.Second
	}
	if opts.PingInterval == 0 {
		opts.PingInterval = 20 * time.Second
	}
	if opts.PingTimeout == 0 {
		opts.PingTimeout = 20 * time.Second
	}
	if opts.UserAgent == "" {
		opts.UserAgent = "bcd"
	}
	dialer := &net.Dialer{Timeout: opts.DialTimeout, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		DialContext:         dialer.DialContext,
		TLSHandshakeTimeout: opts.DialTimeout,
		MaxIdleConns:        2,
		IdleConnTimeout:     90 * time.Second,
		HTTP2: &http.HTTP2Config{
			SendPingTimeout:  opts.PingInterval,
			PingTimeout:      opts.PingTimeout,
			MaxReadFrameSize: 1 << 20,
		},
		Protocols: new(http.Protocols),
	}
	switch u.Scheme {
	case "https":
		if len(opts.ServingCAPin) == 0 {
			return nil, errors.New("transport: an https gateway needs the serving CA pin")
		}
		if opts.TestNode != "" {
			return nil, errors.New("transport: the test node header is for dev h2c gateways only")
		}
		transport.Protocols.SetHTTP2(true)
		name := opts.ServerName
		if name == "" {
			name = u.Hostname()
		}
		transport.TLSClientConfig = tlsConfig(name, opts)
	case "http":
		transport.Protocols.SetUnencryptedHTTP2(true)
	default:
		return nil, fmt.Errorf("transport: bad gateway URL scheme %q", u.Scheme)
	}
	httpClient := &http.Client{Transport: transport}
	base := u.Scheme + "://" + u.Host
	return &Client{
		gateway: agentv1connect.NewAgentGatewayClient(httpClient, base,
			connect.WithGRPC(),
			connect.WithReadMaxBytes(MaxMessageBytes),
			connect.WithSendMaxBytes(MaxMessageBytes),
		),
		http: httpClient,
		opts: opts,
	}, nil
}

// tlsConfig pins the serving CA: the system roots are never consulted.
func tlsConfig(host string, opts Options) *tls.Config {
	cfg := &tls.Config{
		MinVersion: tls.VersionTLS13,
		ServerName: host,
		NextProtos: []string{"h2"},
		// Verification is VerifyConnection's: the chain must reach the pinned serving CA.
		InsecureSkipVerify: true, //nolint:gosec // replaced by the pinned check below
		VerifyConnection: func(cs tls.ConnectionState) error {
			return verifyPinned(cs.PeerCertificates, host, opts.ServingCAPin, time.Now())
		},
	}
	if opts.ClientCertificate != nil {
		cert := *opts.ClientCertificate
		cfg.GetClientCertificate = func(*tls.CertificateRequestInfo) (*tls.Certificate, error) { return &cert, nil }
	}
	return cfg
}

// verifyPinned checks that the peer chain contains a certificate whose SPKI matches pin, and that the
// leaf chains to it for server auth and names host.
func verifyPinned(peer []*x509.Certificate, host string, pin []byte, now time.Time) error {
	if len(peer) == 0 {
		return errors.New("transport: the gateway sent no certificate")
	}
	roots := x509.NewCertPool()
	anchored := false
	for _, c := range peer {
		if ecKey, ok := c.PublicKey.(*ecdsa.PublicKey); ok && pki.MatchesPin(ecKey, pin) {
			roots.AddCert(c)
			anchored = true
		}
	}
	if !anchored {
		return errors.New("transport: the gateway chain does not include the pinned serving CA")
	}
	inter := x509.NewCertPool()
	for _, c := range peer[1:] {
		inter.AddCert(c)
	}
	_, err := peer[0].Verify(x509.VerifyOptions{
		DNSName:       host,
		Roots:         roots,
		Intermediates: inter,
		CurrentTime:   now,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	})
	if err != nil {
		return fmt.Errorf("transport: gateway certificate: %w", err)
	}
	return nil
}

// Join calls AgentGateway.Join.
func (c *Client) Join(ctx context.Context, req *agentv1.JoinRequest) (*agentv1.JoinResponse, error) {
	r := connect.NewRequest(req)
	c.decorate(r.Header())
	resp, err := c.gateway.Join(ctx, r)
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// Renew calls AgentGateway.Renew (mTLS with the current certificate).
func (c *Client) Renew(ctx context.Context, req *agentv1.RenewRequest) (*agentv1.RenewResponse, error) {
	r := connect.NewRequest(req)
	c.decorate(r.Header())
	resp, err := c.gateway.Renew(ctx, r)
	if err != nil {
		return nil, err
	}
	return resp.Msg, nil
}

// Session opens the bidi Session stream. Cancel ctx to tear it down.
func (c *Client) Session(ctx context.Context) *connect.BidiStreamForClient[agentv1.AgentFrame, agentv1.ServerFrame] {
	stream := c.gateway.Session(ctx)
	c.decorate(stream.RequestHeader())
	return stream
}

// Tunnel opens a Tunnel stream (v0.3).
func (c *Client) Tunnel(ctx context.Context) *connect.BidiStreamForClient[agentv1.TunnelFrame, agentv1.TunnelFrame] {
	stream := c.gateway.Tunnel(ctx)
	c.decorate(stream.RequestHeader())
	return stream
}

// Close drops idle connections.
func (c *Client) Close() {
	c.http.CloseIdleConnections()
}

func (c *Client) decorate(h http.Header) {
	h.Set("User-Agent", c.opts.UserAgent)
	if c.opts.TestNode != "" {
		h.Set(TestNodeHeader, c.opts.TestNode)
	}
}

// PushbackHeader is the gRPC retry pushback a gateway sets on a refusal (RESOURCE_EXHAUSTED):
// milliseconds to wait before retrying, jittered and scaled to the herd it is refusing.
const PushbackHeader = "grpc-retry-pushback-ms"

// maxPushback bounds how long a pushback may keep a daemon away.
const maxPushback = 15 * time.Minute

// Pushback returns the wait a failed call's gRPC retry pushback asks for. A negative value means
// "do not retry" in gRPC; bcd always retries, so it is ignored like a missing one.
func Pushback(err error) (time.Duration, bool) {
	var ce *connect.Error
	if !errors.As(err, &ce) {
		return 0, false
	}
	raw := strings.TrimSpace(ce.Meta().Get(PushbackHeader))
	ms, perr := strconv.ParseInt(raw, 10, 64)
	if raw == "" || perr != nil || ms < 0 {
		return 0, false
	}
	return min(time.Duration(ms)*time.Millisecond, maxPushback), true
}

// Retryable reports whether a call failed in a way the daemon retries with jittered backoff:
// RESOURCE_EXHAUSTED (handshake bucket), UNAVAILABLE (gateway busy or unreachable), a deadline, or a
// transport failure without a gRPC status.
func Retryable(err error) bool {
	if err == nil {
		return false
	}
	switch connect.CodeOf(err) {
	case connect.CodeResourceExhausted, connect.CodeUnavailable, connect.CodeDeadlineExceeded, connect.CodeUnknown, connect.CodeAborted:
		return true
	}
	return false
}
