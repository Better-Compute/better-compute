package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/selfupdate"
)

// restartInto is set by an agent whose self-update swapped the binary slots (agent.ErrRestart):
// main execs it, with the same arguments, once everything is closed.
var restartInto string

// systemdUnits is where the rollback units go.
const systemdUnits = "/etc/systemd/system"

// updateManager is self-update's privileged half for this configuration: in process for a node
// without bcd helper, or in the helper (root's slots and records under update.slots_dir).
func updateManager(cfg *config.Config, log func(string, ...any)) (*selfupdate.Manager, error) {
	pins, err := cfg.Update.Pins()
	if err != nil {
		return nil, err
	}
	embedded, _ := strconv.ParseInt(releaseSequence, 10, 64)
	slots, state := cfg.UpdateDirs()
	exe := cfg.Update.Entrypoint
	if self, err := os.Executable(); err == nil && cfg.Helper.Socket == "" {
		exe = self
	}
	return &selfupdate.Manager{
		Slots:        selfupdate.Slots{Dir: slots, Entrypoint: cfg.Update.Entrypoint},
		StateDir:     state,
		StagingDir:   filepath.Join(cfg.DataDir, "staging"),
		Executable:   exe,
		SelfVersion:  version,
		Pins:         pins,
		Threshold:    int(cfg.Update.ReleaseThreshold),
		Platform:     runtime.GOOS + "-" + runtime.GOARCH,
		Sequence:     max(embedded, cfg.Update.ReleaseSequence),
		InstallUnits: installUnits,
		Log:          log,
	}, nil
}

// updateOptions is self-update for bcd node and bcd site ([update]; PLAN.md §6 "Self-update"): the
// manager in process, or, under bcd helper, the helper's (the node only downloads and restarts).
func updateOptions(cfg *config.Config, log *slog.Logger) (*agent.UpdateOptions, error) {
	o := &agent.UpdateOptions{
		Slots:     selfupdate.Slots{Entrypoint: cfg.Update.Entrypoint},
		Platform:  runtime.GOOS + "-" + runtime.GOARCH,
		AllowHTTP: cfg.DevInsecureH2C || devBuild, // the manifest's digest is checked either way
	}
	if cfg.Helper.Socket != "" {
		o.Backend = helper.UpdateClient{Client: helper.Client{Socket: cfg.Helper.Socket}, StagingDir: filepath.Join(cfg.DataDir, "staging")}
		return o, nil
	}
	m, err := updateManager(cfg, func(msg string, args ...any) { log.Info(msg, args...) })
	if err != nil {
		return nil, err
	}
	o.Backend = m
	return o, nil
}

// installUnits writes bcd-rollback.service and its bcd.service drop-in and reloads systemd. A fakehw
// build never touches the host's systemd.
func installUnits(units map[string]string) error {
	if devBuild {
		return nil
	}
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return errors.New("bcd does not run under systemd; a crash-looping update is not rolled back")
	}
	changed := false
	for name, content := range units {
		path := filepath.Join(systemdUnits, name)
		if have, err := os.ReadFile(path); err == nil && string(have) == content {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := pki.WriteFileAtomic(path, []byte(content), 0o644); err != nil {
			return err
		}
		changed = true
	}
	if !changed {
		return nil
	}
	if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %v: %s", err, out)
	}
	return nil
}

func updateFlags(fs *flag.FlagSet) {
	fs.String("config", config.DefaultPath, "configuration file written by the install script")
	fs.Bool("clear-failed", false, "forget the versions that failed to start, so a rollout may try them again")
}

// runUpdate shows the self-update state (slots, the release floor, failed versions), and with
// --clear-failed forgets the failed versions: a local decision, never the control plane's.
func runUpdate(fs *flag.FlagSet, stdout, stderr io.Writer) int {
	cfg, _, err := loadConfig(fs)
	if err != nil {
		fmt.Fprintf(stderr, "bcd update: %v\n", err)
		return exitFailure
	}
	slotsDir, stateDir := cfg.UpdateDirs()
	rec := selfupdate.LoadRecord(stateDir)
	if fs.Lookup("clear-failed").Value.String() == "true" {
		rec.Failed = nil
		if err := selfupdate.SaveRecord(stateDir, rec); err != nil {
			fmt.Fprintf(stderr, "bcd update: %v\n", err)
			return exitFailure
		}
		fmt.Fprintln(stdout, "failed versions cleared")
	}
	slots := selfupdate.Slots{Dir: slotsDir, Entrypoint: cfg.Update.Entrypoint}
	current, _ := slots.Current()
	embedded, _ := strconv.ParseInt(releaseSequence, 10, 64)
	pins, _ := cfg.Update.Pins()
	fmt.Fprintf(stdout, "version %s, release floor %d, %d release pins (threshold %d)\n", version,
		max(rec.Sequence, embedded, cfg.Update.ReleaseSequence), len(pins), cfg.Update.ReleaseThreshold)
	if current == "" {
		fmt.Fprintln(stdout, "slots: not in use yet (the first update adopts "+cfg.Update.Entrypoint+")")
	} else {
		v := slots.Versions()
		fmt.Fprintf(stdout, "slots: current %s (%s), other %s (%s)\n", current, v[current], selfupdate.Other(current), v[selfupdate.Other(current)])
	}
	if p, _ := selfupdate.LoadPending(stateDir); p != nil {
		fmt.Fprintf(stdout, "pending: %s -> %s, %s\n", p.FromVersion, p.Version, p.State)
	}
	failed := make([]string, 0, len(rec.Failed))
	for v := range rec.Failed {
		failed = append(failed, v)
	}
	sort.Strings(failed)
	for _, v := range failed {
		fmt.Fprintf(stdout, "failed: %s (%s)\n", v, rec.Failed[v])
	}
	return exitOK
}
