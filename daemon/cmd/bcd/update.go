package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/selfupdate"
)

// restartInto is set by an agent whose self-update swapped the binary slots (agent.ErrRestart):
// main execs it, with the same arguments, once everything is closed.
var restartInto string

// systemdUnits is where the rollback units go.
const systemdUnits = "/etc/systemd/system"

// updateOptions is self-update for bcd node and bcd site ([update]; PLAN.md §6 "Self-update").
func updateOptions(cfg *config.Config) (*agent.UpdateOptions, error) {
	pins, err := cfg.Update.Pins()
	if err != nil {
		return nil, err
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return &agent.UpdateOptions{
		Slots:        selfupdate.Slots{Dir: filepath.Join(cfg.DataDir, "bin"), Entrypoint: cfg.Update.Entrypoint},
		Executable:   exe,
		Pins:         pins,
		Threshold:    int(cfg.Update.ReleaseThreshold),
		Platform:     runtime.GOOS + "-" + runtime.GOARCH,
		AllowHTTP:    cfg.DevInsecureH2C,
		InstallUnits: installUnits,
	}, nil
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
