package main

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/transport"
)

// bcd sim (PLAN.md §15): --nodes real daemons in one process against the configured gateway, each a
// fakehw machine (seed, seed+1, …) with its own data directory (<data_dir>/sim/<i>), identity,
// journal, session and fake instance runtime. Nodes not joined yet join with the one token read
// from BCD_JOIN_TOKEN or stdin (it must allow that many uses), a few at a time. A node.reboot
// restarts that node's agent with a new boot id. The load it puts on a gateway is the real
// daemon's, not a model of it.

// simJoins bounds the joins in flight, so a thousand nodes do not all knock at once.
const simJoins = 16

func runSim(fs *flag.FlagSet, stdout, stderr io.Writer) int {
	if !devBuild {
		fmt.Fprintln(stderr, "bcd sim: needs a fakehw build (go build -tags fakehw)")
		return exitUsage
	}
	nodes := fs.Lookup("nodes").Value.(flag.Getter).Get().(int)
	seed := fs.Lookup("seed").Value.(flag.Getter).Get().(uint64)
	if nodes < 1 {
		fmt.Fprintln(stderr, "bcd sim: --nodes must be at least 1")
		return exitUsage
	}
	cfg, file, err := loadConfig(fs)
	if err != nil {
		fmt.Fprintf(stderr, "bcd sim: %v\n", err)
		return exitFailure
	}
	log := newLogger(cfg, stderr)
	dirs := make([]string, nodes)
	unjoined := 0
	for i := range dirs {
		dirs[i] = filepath.Join(cfg.DataDir, "sim", strconv.Itoa(i))
		if _, _, err := agent.LoadState(dirs[i]); errors.Is(err, agent.ErrNotJoined) {
			unjoined++
		}
	}
	var token string
	if unjoined > 0 {
		if token, err = readToken(); err != nil {
			fmt.Fprintf(stderr, "bcd sim: %d nodes have not joined: %v\n", unjoined, err)
			return exitUsage
		}
		if _, ok := pki.ParseJoinToken(token); !ok {
			fmt.Fprintln(stderr, "bcd sim: that is not a join token (bcjt_...)")
			return exitUsage
		}
	}
	encPin, _ := config.DecodePin(cfg.JoinEncryptionKeyPin)
	encKey, err := joinEncryptionKey(filepath.Join(filepath.Dir(file), joinKeyFile), "", encPin)
	if unjoined > 0 && err != nil {
		fmt.Fprintf(stderr, "bcd sim: %v\n", err)
		return exitFailure
	}
	s := &simulator{cfg: cfg, log: log, token: token, encKey: encKey, joins: make(chan struct{}, simJoins)}
	ctx, cancel := signalContext()
	defer cancel()
	var wg sync.WaitGroup
	for i, dir := range dirs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.run(ctx, i, dir, seed+uint64(i))
		}()
	}
	fmt.Fprintf(stdout, "bcd sim: %d nodes (fakehw seeds %d-%d) against %s\n", nodes, seed, seed+uint64(nodes)-1, cfg.GatewayURL)
	wg.Wait()
	fmt.Fprintf(stdout, "bcd sim: stopped; %d joined, %d reboots\n", s.joined.Load(), s.reboots.Load())
	return exitOK
}

type simulator struct {
	cfg     *config.Config
	log     *slog.Logger
	token   string
	encKey  *ecdsa.PublicKey
	joins   chan struct{}
	joined  atomic.Int64
	reboots atomic.Int64
}

// run keeps one simulated machine alive until ctx ends: its agent restarts after a reboot and, with
// a back-off, after a failure.
func (s *simulator) run(ctx context.Context, i int, dir string, seed uint64) {
	log := s.log.With("sim", i)
	failures := 0
	for ctx.Err() == nil {
		rebooted, err := s.boot(ctx, dir, seed, log)
		switch {
		case ctx.Err() != nil:
			return
		case rebooted:
			s.reboots.Add(1)
			failures = 0
		case err != nil:
			failures++
			wait := min(time.Duration(failures)*time.Second, time.Minute)
			log.Error("simulated node stopped", "error", err.Error(), "restart", wait.String())
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
		}
	}
}

// boot runs one boot of a machine: joins if it never did, then runs its agent until ctx ends or the
// machine reboots.
func (s *simulator) boot(parent context.Context, dir string, seed uint64, log *slog.Logger) (rebooted bool, err error) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	var reboot atomic.Bool
	host, err := newSimHost(dir, seed, func() { reboot.Store(true); cancel() })
	if err != nil {
		return false, err
	}
	cfg := *s.cfg
	cfg.DataDir = dir
	state, key, err := agent.LoadState(dir)
	if errors.Is(err, agent.ErrNotJoined) {
		if state, key, err = s.join(ctx, &cfg, host, log); err != nil {
			return false, err
		}
	} else if err != nil {
		return false, err
	}
	j, err := journal.OpenBolt(filepath.Join(dir, agent.JournalFile), journal.BoltOptions{
		MaxEvents: int(cfg.Journal.MaxEvents), MaxBytes: int(cfg.Journal.MaxBytes),
	})
	if err != nil {
		return false, fmt.Errorf("journal: %w", err)
	}
	defer j.Close()
	var client atomic.Pointer[transport.Client]
	first, err := newClient(&cfg, state, key)
	if err != nil {
		return false, err
	}
	client.Store(first)
	defer func() { client.Load().Close() }()
	signerPin, _ := config.DecodePin(cfg.JoinSigningKeyPin)
	bootID, _ := host.BootID()
	a, err := agent.New(agent.Options{
		State: state, Key: key, DataDir: dir, Journal: j, Host: host,
		Dial:       func(ctx context.Context) (agent.Stream, error) { return client.Load().Session(ctx), nil },
		DialTunnel: func(ctx context.Context) (agent.TunnelStream, error) { return client.Load().Tunnel(ctx), nil },
		Renewer:    clientRenewer{client: &client},
		OnRenewed: func(st *agent.State, k crypto.Signer) {
			if next, err := newClient(&cfg, st, k); err == nil {
				client.Swap(next).Close()
			}
		},
		SignerPin: signerPin,
		Runtimes:  newRuntimes(dir, bootID),
		Version:   version,
		Log:       log,
	})
	if err != nil {
		return false, err
	}
	err = a.Run(ctx)
	return reboot.Load(), err
}

// join joins a machine with the simulator's token (a few at a time).
func (s *simulator) join(ctx context.Context, cfg *config.Config, host agent.Host, log *slog.Logger) (*agent.State, crypto.Signer, error) {
	select {
	case s.joins <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}
	defer func() { <-s.joins }()
	client, err := newClient(cfg, nil, nil)
	if err != nil {
		return nil, nil, err
	}
	defer client.Close()
	inv, _ := host.Inventory()
	bootID, _ := host.BootID()
	signerPin, _ := config.DecodePin(cfg.JoinSigningKeyPin)
	state, err := agent.Join(ctx, agent.JoinOptions{
		Client: client, Token: s.token, EncryptionKey: s.encKey, SignerPin: signerPin,
		Claims:  agent.Claims(inv, "sim-"+filepath.Base(cfg.DataDir), bootID),
		Version: version, DataDir: cfg.DataDir, Log: log,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("join: %w", err)
	}
	s.joined.Add(1)
	log.Info("simulated node joined", "node", state.NodeID)
	return agent.LoadState(cfg.DataDir)
}
