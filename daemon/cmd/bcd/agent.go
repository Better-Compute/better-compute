package main

import (
	"bufio"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/kube"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
	"github.com/better-compute/better-compute/daemon/internal/tpm"
	"github.com/better-compute/better-compute/daemon/internal/transport"
)

// joinKeyFile is the JoinService encryption key the install script writes beside config.toml.
const joinKeyFile = "join-encryption.jwk"

// stdin is where bcd join reads the token when BCD_JOIN_TOKEN is unset (tests replace it).
var stdin io.Reader = os.Stdin

// loadConfig loads the configuration and refuses dev-only settings in a production build.
func loadConfig(fs *flag.FlagSet) (*config.Config, string, error) {
	file := fs.Lookup("config").Value.String()
	cfg, err := config.Load(file)
	if err != nil {
		return nil, file, err
	}
	if cfg.DevInsecureH2C && !devBuild {
		return nil, file, errors.New("dev_insecure_h2c is only accepted by fakehw development builds")
	}
	// Node keys in the TPM where there is one. bcd running unprivileged under [helper] never opens the
	// TPM (its resource manager filters no command: the hierarchies could be locked or cleared): root's
	// helper derives, signs and certifies its node keys (security review 3).
	agent.TPM = nodeKeyTPM(cfg.DataDir)
	if agent.TPM != nil && cfg.Helper.Socket != "" && os.Geteuid() != 0 {
		keys := helper.TPMKeys{Client: helper.Client{Socket: cfg.Helper.Socket}}
		agent.TPM = func() (tpm.Keys, error) { return keys, nil }
	}
	return cfg, file, nil
}

func newLogger(cfg *config.Config, w io.Writer) *slog.Logger {
	var level slog.Level
	_ = level.UnmarshalText([]byte(cfg.Log.Level))
	opts := &slog.HandlerOptions{Level: level}
	if cfg.Log.JSON {
		return slog.New(slog.NewJSONHandler(w, opts))
	}
	return slog.New(slog.NewTextHandler(w, opts))
}

// newClient builds the gateway client: TLS pinned to the serving CA with the node certificate when
// there is one, or h2c with the test-node header for a dev gateway.
func newClient(cfg *config.Config, state *agent.State, key crypto.Signer) (*transport.Client, error) {
	pin, err := config.DecodePin(cfg.ServingCASPKIPin)
	if err != nil {
		return nil, err
	}
	o := transport.Options{URL: cfg.GatewayURL, ServingCAPin: pin, ServerName: cfg.GatewayServerName, UserAgent: "bcd/" + version}
	if state != nil {
		if strings.HasPrefix(cfg.GatewayURL, "http://") {
			o.TestNode = state.NodeID
		} else {
			o.ClientCertificate = &tls.Certificate{Certificate: state.Chain, PrivateKey: key}
		}
	}
	return transport.New(o)
}

func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

// readToken reads the join token from BCD_JOIN_TOKEN, else the first line of stdin; it is never
// taken from arguments, logged or stored.
func readToken() (string, error) {
	if t := strings.TrimSpace(os.Getenv("BCD_JOIN_TOKEN")); t != "" {
		_ = os.Unsetenv("BCD_JOIN_TOKEN")
		return t, nil
	}
	line, err := bufio.NewReader(io.LimitReader(stdin, 4096)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	// A Windows shell piping into WSL may prefix a byte-order mark.
	if t := strings.TrimSpace(strings.TrimPrefix(line, "\uFEFF")); t != "" {
		return t, nil
	}
	return "", errors.New("no join token: set BCD_JOIN_TOKEN or pass the token on standard input")
}

// runJoin joins with a token (BCD_JOIN_TOKEN, stdin or --token-file). A machine without config.toml
// that is given --server (an OS provisioned with only a token) takes its configuration from the
// control plane's well-known document and writes config.toml once joined. Re-running it on a node
// that already joined succeeds without a token, so a join unit may run on every boot.
func runJoin(fs *flag.FlagSet, stdout, stderr io.Writer) int {
	file := fs.Lookup("config").Value.String()
	server := fs.Lookup("server").Value.String()
	pins := installPins{
		ServingCA:      fs.Lookup("serving-ca-pin").Value.String(),
		JoinSigning:    fs.Lookup("join-signing-pin").Value.String(),
		JoinEncryption: fs.Lookup("join-encryption-pin").Value.String(),
	}
	cfg, _, err := loadConfig(fs)
	var bootstrapJWK []byte
	bootstrapped := false
	if err != nil && errors.Is(err, os.ErrNotExist) && server != "" {
		cfg, bootstrapJWK, err = bootstrapConfig(server, pins, fs.Lookup("data-dir").Value.String())
		bootstrapped = err == nil
	} else if err == nil {
		// An installed configuration wins; pins given as well must agree with it.
		for _, p := range []struct{ flag, given, have string }{
			{"serving-ca-pin", pins.ServingCA, cfg.ServingCASPKIPin},
			{"join-signing-pin", pins.JoinSigning, cfg.JoinSigningKeyPin},
			{"join-encryption-pin", pins.JoinEncryption, cfg.JoinEncryptionKeyPin},
		} {
			if p.given != "" && p.given != p.have {
				err = fmt.Errorf("--%s does not match %s", p.flag, file)
			}
		}
	}
	if err != nil {
		fmt.Fprintf(stderr, "bcd join: %v\n", err)
		return exitFailure
	}
	log := newLogger(cfg, stderr)
	role := commonv1.AgentRole_AGENT_ROLE_NODE
	switch fs.Lookup("role").Value.String() {
	case "node":
	case "site":
		role = commonv1.AgentRole_AGENT_ROLE_SITE
	default:
		fmt.Fprintln(stderr, "bcd join: --role must be node or site")
		return exitUsage
	}
	// An OS a deploy installed joins as the node it was installed for, with the single-use
	// provisioned token its user data carried.
	nodeID := fs.Lookup("node-id").Value.String()
	attestor := fs.Lookup("attestor").Value.String()
	if attestor == "" && nodeID != "" {
		attestor = "provisioned"
	}
	tokenFile := fs.Lookup("token-file").Value.String()

	// finish writes a bootstrapped configuration and spends the token file.
	finish := func(state *agent.State) error {
		if bootstrapped {
			cfg.Site = state.SiteID
			if err := writeConfig(file, cfg, bootstrapJWK); err != nil {
				return fmt.Errorf("writing %s: %w", file, err)
			}
		}
		if tokenFile != "" {
			// Spent (single use), or not needed: it never stays on disk. A read-only mount (a
			// Kubernetes Secret volume) cannot be emptied here; the spent token is useless, and its
			// Secret is the cluster admin's to delete.
			if err := os.Remove(tokenFile); err != nil && !errors.Is(err, os.ErrNotExist) {
				if !errors.Is(err, syscall.EROFS) {
					return err
				}
				log.Warn("the token file is on a read-only mount and stays; delete its source (the spent token no longer joins)", "file", tokenFile)
			}
		}
		return nil
	}

	// --reset: an identity that loads but no longer works (a cleared TPM, an expired or refused
	// certificate) would otherwise answer "already joined" forever.
	if fs.Lookup("reset").Value.String() == "true" {
		if code := resetIdentity(cfg.DataDir, fs.Lookup("yes").Value.String() == "true", stdout, stderr); code != exitOK {
			return code
		}
	}
	if state, _, err := agent.LoadState(cfg.DataDir); err == nil {
		if nodeID != "" && state.NodeID != nodeID {
			fmt.Fprintf(stderr, "bcd join: this machine already joined as %s, not %s\n", state.NodeID, nodeID)
			return exitFailure
		}
		if err := finish(state); err != nil {
			fmt.Fprintf(stderr, "bcd join: %v\n", err)
			return exitFailure
		}
		fmt.Fprintf(stdout, "already joined as %s (site %s, role %s)\n", state.NodeID, state.SiteID, state.Role)
		return exitOK
	}

	var token string
	var attest agent.ChallengeAttestor
	switch {
	case attestor == "tpm":
		// The TPM is the credential (its EK; the attestor decides where the machine joins): no token
		// is read, and none is sent.
		if tokenFile != "" {
			fmt.Fprintln(stderr, "bcd join: --attestor tpm joins without a token; drop --token-file")
			return exitUsage
		}
		_ = os.Unsetenv("BCD_JOIN_TOKEN")
		dev, closeTPM, err := openTPM(cfg.DataDir)
		if err != nil {
			fmt.Fprintf(stderr, "bcd join: the TPM: %v\n", err)
			return exitFailure
		}
		defer closeTPM()
		a, err := tpm.NewAttestor(dev)
		if err != nil {
			fmt.Fprintf(stderr, "bcd join: %v\n", err)
			return exitFailure
		}
		defer a.Close()
		attest = a
	case tokenFile != "":
		raw, err := readTokenFile(tokenFile)
		if err != nil {
			fmt.Fprintf(stderr, "bcd join: %v\n", err)
			return exitFailure
		}
		token = strings.TrimSpace(strings.TrimPrefix(string(raw), "\uFEFF"))
	default:
		if token, err = readToken(); err != nil {
			fmt.Fprintf(stderr, "bcd join: %v\n", err)
			return exitUsage
		}
	}
	if _, ok := pki.ParseJoinToken(token); !ok && attest == nil {
		fmt.Fprintln(stderr, "bcd join: that is not a join token (bcjt_...)")
		return exitUsage
	}
	encPin, _ := config.DecodePin(cfg.JoinEncryptionKeyPin)
	var encKey *ecdsa.PublicKey
	if bootstrapped {
		encKey, err = pinnedJWK(bootstrapJWK, encPin)
		log.Info("configuration taken from the control plane's well-known document", "server", server, "gateway", cfg.GatewayURL)
	} else {
		encKey, err = joinEncryptionKey(filepath.Join(filepath.Dir(file), joinKeyFile), server, encPin)
	}
	if err != nil {
		fmt.Fprintf(stderr, "bcd join: %v\n", err)
		return exitFailure
	}
	signerPin, _ := config.DecodePin(cfg.JoinSigningKeyPin)
	host, err := newHost(cfg.DataDir)
	if err != nil {
		fmt.Fprintf(stderr, "bcd join: %v\n", err)
		return exitFailure
	}
	inv, err := host.Inventory()
	if err != nil {
		log.Warn("inventory unavailable; joining without hardware claims", "error", err.Error())
	}
	bootID, _ := host.BootID()
	client, err := newClient(cfg, nil, nil)
	if err != nil {
		fmt.Fprintf(stderr, "bcd join: %v\n", err)
		return exitFailure
	}
	defer client.Close()
	ctx, cancel := signalContext()
	defer cancel()
	state, err := agent.Join(ctx, agent.JoinOptions{
		Client:        client,
		Token:         token,
		Role:          role,
		Attestor:      attestor,
		Attest:        attest,
		EncryptionKey: encKey,
		SignerPin:     signerPin,
		Claims:        agent.Claims(inv, host.Hostname(), bootID),
		Version:       version,
		DataDir:       cfg.DataDir,
		Record:        joinRecorder(cfg),
		Log:           log,
	})
	token = ""
	if err != nil {
		fmt.Fprintf(stderr, "bcd join: %v\n", err)
		return exitFailure
	}
	if nodeID != "" && state.NodeID != nodeID {
		fmt.Fprintf(stderr, "bcd join: joined as %s, but this OS was installed for %s\n", state.NodeID, nodeID)
		return exitFailure
	}
	if err := finish(state); err != nil {
		fmt.Fprintf(stderr, "bcd join: %v\n", err)
		return exitFailure
	}
	fmt.Fprintf(stdout, "joined as %s (site %s, role %s); certificate valid until %s\n",
		state.NodeID, state.SiteID, state.Role, state.NotAfter.UTC().Format("2006-01-02 15:04 MST"))
	return exitOK
}

// joinEncryptionKey loads the JoinService encryption key from file, or, when there is none and a
// control plane URL is given, from its /.well-known/better-compute document (PLAN.md §6 Install).
// Either way the key must match the configured pin: a key from anywhere else is never used.
func joinEncryptionKey(file, server string, pin []byte) (*ecdsa.PublicKey, error) {
	raw, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) && server != "" {
		raw, err = wellKnownJWK(server)
	}
	if err != nil {
		return nil, fmt.Errorf("the JoinService encryption key: %w", err)
	}
	return pinnedJWK(raw, pin)
}

// pinnedJWK parses the JoinService encryption key and refuses one that does not match its pin.
func pinnedJWK(raw, pin []byte) (*ecdsa.PublicKey, error) {
	key, err := pki.ParseJWK(raw)
	if err != nil {
		return nil, fmt.Errorf("the JoinService encryption key: %w", err)
	}
	if !pki.MatchesPin(key, pin) {
		return nil, errors.New("the JoinService encryption key does not match join_encryption_key_pin")
	}
	return key, nil
}

// runtimesFor gives node agents the build's instance runtimes (site agents and ramdisks run none).
func runtimesFor(mode, dataDir string, host agent.Host) []runtime.Runtime {
	if mode != "node" {
		return nil
	}
	bootID, _ := host.BootID()
	return newRuntimes(dataDir, bootID)
}

// forHelper fits the runtimes to an unprivileged bcd node: their privileged work goes through bcd
// helper (c), where root validates every definition and path. libvirt's operations are the helper's
// libvirt.* (the node only reads libvirt's read-only socket, so it needs no root-equivalent libvirt
// group); cloud-hypervisor's taps, VFIO and VMM unit are its ch.*, the node sharing its files with
// each VMM's user through ACLs.
func forHelper(runtimes []runtime.Runtime, c helper.Client, log *slog.Logger) []runtime.Runtime {
	for _, r := range runtimes {
		switch r := r.(type) {
		case *runtime.CloudHypervisor:
			r.Privileged = helperCH{c}
		case *runtime.Libvirt:
			r.Hypervisor = helperHypervisor{c}
		}
	}
	return runtimes
}

// helperCH is runtime.CHPrivileged over bcd helper's ch.* ops.
type helperCH struct{ c helper.Client }

func (h helperCH) do(ctx context.Context, verb string, req helper.CHRequest) error {
	_, err := h.c.CH(ctx, verb, req)
	return err
}

func (h helperCH) Taps(ctx context.Context, id string, networks []string) error {
	return h.do(ctx, "taps", helper.CHRequest{Instance: id, Networks: networks})
}

func (h helperCH) Untaps(ctx context.Context, id string, nics int) error {
	return h.do(ctx, "untaps", helper.CHRequest{Instance: id, NICs: nics})
}

func (h helperCH) BindVFIO(ctx context.Context, id string) error {
	return h.do(ctx, "vfio", helper.CHRequest{Instance: id})
}

func (h helperCH) ReleaseVFIO(ctx context.Context, id string, addrs []string) error {
	return h.do(ctx, "unvfio", helper.CHRequest{Instance: id, Addrs: addrs})
}

func (h helperCH) Launch(ctx context.Context, id string) error {
	return h.do(ctx, "launch", helper.CHRequest{Instance: id})
}

func (h helperCH) Stop(ctx context.Context, id string) (string, error) {
	return h.c.CH(ctx, "stop", helper.CHRequest{Instance: id})
}

// helperHypervisor is runtime.Hypervisor over bcd helper's libvirt ops.
type helperHypervisor struct{ c helper.Client }

func (h helperHypervisor) Libvirt(ctx context.Context, verb string, op runtime.LibvirtOp) error {
	return h.c.Libvirt(ctx, verb, helper.LibvirtRequest{Domain: op.Domain, XML: op.XML, Target: op.Target, Bytes: op.Bytes, File: op.File, Paused: op.Paused})
}

func (h helperHypervisor) Console(ctx context.Context, domain string) (*os.File, error) {
	return h.c.Console(ctx, domain)
}

// clientRenewer calls Renew on whichever client is current.
type clientRenewer struct {
	client *atomic.Pointer[transport.Client]
}

func (r clientRenewer) Renew(ctx context.Context, req *agentv1.RenewRequest) (*agentv1.RenewResponse, error) {
	return r.client.Load().Renew(ctx, req)
}

func runNode(fs *flag.FlagSet, _, stderr io.Writer) int {
	cfg, _, err := loadConfig(fs)
	if err != nil {
		fmt.Fprintf(stderr, "bcd node: %v\n", err)
		return exitFailure
	}
	log := newLogger(cfg, stderr)
	var imds func(ctx context.Context, a *agent.Agent)
	if cfg.IMDSListen != "" {
		imds = func(ctx context.Context, a *agent.Agent) {
			if err := a.ServeIMDS(ctx, cfg.IMDSListen); err != nil {
				log.Error("metadata service stopped", "error", err.Error())
			}
		}
	}
	return runAgent("node", cfg, log, stderr, imds)
}

// runAgent runs the agent of a joined identity in cfg.DataDir until a signal (bcd node, bcd ramdisk).
func runAgent(mode string, cfg *config.Config, log *slog.Logger, stderr io.Writer, alongside func(ctx context.Context, a *agent.Agent)) int {
	if cfg.DevInsecureH2C {
		log.Warn("dev_insecure_h2c: cleartext HTTP/2 to a dev gateway; never on a reachable machine")
	}
	state, key, err := agent.LoadState(cfg.DataDir)
	if err != nil {
		fmt.Fprintf(stderr, "bcd %s: %v\n", mode, err)
		return exitFailure
	}
	j, err := journal.OpenBolt(filepath.Join(cfg.DataDir, agent.JournalFile), journal.BoltOptions{
		MaxEvents: int(cfg.Journal.MaxEvents),
		MaxBytes:  int(cfg.Journal.MaxBytes),
	})
	if err != nil {
		fmt.Fprintf(stderr, "bcd %s: journal: %v\n", mode, err)
		return exitFailure
	}
	defer j.Close()
	host, err := newHost(cfg.DataDir)
	if err != nil {
		fmt.Fprintf(stderr, "bcd %s: %v\n", mode, err)
		return exitFailure
	}
	underHelper := cfg.Helper.Socket != "" && mode == "node"
	if underHelper {
		// Privilege separation: bcd helper (root) does the privileged work this unprivileged node asks for.
		if rh, ok := host.(*agent.RealHost); ok {
			rh.Helper = &helper.Client{Socket: cfg.Helper.Socket}
		}
	}
	plugins := startPlugins(context.Background(), cfg.PluginsDir, cfg.Plugins, log)
	defer func() {
		for _, p := range plugins {
			p.Close()
		}
	}()
	drivers := agent.DriversOf(plugins)
	runtimes := runtimesFor(mode, cfg.DataDir, host)
	if underHelper {
		runtimes = forHelper(runtimes, helper.Client{Socket: cfg.Helper.Socket}, log)
	}
	if mode == "node" {
		// Runtimes the plugins serve (a Kata or Firecracker plugin), beside the built-in ones.
		runtimes = append(runtimes, agent.PluginRuntimes(drivers, runtimes)...)
	}
	var client atomic.Pointer[transport.Client]
	first, err := newClient(cfg, state, key)
	if err != nil {
		fmt.Fprintf(stderr, "bcd %s: %v\n", mode, err)
		return exitFailure
	}
	client.Store(first)
	signerPin, _ := config.DecodePin(cfg.JoinSigningKeyPin)
	approverSetPin, _ := cfg.ApproverSetPin() // validated when the file was loaded
	bmcNetworks, _ := cfg.BMCNets()
	kubernetesAllowed, err := kube.ParseAllowedClusters(cfg.KubernetesAllowedClusters)
	if err != nil {
		fmt.Fprintf(stderr, "bcd %s: %v\n", mode, err)
		return exitFailure
	}
	if api := cfg.KubernetesGPUAPI; api != "" && api != kube.APIDevicePlugin && api != kube.APIDRA {
		fmt.Fprintf(stderr, "bcd %s: [kubernetes] gpu_api must be %q or %q\n", mode, kube.APIDevicePlugin, kube.APIDRA)
		return exitFailure
	}
	var update *agent.UpdateOptions
	if mode == "node" || mode == "site" {
		if update, err = updateOptions(cfg, log); err != nil {
			fmt.Fprintf(stderr, "bcd %s: %v\n", mode, err)
			return exitFailure
		}
	}
	// running is the agent once built: the WS dial and renewer take its identity.
	var running *agent.Agent
	opts := agent.Options{
		State:   state,
		Key:     key,
		DataDir: cfg.DataDir,
		Journal: j,
		Host:    host,
		Dial: func(ctx context.Context) (agent.Stream, error) {
			return client.Load().Session(ctx), nil
		},
		DialTunnel: func(ctx context.Context) (agent.TunnelStream, error) {
			return client.Load().Tunnel(ctx), nil
		},
		Renewer: clientRenewer{client: &client},
		OnRenewed: func(s *agent.State, k crypto.Signer) {
			next, err := newClient(cfg, s, k)
			if err != nil {
				log.Error("rebuild the gateway client after renewal", "error", err.Error())
				return
			}
			old := client.Swap(next)
			old.Close()
		},
		SignerPin:      signerPin,
		ApproverSetPin: approverSetPin,
		BMCNetworks:    bmcNetworks,
		ImageCache:     cfg.ImageCache,
		Runtimes:       runtimes,
		Drivers:        drivers,
		InstallConfig:  cfg.InstallFiles,
		CacheMaxBytes:  uint64(max(cfg.Boot.CacheMaxBytes, 0)),
		Version:        version,
		Log:            log,
		Update:         update,
		// k8s-join: under bcd helper the helper enforces the allowlist itself (and requires one).
		KubernetesAllowed: kubernetesAllowed,
		KubernetesGPUAPI:  cfg.KubernetesGPUAPI,
		BalloonFloor:      float64(cfg.BalloonFloorPercent) / 100,
		GPUSampler:        gpuSampler(),
		// [host] units = false: the GPU operator (or another tool) owns the host's configuration.
		ExternalHost: cfg.ExternalHost,
	}
	if d, err := time.ParseDuration(os.Getenv("BCD_RENEW_AFTER")); devBuild && err == nil {
		opts.RenewAfter = d // fakehw builds only: renew soon after start (e2e)
	}
	if cfg.WebSocket.URL != "" && (mode == "node" || mode == "site") {
		if err := useWebSocket(&opts, cfg, func() (*agent.State, crypto.Signer) {
			if running == nil {
				return nil, nil
			}
			return running.Identity()
		}); err != nil {
			fmt.Fprintf(stderr, "bcd %s: %v\n", mode, err)
			return exitFailure
		}
		log.Warn("the session uses the WebSocket fallback: signed commands and specs only, no tunnels", "url", cfg.WebSocket.URL)
	}
	a, err := agent.New(opts)
	running = a
	if err != nil {
		fmt.Fprintf(stderr, "bcd %s: %v\n", mode, err)
		return exitFailure
	}
	stopStatus := serveStatus(cfg.SocketPath, a, log)
	defer stopStatus()
	ctx, cancel := signalContext()
	defer cancel()
	if alongside != nil {
		go alongside(ctx, a)
	}
	go func() {
		<-ctx.Done()
		log.Info("bcd " + mode + " stopping")
	}()
	log.Info("bcd "+mode+" starting", "version", version, "node", state.NodeID, "site", state.SiteID, "gateway", cfg.GatewayURL, "hardware", hardwareBackend)
	if err := a.Run(ctx); err != nil {
		if errors.Is(err, agent.ErrRestart) {
			// Self-update: main execs the entrypoint (now the other slot) once this returns.
			restartInto = update.Slots.Entrypoint
			return exitOK
		}
		fmt.Fprintf(stderr, "bcd %s: %v\n", mode, err)
		return exitFailure
	}
	return exitOK
}
