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
	"path"
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
		bmc("bmc.boot", true), // the boot device and virtual media decide what a machine boots
		bmc("bmc.power", true),
		bmc("bmc.rotate", true), // replaces the BMC's credentials
		bmc("bmc.firmware", true),
		bmc("bmc.storage", true),
		// A request to a machine in the site can change it (a POST to its API): destructive, so signed
		// and under the quorum like the BMC kinds.
		{Name: "site.httpProxy", Lane: dispatch.LaneControl, Roles: site, Destructive: true, Exec: a.runHTTPProxy},
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

// bmcOperations are the operations each BMC kind may carry (packages/metal/src/commands.ts). The
// kind decides the command's lane, retry safety and whether it must be signed, so an operation
// never runs under a kind other than its own: an unsigned bmc.query cannot power a machine off or
// rebuild its RAID.
var bmcOperations = map[string]map[string]bool{
	"bmc.query":    {"power.getPower": true, "inspect.inspect": true, "firmware.components": true, "bios.getSettings": true, "raid.getLayout": true},
	"bmc.boot":     {"management.setBootDevice": true, "virtual-media.insert": true, "virtual-media.eject": true, "bios.applySettings": true},
	"bmc.power":    {"power.setPower": true},
	"bmc.rotate":   {"management.rotateCredential": true},
	"bmc.firmware": {"firmware.update": true},
	"bmc.storage":  {"raid.applyLayout": true, "raid.clear": true},
}

// runBMC runs one BmcOperationRequest. A BMC that refuses or fails answers ok=false with a code
// (the command itself succeeds: the site agent did its part); bmc.rotate results are node-signed.
func (a *Agent) runBMC(ctx context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &sitev1.BmcOperationRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	if !bmcOperations[cmd.Kind][req.GetOperation()] {
		return journal.Result{}, invalidPayload(fmt.Errorf("%s is not a %s operation", req.GetOperation(), cmd.Kind))
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
	if req.GetOperation() == "firmware.update" {
		// The BMC fetches the image itself and cannot check its digest: it gets the site cache's
		// copy, pulled and verified here first.
		cached, err := a.verifiedFirmware(ctx, str(args["url"]), str(args["sha256"]))
		if err != nil {
			return bmcResult(false, nil, "image-unverified", err.Error())
		}
		args["url"] = cached
	}
	a.rememberBMC(req.GetAddress())
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

// bmcHostsFile remembers the BMC hosts this site agent has driven (site.httpProxy refuses them).
const bmcHostsFile = "bmc-hosts.json"

// bmcHost is the host part of a BMC address ("10.0.0.5", "https://bmc:8443/redfish/v1/...").
func bmcHost(address string) string {
	if !strings.Contains(address, "://") {
		address = "https://" + address
	}
	if u, err := url.Parse(address); err == nil {
		return strings.ToLower(u.Hostname())
	}
	return ""
}

// rememberBMC records a BMC host, durably.
func (a *Agent) rememberBMC(address string) {
	host := bmcHost(address)
	if host == "" {
		return
	}
	a.bmcMu.Lock()
	defer a.bmcMu.Unlock()
	hosts := a.bmcHostsLocked()
	if hosts[host] {
		return
	}
	hosts[host] = true
	raw, _ := json.Marshal(hosts)
	if err := pki.WriteFileAtomic(filepath.Join(a.o.DataDir, bmcHostsFile), raw, 0o600); err != nil {
		a.log.Error("remember a BMC host", "error", err.Error())
	}
}

func (a *Agent) bmcHostsLocked() map[string]bool {
	hosts := map[string]bool{}
	if raw, err := os.ReadFile(filepath.Join(a.o.DataDir, bmcHostsFile)); err == nil {
		_ = json.Unmarshal(raw, &hosts)
	}
	return hosts
}

// knownBMC reports whether a host (name or address) is a BMC this agent has driven.
func (a *Agent) knownBMC(host string) bool {
	a.bmcMu.Lock()
	defer a.bmcMu.Unlock()
	return a.bmcHostsLocked()[strings.ToLower(host)]
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// verifiedFirmware pulls a firmware image into the site cache (its sha256 verified) and returns the
// cache URL the boot server serves it at. Without a boot server there is no cache to serve from,
// and the update is refused rather than handing the BMC an unverified source.
func (a *Agent) verifiedFirmware(ctx context.Context, url, digest string) (string, error) {
	a.mu.Lock()
	base := a.bootURL
	a.mu.Unlock()
	if base == "" {
		return "", errors.New("firmware updates go through the site image cache; this agent serves none ([boot] url)")
	}
	if !digestPath.MatchString(digest) {
		return "", errors.New("firmware.update needs the image's sha256 (hex)")
	}
	if !a.cache.has(digest) {
		if err := a.cache.pull(ctx, a.imageClient(), url, digest); err != nil {
			return "", err
		}
		a.cache.saveMeta(digest, cacheMeta{Ref: "firmware", LastUsed: time.Now()})
	}
	return strings.TrimRight(base, "/") + "/cache/" + digest, nil
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
// A BMC is never a proxy target: the BMC hosts this agent has driven (bmc.* commands, remembered)
// and any /redfish path are refused, so a BMC is reached only through the bmc.* kinds and their
// quorum.
//
// The URL's host must also be one of target_node_id's own addresses (SiteSpec.proxy_targets): an IP
// literal compares as an IP; a name matches a listed name, or else every address it resolves to must
// be listed. A spec that lists no targets allows none.
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
	if strings.HasPrefix(strings.ToLower(path.Clean("/"+u.Path)), "/redfish") {
		return journal.Result{}, forbidden("a BMC API (/redfish) is reached through the bmc.* kinds only")
	}
	if a.knownBMC(u.Hostname()) {
		return journal.Result{}, forbidden("%s is a BMC: it is reached through the bmc.* kinds only", u.Hostname())
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
		if a.knownBMC(ip.String()) {
			return journal.Result{}, forbidden("%s resolves to %s, a BMC", u.Hostname(), ip)
		}
	}
	a.mu.Lock()
	targets := a.spec.GetSite().GetProxyTargets()
	a.mu.Unlock()
	if err := proxyTargetAllowed(targets, req.GetTargetNodeId(), u.Hostname(), ips); err != nil {
		return journal.Result{}, forbidden("%v", err)
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

// proxyTargetAllowed checks host (resolved to ips) against target_node_id's addresses in the site
// spec (metal lists each site's agentless machines with their inspected addresses, never a BMC).
func proxyTargetAllowed(targets []*sitev1.ProxyTarget, nodeID, host string, ips []net.IP) error {
	var listed *sitev1.ProxyTarget
	for _, t := range targets {
		if nodeID != "" && t.GetNodeId() == nodeID {
			listed = t
			break
		}
	}
	if listed == nil {
		return fmt.Errorf("%q is not a proxy target of this site", nodeID)
	}
	name := strings.TrimSuffix(strings.ToLower(host), ".")
	listedIP := func(ip net.IP) bool {
		for _, addr := range listed.GetAddresses() {
			if l := net.ParseIP(addr); l != nil && l.Equal(ip) {
				return true
			}
		}
		return false
	}
	if literal := net.ParseIP(host); literal != nil {
		if listedIP(literal) {
			return nil
		}
		return fmt.Errorf("%s is not an address of %s", host, nodeID)
	}
	for _, addr := range listed.GetAddresses() {
		if net.ParseIP(addr) == nil && strings.TrimSuffix(strings.ToLower(addr), ".") == name {
			return nil
		}
	}
	for _, ip := range ips {
		if !listedIP(ip) {
			return fmt.Errorf("%s resolves to %s, not an address of %s", host, ip, nodeID)
		}
	}
	return nil
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
