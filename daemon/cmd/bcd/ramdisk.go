package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/bootparams"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/pki"
)

func ramdiskFlags(fs *flag.FlagSet) {
	fs.String("cmdline", "/proc/cmdline", "the kernel command line with the bc.* boot parameters")
	fs.String("data-dir", "/run/bcd", "where the ramdisk keeps its key, identity and journal (tmpfs)")
}

// ramdiskConfig turns boot parameters into the configuration a node reads from config.toml.
func ramdiskConfig(p bootparams.Params, dataDir string) (*config.Config, error) {
	cfg := config.Defaults()
	cfg.GatewayURL = p.Gateway
	cfg.GatewayServerName = p.ServerName
	cfg.Site = p.Site
	cfg.ServingCASPKIPin = p.ServingCAPin
	cfg.JoinSigningKeyPin = p.JoinSigningPin
	cfg.JoinEncryptionKeyPin = p.JoinEncryptionPin
	cfg.DataDir = dataDir
	cfg.SocketPath = filepath.ToSlash(filepath.Join(dataDir, "bcd.sock"))
	cfg.ImageCache = p.Cache
	if strings.HasPrefix(p.Gateway, "http://") {
		if !devBuild {
			return nil, errors.New("an http:// gateway is only accepted by fakehw development builds")
		}
		cfg.DevInsecureH2C = true
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// runRamdisk is the PXE ramdisk's agent (PLAN.md §3.5): it reads its boot parameters, joins with the
// discovery token the site agent served and the assertion it signed (a restricted certificate of
// at most 2 h, commissioning kinds only), then runs the agent with role ramdisk. Its state lives in
// tmpfs: every boot of the ramdisk is a new identity and a new journal.
func runRamdisk(fs *flag.FlagSet, _, stderr io.Writer) int {
	raw, err := os.ReadFile(fs.Lookup("cmdline").Value.String())
	if err != nil {
		fmt.Fprintf(stderr, "bcd ramdisk: %v\n", err)
		return exitFailure
	}
	params, err := bootparams.Parse(string(raw))
	if err != nil {
		fmt.Fprintf(stderr, "bcd ramdisk: %v\n", err)
		return exitUsage
	}
	cfg, err := ramdiskConfig(params, fs.Lookup("data-dir").Value.String())
	if err != nil {
		fmt.Fprintf(stderr, "bcd ramdisk: %v\n", err)
		return exitUsage
	}
	cfg.Log.JSON = true
	log := newLogger(cfg, stderr)
	if _, _, err := agent.LoadState(cfg.DataDir); errors.Is(err, agent.ErrNotJoined) {
		encKey, err := pki.ParseJWK(params.JWK)
		if err != nil {
			fmt.Fprintf(stderr, "bcd ramdisk: bc.jwk: %v\n", err)
			return exitFailure
		}
		encPin, _ := config.DecodePin(cfg.JoinEncryptionKeyPin)
		if !pki.MatchesPin(encKey, encPin) {
			fmt.Fprintln(stderr, "bcd ramdisk: bc.jwk does not match the join encryption pin")
			return exitFailure
		}
		signerPin, _ := config.DecodePin(cfg.JoinSigningKeyPin)
		host, err := newHost(cfg.DataDir)
		if err != nil {
			fmt.Fprintf(stderr, "bcd ramdisk: %v\n", err)
			return exitFailure
		}
		inv, err := host.Inventory()
		if err != nil {
			log.Warn("inventory unavailable; joining without hardware claims", "error", err.Error())
		}
		bootID, _ := host.BootID()
		client, err := newClient(cfg, nil, nil)
		if err != nil {
			fmt.Fprintf(stderr, "bcd ramdisk: %v\n", err)
			return exitFailure
		}
		ctx, cancel := signalContext()
		state, err := agent.Join(ctx, agent.JoinOptions{
			Client:        client,
			Token:         params.Token,
			EncryptionKey: encKey,
			SignerPin:     signerPin,
			Role:          commonv1.AgentRole_AGENT_ROLE_RAMDISK,
			Attestor:      "discovery",
			Attestation:   params.Assertion,
			Claims:        agent.Claims(inv, host.Hostname(), bootID),
			Version:       version,
			DataDir:       cfg.DataDir,
			Log:           log,
		})
		cancel()
		client.Close()
		if err != nil {
			fmt.Fprintf(stderr, "bcd ramdisk: join: %v\n", err)
			return exitFailure
		}
		log.Info("ramdisk joined", "node", state.NodeID, "site", state.SiteID, "notAfter", state.NotAfter)
	} else if err != nil {
		fmt.Fprintf(stderr, "bcd ramdisk: %v\n", err)
		return exitFailure
	}
	cfg.InstallFiles = map[string][]byte{
		"/etc/bcd/config.toml":         []byte(config.Render(cfg)),
		"/etc/bcd/join-encryption.jwk": params.JWK,
	}
	return runAgent("ramdisk", cfg, log, stderr, nil)
}
