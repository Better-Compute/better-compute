// Package aws is bcd on an Amazon EC2 instance (virtual or *.metal) as a host (AWS program A6): the
// IMDSv2 client, the cloud-iid join evidence, the instance's "cloud" inventory section and the spot
// interruption notice.
//
// Nothing here talks to the network before the DMI says the machine is EC2 (sys_vendor
// "Amazon EC2", which every Nitro instance and every *.metal reports): bcd on any other host never
// probes 169.254.169.254. The endpoint is fixed; Client.Endpoint is a Go option for tests, never
// configuration or an environment variable, so no config text points the daemon elsewhere.
package aws

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// DefaultEndpoint is the instance metadata service.
const DefaultEndpoint = "http://169.254.169.254"

// TokenTTLSeconds is the IMDSv2 session token lifetime bcd asks for (the maximum, 6 h).
const TokenTTLSeconds = 21600

// IMDSv2 header names.
const (
	tokenHeader    = "X-aws-ec2-metadata-token"
	tokenTTLHeader = "X-aws-ec2-metadata-token-ttl-seconds"
)

// Instance identity paths (cloud-iid.ts: `document` is the exact JSON, `signature` the base64).
const (
	documentPath  = "/latest/dynamic/instance-identity/document"
	signaturePath = "/latest/dynamic/instance-identity/signature"
)

// maxAnswer caps one metadata answer (the attestor takes at most 64 KiB of evidence).
const maxAnswer = 32 << 10

// EC2SysVendor is /sys/class/dmi/id/sys_vendor on an EC2 instance.
const EC2SysVendor = "Amazon EC2"

// ErrNotEC2 is returned, before any network call, on a host whose DMI is not EC2's.
var ErrNotEC2 = errors.New("aws: this host is not an EC2 instance (DMI sys_vendor is not \"Amazon EC2\")")

// ErrNotFound is a metadata path the instance does not have (404), e.g. no spot notice.
var ErrNotFound = errors.New("aws: metadata path not found")

// OnEC2 reports whether the DMI under root names EC2. It reads only the local file.
func OnEC2(root string) bool {
	if root == "" {
		root = "/"
	}
	raw, err := os.ReadFile(filepath.Join(root, "sys", "class", "dmi", "id", "sys_vendor"))
	return err == nil && strings.TrimSpace(string(raw)) == EC2SysVendor
}

// Client is an IMDSv2 client. The zero value works on an EC2 host.
type Client struct {
	// Root is the host filesystem root the DMI is read under ("" is "/").
	Root string
	// Endpoint is the metadata service base URL (tests only; default DefaultEndpoint).
	Endpoint string
	// Timeout bounds each request (default 1 s).
	Timeout time.Duration
	// HTTP replaces the client (tests); the default uses no proxy and follows no redirect.
	HTTP *http.Client
	// Now defaults to time.Now.
	Now func() time.Time
	// Log takes what the client reports on its own (a spot notice that does not parse); default
	// slog.Default().
	Log *slog.Logger

	mu        sync.Mutex
	detected  int // 0 unknown, 1 EC2, -1 not
	token     string
	tokenTill time.Time
	client    *http.Client
}

func (c *Client) timeout() time.Duration {
	if c.Timeout > 0 {
		return c.Timeout
	}
	return time.Second
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Client) endpoint() string {
	if c.Endpoint != "" {
		return strings.TrimRight(c.Endpoint, "/")
	}
	return DefaultEndpoint
}

// httpClient never uses a proxy (HTTP_PROXY must not see the metadata service, nor the token) and
// never follows a redirect.
func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	if c.client == nil {
		c.client = &http.Client{
			Transport: &http.Transport{
				Proxy:                 nil,
				DialContext:           (&net.Dialer{Timeout: c.timeout()}).DialContext,
				ResponseHeaderTimeout: c.timeout(),
				MaxIdleConns:          2,
				IdleConnTimeout:       30 * time.Second,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
	}
	return c.client
}

// ec2 detects EC2 once (DMI only).
func (c *Client) ec2Locked() bool {
	if c.detected == 0 {
		c.detected = -1
		if OnEC2(c.Root) {
			c.detected = 1
		}
	}
	return c.detected == 1
}

// statusError is a non-200 answer; it never carries the token or the body.
type statusError struct {
	method, path string
	status       int
}

func (e *statusError) Error() string {
	return fmt.Sprintf("aws: metadata %s %s: HTTP %d", e.method, e.path, e.status)
}

func (e *statusError) Is(target error) bool {
	return target == ErrNotFound && e.status == http.StatusNotFound
}

// do sends one request with the per-request timeout and reads at most maxAnswer bytes.
func (c *Client) do(ctx context.Context, method, path string, header http.Header) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint()+path, nil)
	if err != nil {
		return nil, fmt.Errorf("aws: metadata %s: %w", path, err)
	}
	for k, v := range header {
		req.Header[k] = v
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		// The URL is the fixed endpoint plus a fixed path; the token is a header and never in it.
		return nil, fmt.Errorf("aws: metadata %s %s: %w", method, path, unwrapURL(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxAnswer))
		return nil, &statusError{method: method, path: path, status: resp.StatusCode}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxAnswer+1))
	if err != nil {
		return nil, fmt.Errorf("aws: metadata %s %s: %w", method, path, err)
	}
	if len(body) > maxAnswer {
		return nil, fmt.Errorf("aws: metadata %s %s: answer over %d bytes", method, path, maxAnswer)
	}
	return body, nil
}

// unwrapURL drops *url.Error's wrapping so a message names the path once.
func unwrapURL(err error) error {
	var ue interface{ Unwrap() error }
	if errors.As(err, &ue) {
		if inner := ue.Unwrap(); inner != nil {
			return inner
		}
	}
	return err
}

// tokenLocked returns a session token, fetching one when none is held or it is within a minute of
// expiry.
func (c *Client) tokenLocked(ctx context.Context) (string, error) {
	if c.token != "" && c.now().Before(c.tokenTill) {
		return c.token, nil
	}
	issued := c.now()
	body, err := c.do(ctx, http.MethodPut, "/latest/api/token", http.Header{tokenTTLHeader: {strconv.Itoa(TokenTTLSeconds)}})
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(body))
	if token == "" || strings.ContainsAny(token, "\r\n") {
		return "", errors.New("aws: metadata token: malformed answer")
	}
	c.token = token
	c.tokenTill = issued.Add(TokenTTLSeconds*time.Second - time.Minute)
	return token, nil
}

// Get reads one metadata path ("/latest/…") with an IMDSv2 session token. A 401 (the token expired
// or the instance restarted) fetches a new token and retries once. Off EC2 it returns ErrNotEC2
// without a network call; a missing path is ErrNotFound.
func (c *Client) Get(ctx context.Context, path string) ([]byte, error) {
	if !strings.HasPrefix(path, "/latest/") || strings.Contains(path, "..") || strings.ContainsAny(path, "?#\\ \t\r\n") {
		return nil, fmt.Errorf("aws: metadata path %q is not a /latest/ path", path)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.ec2Locked() {
		return nil, ErrNotEC2
	}
	for attempt := 0; ; attempt++ {
		token, err := c.tokenLocked(ctx)
		if err != nil {
			return nil, err
		}
		body, err := c.do(ctx, http.MethodGet, path, http.Header{tokenHeader: {token}})
		var se *statusError
		if attempt == 0 && errors.As(err, &se) && se.status == http.StatusUnauthorized {
			c.token = ""
			continue
		}
		return body, err
	}
}

// IdentityDocument returns the instance identity document exactly as served (the signature covers
// those bytes) and its base64 RSA-SHA256 signature without whitespace.
func (c *Client) IdentityDocument(ctx context.Context) (document []byte, signature string, err error) {
	document, err = c.Get(ctx, documentPath)
	if err != nil {
		return nil, "", err
	}
	if !utf8.Valid(document) {
		return nil, "", errors.New("aws: the instance identity document is not UTF-8")
	}
	var id struct {
		AccountID  string `json:"accountId"`
		InstanceID string `json:"instanceId"`
		Region     string `json:"region"`
	}
	if err := json.Unmarshal(document, &id); err != nil || id.AccountID == "" || id.InstanceID == "" || id.Region == "" {
		return nil, "", errors.New("aws: the instance identity document names no account, instance or region")
	}
	raw, err := c.Get(ctx, signaturePath)
	if err != nil {
		return nil, "", err
	}
	signature = strings.Join(strings.Fields(string(raw)), "")
	if sig, err := base64.StdEncoding.DecodeString(signature); err != nil || len(sig) == 0 {
		return nil, "", errors.New("aws: the instance identity signature is not base64")
	}
	return document, signature, nil
}

// Evidence is the cloud-iid JoinRequest.attestation (packages/pki cloud-iid.ts):
// {"provider":"aws","document":<document>,"signature":<signature>}.
func (c *Client) Evidence(ctx context.Context) ([]byte, error) {
	document, signature, err := c.IdentityDocument(ctx)
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(struct {
		Provider  string `json:"provider"`
		Document  string `json:"document"`
		Signature string `json:"signature"`
	}{"aws", string(document), signature}); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}
