package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
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

func runJoin(fs *flag.FlagSet, stdout, stderr io.Writer) int {
	cfg, file, err := loadConfig(fs)
	if err != nil {
		fmt.Fprintf(stderr, "bcd join: %v\n", err)
		return exitFailure
	}
	log := newLogger(cfg, stderr)
	tokenFile := fs.Lookup("token-file").Value.String()
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
	encKey, err := joinEncryptionKey(filepath.Join(filepath.Dir(file), joinKeyFile), fs.Lookup("server").Value.String(), encPin)
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
	if tokenFile != "" {
		// Spent (single use): it never stays on disk.
		_ = os.Remove(tokenFile)
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
	key, err := pki.ParseJWK(raw)
	if err != nil {
		return nil, fmt.Errorf("the JoinService encryption key: %w", err)
	}
	if !pki.MatchesPin(key, pin) {
		return nil, errors.New("the JoinService encryption key does not match join_encryption_key_pin")
	}
	return key, nil
}

// wellKnownClient fetches the well-known document (system roots: the control plane's public TLS).
var wellKnownClient = &http.Client{Timeout: 30 * time.Second}

// wellKnownJWK fetches join.encryptionJwk from <server>/.well-known/better-compute over https.
func wellKnownJWK(server string) ([]byte, error) {
	if !strings.HasPrefix(server, "https://") {
		return nil, errors.New("--server must be an https:// URL")
	}
	resp, err := wellKnownClient.Get(strings.TrimRight(server, "/") + "/.well-known/better-compute")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s/.well-known/better-compute returned %s", server, resp.Status)
	}
	var doc struct {
		Join *struct {
			EncryptionJwk json.RawMessage `json:"encryptionJwk"`
		} `json:"join"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&doc); err != nil || doc.Join == nil {
		return nil, errors.New("the control plane publishes no join keys")
	}
	return doc.Join.EncryptionJwk, nil
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
	plugins := startPlugins(context.Background(), cfg.PluginsDir, log)
	defer func() {
		for _, p := range plugins {
			p.Close()
		}
	}()
	var client atomic.Pointer[transport.Client]
	first, err := newClient(cfg, state, key)
	if err != nil {
		fmt.Fprintf(stderr, "bcd %s: %v\n", mode, err)
		return exitFailure
	}
	client.Store(first)
	signerPin, _ := config.DecodePin(cfg.JoinSigningKeyPin)
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
		Runtimes:      runtimesFor(mode, cfg.DataDir, host),
		Drivers:       agent.DriversOf(plugins),
		InstallConfig: cfg.InstallFiles,
		CacheMaxBytes: uint64(max(cfg.Boot.CacheMaxBytes, 0)),
		Version:       version,
		Log:           log,
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
		fmt.Fprintf(stderr, "bcd %s: %v\n", mode, err)
		return exitFailure
	}
	return exitOK
}
