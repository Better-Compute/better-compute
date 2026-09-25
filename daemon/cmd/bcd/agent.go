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
	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/pki"
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
	token, err := readToken()
	if err != nil {
		fmt.Fprintf(stderr, "bcd join: %v\n", err)
		return exitUsage
	}
	if _, ok := pki.ParseJoinToken(token); !ok {
		fmt.Fprintln(stderr, "bcd join: that is not a join token (bcjt_...)")
		return exitUsage
	}
	jwk, err := os.ReadFile(filepath.Join(filepath.Dir(file), joinKeyFile))
	if err != nil {
		fmt.Fprintf(stderr, "bcd join: the JoinService encryption key: %v\n", err)
		return exitFailure
	}
	encKey, err := pki.ParseJWK(jwk)
	if err != nil {
		fmt.Fprintf(stderr, "bcd join: %s: %v\n", joinKeyFile, err)
		return exitFailure
	}
	encPin, _ := config.DecodePin(cfg.JoinEncryptionKeyPin)
	if !pki.MatchesPin(encKey, encPin) {
		fmt.Fprintf(stderr, "bcd join: %s does not match join_encryption_key_pin\n", joinKeyFile)
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
	fmt.Fprintf(stdout, "joined as %s (site %s, role %s); certificate valid until %s\n",
		state.NodeID, state.SiteID, state.Role, state.NotAfter.UTC().Format("2006-01-02 15:04 MST"))
	return exitOK
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
	if cfg.DevInsecureH2C {
		log.Warn("dev_insecure_h2c: cleartext HTTP/2 to a dev gateway; never on a reachable machine")
	}
	state, key, err := agent.LoadState(cfg.DataDir)
	if err != nil {
		fmt.Fprintf(stderr, "bcd node: %v\n", err)
		return exitFailure
	}
	j, err := journal.OpenBolt(filepath.Join(cfg.DataDir, agent.JournalFile), journal.BoltOptions{
		MaxEvents: int(cfg.Journal.MaxEvents),
		MaxBytes:  int(cfg.Journal.MaxBytes),
	})
	if err != nil {
		fmt.Fprintf(stderr, "bcd node: journal: %v\n", err)
		return exitFailure
	}
	defer j.Close()
	host, err := newHost(cfg.DataDir)
	if err != nil {
		fmt.Fprintf(stderr, "bcd node: %v\n", err)
		return exitFailure
	}
	var client atomic.Pointer[transport.Client]
	first, err := newClient(cfg, state, key)
	if err != nil {
		fmt.Fprintf(stderr, "bcd node: %v\n", err)
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
		SignerPin: signerPin,
		Version:   version,
		Log:       log,
	})
	if err != nil {
		fmt.Fprintf(stderr, "bcd node: %v\n", err)
		return exitFailure
	}
	ctx, cancel := signalContext()
	defer cancel()
	log.Info("bcd node starting", "version", version, "node", state.NodeID, "site", state.SiteID, "gateway", cfg.GatewayURL, "hardware", hardwareBackend)
	if err := a.Run(ctx); err != nil {
		fmt.Fprintf(stderr, "bcd node: %v\n", err)
		return exitFailure
	}
	return exitOK
}
