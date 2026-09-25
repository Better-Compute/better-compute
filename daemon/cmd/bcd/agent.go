package main

import (
	"bufio"
	"context"
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

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
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
func newClient(cfg *config.Config, state *agent.State, key *ecdsa.PrivateKey) (*transport.Client, error) {
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
			// Spent (single use), or not needed: it never stays on disk.
			if err := os.Remove(tokenFile); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
		return nil
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
	if tokenFile != "" {
		raw, err := os.ReadFile(tokenFile)
		if err != nil {
			fmt.Fprintf(stderr, "bcd join: %v\n", err)
			return exitFailure
		}
		token = strings.TrimSpace(strings.TrimPrefix(string(raw), "\uFEFF"))
	} else if token, err = readToken(); err != nil {
		fmt.Fprintf(stderr, "bcd join: %v\n", err)
		return exitUsage
	}
	if _, ok := pki.ParseJoinToken(token); !ok {
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
		EncryptionKey: encKey,
		SignerPin:     signerPin,
		Claims:        agent.Claims(inv, host.Hostname(), bootID),
		Version:       version,
		DataDir:       cfg.DataDir,
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
	plugins := startPlugins(context.Background(), cfg.PluginsDir, cfg.Plugins, log)
	defer func() {
		for _, p := range plugins {
			p.Close()
		}
	}()
	drivers := agent.DriversOf(plugins)
	runtimes := runtimesFor(mode, cfg.DataDir, host)
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
	var update *agent.UpdateOptions
	if mode == "node" || mode == "site" {
		if update, err = updateOptions(cfg); err != nil {
			fmt.Fprintf(stderr, "bcd %s: %v\n", mode, err)
			return exitFailure
		}
	}
	a, err := agent.New(agent.Options{
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
		OnRenewed: func(s *agent.State, k *ecdsa.PrivateKey) {
			next, err := newClient(cfg, s, k)
			if err != nil {
				log.Error("rebuild the gateway client after renewal", "error", err.Error())
				return
			}
			old := client.Swap(next)
			old.Close()
		},
		SignerPin:     signerPin,
		ImageCache:    cfg.ImageCache,
		Runtimes:      runtimes,
		Drivers:       drivers,
		InstallConfig: cfg.InstallFiles,
		CacheMaxBytes: uint64(max(cfg.Boot.CacheMaxBytes, 0)),
		Version:       version,
		Log:           log,
		Update:        update,
	})
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
