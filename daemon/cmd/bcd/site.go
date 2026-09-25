package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/bootparams"
	"github.com/better-compute/better-compute/daemon/internal/config"
)

// runSite is the site agent (PLAN.md §3.5, §8.5): the agent with role site (BMC operations,
// site.httpProxy, boot entries) plus, with [boot] configured, the boot server that answers PXE
// machines while this agent holds the site's boot lease.
func runSite(fs *flag.FlagSet, _, stderr io.Writer) int {
	cfg, file, err := loadConfig(fs)
	if err != nil {
		fmt.Fprintf(stderr, "bcd site: %v\n", err)
		return exitFailure
	}
	log := newLogger(cfg, stderr)
	state, _, err := agent.LoadState(cfg.DataDir)
	if err != nil {
		fmt.Fprintf(stderr, "bcd site: %v\n", err)
		return exitFailure
	}
	if state.Role != "site" {
		fmt.Fprintf(stderr, "bcd site: this data directory holds a %s identity; join with a site token (bcd join --role site)\n", state.Role)
		return exitFailure
	}
	var serve func(ctx context.Context, a *agent.Agent)
	if cfg.Boot.Listen != "" {
		jwk, err := os.ReadFile(filepath.Join(filepath.Dir(file), joinKeyFile))
		if err != nil {
			fmt.Fprintf(stderr, "bcd site: the boot server needs %s: %v\n", joinKeyFile, err)
			return exitFailure
		}
		boot := agent.BootConfig{
			Listen:  cfg.Boot.Listen,
			Kernel:  cfg.Boot.Kernel,
			Initrd:  cfg.Boot.Initrd,
			Cmdline: cfg.Boot.Cmdline,
			Join:    joinParams(cfg, jwk),
		}
		if cfg.Boot.URL != "" {
			boot.Join.Cache = strings.TrimRight(cfg.Boot.URL, "/") + "/cache"
		}
		serve = func(ctx context.Context, a *agent.Agent) {
			if err := a.ServeBoot(ctx, boot); err != nil {
				log.Error("boot server stopped", "error", err.Error())
			}
		}
	} else {
		log.Warn("no [boot] listen configured: this site agent does not serve PXE machines")
	}
	return runAgent("site", cfg, log, stderr, serve)
}

// joinParams are the gateway parameters a ramdisk booted by this site joins with.
func joinParams(cfg *config.Config, jwk []byte) bootparams.Params {
	return bootparams.Params{
		Gateway:           cfg.GatewayURL,
		ServerName:        cfg.GatewayServerName,
		Site:              cfg.Site,
		ServingCAPin:      cfg.ServingCASPKIPin,
		JoinSigningPin:    cfg.JoinSigningKeyPin,
		JoinEncryptionPin: cfg.JoinEncryptionKeyPin,
		JWK:               jwk,
	}
}
