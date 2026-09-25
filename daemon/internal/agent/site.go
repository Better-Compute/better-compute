package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	sitev1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/site/v1"
	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/redfish"
	"google.golang.org/protobuf/encoding/protojson"
)

// The site agent's kinds (`bcd site`, PLAN.md §3.5; packages/metal/src/commands.ts): BMC operations
// through the machine's Redfish service, one HTTP request on the control plane's behalf
// (site.httpProxy), and the boot entries the boot server answers PXE machines from.

// siteKinds are registered for role site.
func siteKinds(a *Agent) []*Kind {
	site := []dispatch.Role{dispatch.RoleSite}
	bmc := func(name string, destructive bool) *Kind {
		return &Kind{Name: name, Lane: dispatch.LaneControl, Roles: site, Destructive: destructive, Exec: a.runBMC}
	}
	return []*Kind{
		bmc("bmc.query", false),
		bmc("bmc.boot", false),
		bmc("bmc.power", true),
		bmc("bmc.rotate", false),
		bmc("bmc.firmware", true),
		bmc("bmc.storage", true),
		{Name: "site.httpProxy", Lane: dispatch.LaneControl, Roles: site, Exec: a.runHTTPProxy},
		{Name: "boot.prepareRamdisk", Lane: dispatch.LaneControl, Roles: site, Exec: a.runPrepareRamdisk},
		{Name: "boot.cleanUp", Lane: dispatch.LaneControl, Roles: site, Exec: a.runBootCleanUp},
	}
}

// ---- BMC ---------------------------------------------------------------------------------------

type bmcCredential struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// parseCredential reads a BMC credential secret: {username, password} JSON (as enrolled and as
// rotations store it, 6abfa79), or a bare password (a rotation of a credential that never had a
// username), paired with a fallback username; the fallback also fills a JSON without a username.
func parseCredential(raw []byte, username string) bmcCredential {
	var c bmcCredential
	if json.Unmarshal(raw, &c) == nil && c.Password != "" {
		if c.Username == "" {
			c.Username = username
		}
		return c
	}
	return bmcCredential{Username: username, Password: strings.TrimSpace(string(raw))}
}

func bmcResult(ok bool, result any, code, message string) (journal.Result, error) {
	r := &sitev1.BmcOperationResult{Ok: ok, ErrorCode: code, Message: message}
	if result != nil {
		b, err := json.Marshal(result)
		if err != nil {
			return journal.Result{}, err
		}
		r.ResultJson = string(b)
	}
	return succeeded(r)
}

// runBMC runs one BmcOperationRequest. A BMC that refuses or fails answers ok=false with a code
// (the command itself succeeds: the site agent did its part); bmc.rotate results are node-signed.
func (a *Agent) runBMC(ctx context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &sitev1.BmcOperationRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	if d := req.GetDriver(); d != "" && d != "redfish" {
		return bmcResult(false, nil, "unsupported-driver", "the site agent drives redfish BMCs; not "+d)
	}
	args := map[string]any{}
	if s := req.GetArgsJson(); s != "" {
		if err := json.Unmarshal([]byte(s), &args); err != nil {
			return journal.Result{}, invalidPayload(err)
		}
	}
	bind := pki.SecretBinding{WorkflowID: cmd.WorkflowID, StepID: cmd.StepID}
	raw, err := a.RequestSecret(ctx, req.GetCredentialsRef(), bind)
	if err != nil {
		return bmcResult(false, nil, "credentials-unavailable", err.Error())
	}
	username, _ := args["username"].(string)
	cred := parseCredential(raw, username)
	if req.GetOperation() == "management.rotateCredential" {
		ref, _ := args["newCredentialRef"].(string)
		next, err := a.RequestSecret(ctx, ref, bind)
		if err != nil {
			return bmcResult(false, nil, "credentials-unavailable", err.Error())
		}
		args["newPassword"] = parseCredential(next, cred.Username).Password
		delete(args, "newCredentialRef")
	}
	client, err := redfish.New(req.GetAddress(), cred.Username, cred.Password, req.GetTlsSpkiSha256())
	if err != nil {
		return bmcResult(false, nil, "invalid-address", err.Error())
	}
	result, err := client.Do(ctx, req.GetOperation(), args)
	if err != nil {
		var e *redfish.Error
		if errors.As(err, &e) {
			return bmcResult(false, nil, e.Code, e.Message)
		}
		return bmcResult(false, nil, "bmc-error", err.Error())
	}
	a.log.Info("bmc operation", "operation", req.GetOperation(), "bmc", req.GetAddress())
	return bmcResult(true, result, "", "")
}

// ---- site.httpProxy ----------------------------------------------------------------------------

// maxProxyBody is the response cap of site.httpProxy (1 MiB).
const maxProxyBody = 1 << 20

// siteAddress reports whether ip is an address a site-internal machine may have: private,
// shared or unique-local space; never loopback, link-local (metadata services), multicast,
// unspecified or public.
func siteAddress(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	if ip.IsPrivate() {
		return true
	}
	_, cgnat, _ := net.ParseCIDR("100.64.0.0/10")
	return cgnat.Contains(ip)
}

// runHTTPProxy makes one HTTP(S) request to a machine inside the site for an agentless profile
// (P5: the control plane never dials into a site). Whatever the command says, the agent enforces:
// the host resolves only to site-internal addresses (and the connection goes to the address that
// was checked), https unless the address is private, no redirects, the response capped at 1 MiB,
// the timeout, and the pinned SPKI when given. Anything else fails "forbidden-target".
//
// Gap: the address is not yet checked against target_node_id's own addresses (the site agent does
// not learn them yet); only site-internal space is enforced.
func (a *Agent) runHTTPProxy(ctx context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &sitev1.HttpProxyRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	forbidden := func(format string, args ...any) error {
		return &KindError{Code: "forbidden-target", Message: fmt.Sprintf(format, args...)}
	}
	u, err := url.Parse(req.GetUrl())
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
		return journal.Result{}, forbidden("url must be http(s) without credentials")
	}
	method := strings.ToUpper(req.GetMethod())
	if method == "" {
		method = http.MethodGet
	}
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete:
	default:
		return journal.Result{}, forbidden("method %s", method)
	}
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", u.Hostname())
	if err != nil || len(ips) == 0 {
		return journal.Result{}, &KindError{Code: "unreachable", Message: fmt.Sprintf("resolve %s: %v", u.Hostname(), err)}
	}
	for _, ip := range ips {
		if !siteAddress(ip) {
			return journal.Result{}, forbidden("%s resolves to %s, outside the site", u.Hostname(), ip)
		}
	}
	target := ips[0]
	port := u.Port()
	if port == "" {
		port = map[string]string{"https": "443", "http": "80"}[u.Scheme]
	}
	timeout := time.Duration(req.GetTimeoutMs()) * time.Millisecond
	if timeout <= 0 || timeout > time.Minute {
		timeout = 30 * time.Second
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: u.Hostname()}
	if pin := req.GetTlsSpkiSha256(); len(pin) > 0 {
		tlsConfig.InsecureSkipVerify = true //nolint:gosec // replaced by the SPKI pin (Talos has its own CA)
		tlsConfig.VerifyConnection = func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("no certificate")
			}
			sum := sha256.Sum256(cs.PeerCertificates[0].RawSubjectPublicKeyInfo)
			if !bytes.Equal(sum[:], pin) {
				return errors.New("the certificate does not match its pinned SPKI")
			}
			return nil
		}
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	client := &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:           nil,
			TLSClientConfig: tlsConfig,
			// Connect to the checked address, never a second resolution.
			DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, network, net.JoinHostPort(target.String(), port))
			},
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(req.GetBody()))
	if err != nil {
		return journal.Result{}, invalidPayload(err)
	}
	for _, h := range req.GetHeaders() {
		httpReq.Header.Set(h.GetName(), h.GetValue())
	}
	for _, h := range req.GetSecretHeaders() {
		v, err := a.RequestSecret(ctx, h.GetValue(), pki.SecretBinding{WorkflowID: cmd.WorkflowID, StepID: cmd.StepID})
		if err != nil {
			return journal.Result{}, &KindError{Code: "credentials-unavailable", Message: err.Error()}
		}
		httpReq.Header.Set(h.GetName(), string(v))
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return journal.Result{}, &KindError{Code: "unreachable", Message: err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxProxyBody+1))
	out := &sitev1.HttpProxyResponse{Status: uint32(resp.StatusCode)}
	if len(body) > maxProxyBody {
		body, out.Truncated = body[:maxProxyBody], true
	}
	out.Body = body
	names := make([]string, 0, len(resp.Header))
	for n := range resp.Header {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		out.Headers = append(out.Headers, &sitev1.HttpProxyHeader{Name: n, Value: resp.Header.Get(n)})
	}
	return succeeded(out)
}

// ---- boot entries ------------------------------------------------------------------------------

// BootEntries are the machines the site's boot server answers (boot.prepareRamdisk), by PXE MAC,
// kept in the data directory so a restart keeps answering; lapsed entries are dropped.
type BootEntries struct {
	path string
	mu   sync.Mutex
	// NodeOf remembers the node of each MAC's workflow for boot.cleanUp.
	entries map[string]*sitev1.ProxyDhcpEntry
}

func newBootEntries(dataDir string) *BootEntries {
	b := &BootEntries{path: filepath.Join(dataDir, "boot-entries.json"), entries: map[string]*sitev1.ProxyDhcpEntry{}}
	if raw, err := os.ReadFile(b.path); err == nil {
		var stored []json.RawMessage
		if json.Unmarshal(raw, &stored) == nil {
			for _, r := range stored {
				e := &sitev1.ProxyDhcpEntry{}
				if protojson.Unmarshal(r, e) == nil && e.GetMac() != "" {
					b.entries[strings.ToLower(e.GetMac())] = e
				}
			}
		}
	}
	return b
}

func (b *BootEntries) saveLocked() error {
	macs := make([]string, 0, len(b.entries))
	for m := range b.entries {
		macs = append(macs, m)
	}
	sort.Strings(macs)
	var out []json.RawMessage
	for _, m := range macs {
		raw, err := protojson.Marshal(b.entries[m])
		if err != nil {
			return err
		}
		out = append(out, raw)
	}
	data, err := json.Marshal(out)
	if err != nil {
		return err
	}
	return writeFile(b.path, data, 0o600)
}

// Put stores an entry.
func (b *BootEntries) Put(e *sitev1.ProxyDhcpEntry) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.entries[strings.ToLower(e.GetMac())] = e
	return b.saveLocked()
}

// Get returns the live entry for a MAC at now.
func (b *BootEntries) Get(mac string, now time.Time) *sitev1.ProxyDhcpEntry {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.entries[strings.ToLower(mac)]
	if e == nil || (e.GetNotAfter() != nil && !now.Before(e.GetNotAfter().AsTime())) {
		return nil
	}
	return e
}

// Remove drops the entries of a workflow, or the listed MACs; it returns how many it dropped.
func (b *BootEntries) Remove(macs []string, workflowID string) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	drop := map[string]bool{}
	for _, m := range macs {
		drop[strings.ToLower(m)] = true
	}
	n := 0
	for mac, e := range b.entries {
		if drop[mac] || (len(macs) == 0 && workflowID != "" && e.GetWorkflowId() == workflowID) {
			delete(b.entries, mac)
			n++
		}
	}
	return n, b.saveLocked()
}

// Sweep drops lapsed entries.
func (b *BootEntries) Sweep(now time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	changed := false
	for mac, e := range b.entries {
		if e.GetNotAfter() != nil && !now.Before(e.GetNotAfter().AsTime()) {
			delete(b.entries, mac)
			changed = true
		}
	}
	if changed {
		_ = b.saveLocked()
	}
}

func (a *Agent) runPrepareRamdisk(_ context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &sitev1.ProxyDhcpEntry{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	if _, err := net.ParseMAC(req.GetMac()); err != nil {
		return journal.Result{}, invalidPayload(fmt.Errorf("mac %q", req.GetMac()))
	}
	if err := a.boot.Put(req); err != nil {
		return journal.Result{}, err
	}
	a.log.Info("boot entry", "mac", req.GetMac(), "workflow", req.GetWorkflowId())
	return journal.Result{Outcome: journal.OutcomeSucceeded}, nil
}

func (a *Agent) runBootCleanUp(_ context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &sitev1.BootCleanUpRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	n, err := a.boot.Remove(req.GetMacs(), req.GetWorkflowId())
	if err != nil {
		return journal.Result{}, err
	}
	a.log.Info("boot entries removed", "count", n, "workflow", req.GetWorkflowId())
	return journal.Result{Outcome: journal.OutcomeSucceeded}, nil
}
