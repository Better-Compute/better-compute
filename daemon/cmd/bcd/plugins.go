package main

import (
	"bufio"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/bcx"
)

// pinLine is one line of the plugins' pins file (sha256sum format): "<sha256 hex>  <file name>".
var pinLine = regexp.MustCompile(`^([0-9a-f]{64}) [ *]([A-Za-z0-9._-]+)$`)

// startPlugins runs the bcx driver plugins of dir (PLAN.md §5.5): every plugin named in dir/pins,
// each only if its binary's sha256 is its pin. A plugin that fails to start is logged and skipped.
// dir and pins are root-owned, like config.toml.
func startPlugins(ctx context.Context, dir string, log *slog.Logger) []*bcx.Plugin {
	if dir == "" {
		return nil
	}
	f, err := os.Open(filepath.Join(dir, "pins"))
	if err != nil {
		log.Warn("no plugin pins; no plugin runs", "dir", dir, "error", err.Error())
		return nil
	}
	defer f.Close()
	var plugins []*bcx.Plugin
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		m := pinLine.FindStringSubmatch(line)
		if m == nil {
			log.Warn("unreadable plugin pin line", "line", line)
			continue
		}
		name := m[2]
		p, err := bcx.Start(ctx, name, filepath.Join(dir, name), bcx.StartOptions{Sha256: m[1], Stderr: os.Stderr})
		if err != nil {
			log.Error("plugin did not start", "plugin", name, "error", err.Error())
			continue
		}
		ids := make([]string, 0, len(p.Drivers))
		for _, d := range p.Drivers {
			ids = append(ids, d.GetId())
		}
		log.Info("plugin started", "plugin", name, "version", p.Version, "drivers", strings.Join(ids, ","))
		plugins = append(plugins, p)
	}
	return plugins
}
