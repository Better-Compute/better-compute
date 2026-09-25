package agent

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	sitev1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/site/v1"
	"github.com/better-compute/better-compute/daemon/internal/bootparams"
	"github.com/better-compute/better-compute/daemon/internal/converge"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/pxe"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// The site's boot server (PLAN.md §3.5): while this agent holds the site:<id>:boot lease (the site
// section of its NodeSpec), it serves the iPXE scripts of the machines metal prepared
// (boot.prepareRamdisk). A script boots the site's ramdisk with the boot parameters bcd ramdisk
// joins with: the machine's single-use discovery token (fetched with SecretRequest, never in a
// command) and a discovery assertion this agent signs under the lease epoch. An agent that loses
// the gateway for longer than the lease TTL fences itself: it stops answering.

// BootConfig configures the boot server (config.toml [boot]).
type BootConfig struct {
	// Listen is the HTTP address iPXE fetches scripts from (e.g. 0.0.0.0:8080).
	Listen string
	// Kernel and Initrd are the site's ramdisk artifacts (URLs iPXE fetches).
	Kernel string
	Initrd string
	// Cmdline is appended to every ramdisk's kernel command line (console=…).
	Cmdline string
	// Join are the gateway parameters the ramdisk joins with (token and assertion are per machine).
	Join bootparams.Params
	// URL is how machines reach this boot server (http://10.20.0.2:8080): iPXE chains to it.
	URL string
	// ServerIP is this agent's address on the provisioning network (proxyDHCP server id, TFTP).
	ServerIP net.IP
	// ProxyDHCP are the UDP addresses the proxyDHCP server listens on (":67", ":4011"); empty: none.
	ProxyDHCP []string
	// TFTP is the UDP address of the TFTP server (":69") and TFTPRoot its files (the iPXE builds).
	TFTP     string
	TFTPRoot string
}

// Bootfiles by client architecture: iPXE builds the site ships in TFTPRoot.
var bootfiles = map[pxe.Arch]string{
	pxe.ArchBIOS:       "undionly.kpxe",
	pxe.ArchEFIx86_64:  "ipxe.efi",
	pxe.ArchEFIx86_64b: "ipxe.efi",
	pxe.ArchEFIArm64:   "ipxe-arm64.efi",
	pxe.ArchHTTPx86_64: "ipxe.efi",
	pxe.ArchHTTPArm64:  "ipxe-arm64.efi",
}

// pxeAnswer decides a PXE client's first stage: only prepared machines, only with the lease.
func (a *Agent) pxeAnswer(cfg BootConfig, r pxe.Request) (pxe.Answer, bool) {
	if _, active := a.bootActive(); !active {
		return pxe.Answer{}, false
	}
	if a.boot.Get(r.MAC.String(), a.serverNow()) == nil {
		return pxe.Answer{}, false
	}
	base := strings.TrimRight(cfg.URL, "/")
	if r.IPXE {
		return pxe.Answer{Bootfile: base + "/boot/chain.ipxe"}, true
	}
	file, ok := bootfiles[r.Arch]
	if !ok {
		return pxe.Answer{}, false
	}
	if r.Arch.HTTPBoot() {
		return pxe.Answer{Bootfile: base + "/boot/files/" + file}, true
	}
	return pxe.Answer{NextServer: cfg.ServerIP, Bootfile: file}, true
}

// assertionTTL bounds a discovery assertion: the boot it vouches for, no more.
const assertionTTL = 15 * time.Minute

// bootLease is the site:<id>:boot lease as the last site section said.
type bootLease struct {
	active bool
	epoch  uint64
	ttl    time.Duration
}

// siteConverger applies SiteSpec: the boot lease (cache images arrive with the image cache).
type siteConverger struct{ a *Agent }

func (c siteConverger) Section() converge.Section { return "site" }

func (c siteConverger) Plan(_ context.Context, desired []byte) ([]converge.Action, error) {
	spec := &sitev1.SiteSpec{}
	if err := proto.Unmarshal(desired, spec); err != nil {
		return nil, converge.Terminal(fmt.Errorf("site section: %w", err))
	}
	b := spec.GetBoot()
	lease := bootLease{active: b.GetActive(), epoch: b.GetEpoch(), ttl: time.Duration(b.GetTtlMs()) * time.Millisecond}
	c.a.mu.Lock()
	changed := c.a.lease != lease
	c.a.lease = lease
	c.a.mu.Unlock()
	if changed {
		c.a.log.Info("boot lease", "active", lease.active, "epoch", lease.epoch, "ttl", lease.ttl.String())
	}
	keep := map[string]bool{}
	for _, img := range spec.GetCacheImages() {
		keep[fmt.Sprintf("%x", img.GetSha256())] = true
	}
	if n := c.a.cache.evict(keep); n > 0 {
		c.a.log.Info("image cache evicted", "images", n)
	}
	if len(spec.GetCacheImages()) > 0 {
		ctx := c.a.ctx
		if ctx == nil {
			ctx = context.Background()
		}
		missing, failures := c.a.cache.warm(ctx, spec.GetCacheImages(), c.a.imageClient(), func(msg string, kv ...any) { c.a.log.Info(msg, kv...) })
		if missing > 0 {
			go c.a.refreshSections()
		}
		if len(failures) > 0 {
			return nil, converge.Terminal(errors.New(strings.Join(failures, "; ")))
		}
		if missing > 0 {
			return nil, fmt.Errorf("%d cache images warming", missing)
		}
	}
	return nil, nil
}

// bootActive reports whether this agent answers PXE machines now: it holds the lease and has heard
// from the gateway within the lease TTL (a partitioned agent fences itself).
func (a *Agent) bootActive() (bootLease, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	l := a.lease
	if !l.active || l.epoch == 0 {
		return l, false
	}
	ttl := l.ttl
	if ttl <= 0 {
		ttl = 15 * time.Second
	}
	return l, time.Since(a.lastContact) <= ttl
}

// ServeBoot runs the boot server until ctx is done.
func (a *Agent) ServeBoot(ctx context.Context, cfg BootConfig) error {
	if cfg.Listen == "" || cfg.Kernel == "" || cfg.Initrd == "" {
		return errors.New("boot: listen, kernel and initrd are required")
	}
	mux := a.BootHandler(cfg)
	for _, addr := range cfg.ProxyDHCP {
		conn, err := net.ListenPacket("udp4", addr)
		if err != nil {
			return fmt.Errorf("proxyDHCP %s: %w", addr, err)
		}
		go func() {
			if err := pxe.ServeProxyDHCP(ctx, conn, cfg.ServerIP, func(r pxe.Request) (pxe.Answer, bool) { return a.pxeAnswer(cfg, r) }); err != nil {
				a.log.Error("proxyDHCP stopped", "error", err.Error())
			}
		}()
		a.log.Info("proxyDHCP listening", "addr", addr)
	}
	if cfg.TFTP != "" {
		conn, err := net.ListenPacket("udp4", cfg.TFTP)
		if err != nil {
			return fmt.Errorf("tftp %s: %w", cfg.TFTP, err)
		}
		go func() { _ = (&pxe.TFTPServer{Root: cfg.TFTPRoot}).Serve(ctx, conn) }()
		a.log.Info("tftp listening", "addr", cfg.TFTP, "root", cfg.TFTPRoot)
	}
	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	a.log.Info("boot server listening", "addr", ln.Addr().String())
	if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// BootHandler serves GET /boot/ipxe?mac=${mac}&uuid=${uuid}&ip=${ip} (what the iPXE first stage chains).
func (a *Agent) BootHandler(cfg BootConfig) *http.ServeMux {
	a.mu.Lock()
	a.bootURL = cfg.URL // where machines (and BMCs fetching firmware) reach the cache
	a.mu.Unlock()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /boot/ipxe", func(w http.ResponseWriter, r *http.Request) { a.serveIPXE(w, r, cfg) })
	mux.HandleFunc("GET /cache/", a.cache.serve)
	// iPXE's second stage: chain to this machine's script with what iPXE knows about it.
	mux.HandleFunc("GET /boot/chain.ipxe", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = fmt.Fprintf(w, "#!ipxe\nchain %s/boot/ipxe?mac=${net0/mac}&uuid=${uuid}&ip=${net0/ip}&buildarch=${buildarch}&platform=${platform}\n",
			strings.TrimRight(cfg.URL, "/"))
	})
	// UEFI HTTP boot fetches the iPXE build over HTTP instead of TFTP.
	if cfg.TFTPRoot != "" {
		files := http.StripPrefix("/boot/files/", http.FileServer(http.Dir(cfg.TFTPRoot)))
		mux.Handle("GET /boot/files/", files)
	}
	return mux
}

// tokenCache keeps each MAC's fetched discovery token for its entry (a machine may fetch its script
// more than once in one boot).
type tokenCache struct {
	mu     sync.Mutex
	tokens map[string]string
}

func (a *Agent) serveIPXE(w http.ResponseWriter, r *http.Request, cfg BootConfig) {
	w.Header().Set("Content-Type", "text/plain")
	lease, active := a.bootActive()
	if !active {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = fmt.Fprint(w, "#!ipxe\necho This boot server does not hold the site boot lease.\nsleep 10\nreboot\n")
		return
	}
	q := r.URL.Query()
	mac := strings.ToLower(q.Get("mac"))
	now := a.serverNow()
	entry := a.boot.Get(mac, now)
	if entry == nil {
		a.log.Info("PXE request from an unknown machine", "mac", mac, "uuid", q.Get("uuid"))
		w.WriteHeader(http.StatusNotFound)
		_, _ = fmt.Fprint(w, "#!ipxe\necho No boot is prepared for this machine.\nexit\n")
		return
	}
	token, err := a.discoveryToken(r.Context(), entry)
	if err != nil {
		a.log.Warn("discovery token unavailable", "mac", mac, "error", err.Error())
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = fmt.Fprint(w, "#!ipxe\necho The boot credential is not available yet.\nsleep 10\nchain ${self}\n")
		return
	}
	notAfter := now.Add(assertionTTL)
	if na := entry.GetNotAfter(); na != nil && na.AsTime().Before(notAfter) {
		notAfter = na.AsTime()
	}
	ip := q.Get("ip")
	if ip == "" {
		ip, _, _ = net.SplitHostPort(r.RemoteAddr)
	}
	body, err := marshal(&sitev1.DiscoveryAssertion{
		SiteId:          a.state.SiteID,
		SiteAgentNodeId: a.NodeID(),
		BootLeaseEpoch:  lease.epoch,
		Mac:             mac,
		Ip:              ip,
		ProductUuid:     strings.ToLower(firstNonEmpty(q.Get("uuid"), entry.GetProductUuid())),
		WorkflowId:      entry.GetWorkflowId(),
		IssuedAt:        timestamppb.New(now),
		NotAfter:        timestamppb.New(notAfter),
	})
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	sig, err := pki.SignNodeStatement(a.currentKey(), pki.SigningInput(pki.PurposeDiscoveryAssertion, body))
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	assertion, _ := marshal(&sitev1.SignedDiscoveryAssertion{Body: body, Sig: sig})
	params := cfg.Join
	params.Token, params.Assertion = token, assertion
	args := append([]string{"initrd=initrd"}, bootparams.Render(params)...)
	if cfg.Cmdline != "" {
		args = append(args, cfg.Cmdline)
	}
	a.log.Info("iPXE script served", "mac", mac, "workflow", entry.GetWorkflowId(), "epoch", lease.epoch)
	_, _ = fmt.Fprintf(w, "#!ipxe\nkernel %s %s\ninitrd --name initrd %s\nboot\n", cfg.Kernel, strings.Join(args, " "), cfg.Initrd)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// discoveryToken fetches (once per entry) the machine's discovery token for its workflow.
func (a *Agent) discoveryToken(ctx context.Context, e *sitev1.ProxyDhcpEntry) (string, error) {
	ref := e.GetDiscoveryTokenRef()
	if ref == "" {
		return "", errors.New("the boot entry carries no discovery token")
	}
	a.tokens.mu.Lock()
	if t, ok := a.tokens.tokens[ref]; ok {
		a.tokens.mu.Unlock()
		return t, nil
	}
	a.tokens.mu.Unlock()
	v, err := a.RequestSecret(ctx, ref, pki.SecretBinding{WorkflowID: e.GetWorkflowId()})
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(v))
	a.tokens.mu.Lock()
	if a.tokens.tokens == nil {
		a.tokens.tokens = map[string]string{}
	}
	a.tokens.tokens[ref] = token
	a.tokens.mu.Unlock()
	return token, nil
}
