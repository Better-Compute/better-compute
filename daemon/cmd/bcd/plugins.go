package main

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/bcx"
	"github.com/better-compute/better-compute/daemon/internal/config"
)

// pinLine is one line of the plugins' pins file (sha256sum format): "<sha256 hex>  <file name>".
var pinLine = regexp.MustCompile(`^([0-9a-f]{64}) [ *]([A-Za-z0-9._-]+)$`)

// sandboxOptions is how plugins run: as [plugins] user when bcd is root (default nobody), under
// the shim (no new privileges, seccomp) unless [plugins] sandbox = false, in [plugins] cgroup.
func sandboxOptions(c config.Plugins) (bcx.StartOptions, error) {
	o := bcx.StartOptions{CgroupDir: c.Cgroup, MemoryMax: c.MemoryMax, PidsMax: int(c.PidsMax)}
	if c.Sandbox {
		self, err := os.Executable()
		if err != nil {
			return o, err
		}
		o.Shim = self
	}
	if os.Geteuid() == 0 {
		name := c.User
		if name == "" {
			name = "nobody"
		}
		if name != "root" {
			u, err := user.Lookup(name)
			if err != nil {
				return o, fmt.Errorf("plugins.user: %w", err)
			}
			uid, _ := strconv.ParseUint(u.Uid, 10, 32)
			gid, _ := strconv.ParseUint(u.Gid, 10, 32)
			o.Credential = &bcx.Credential{UID: uint32(uid), GID: uint32(gid)}
		}
	}
	return o, nil
}

// startPlugins runs the bcx driver plugins of dir (PLAN.md §5.5): every plugin named in dir/pins,
// each only if its binary's sha256 is its pin, sandboxed as sandboxOptions says. A plugin that fails
// to start is logged and skipped. dir and pins are root-owned, like config.toml.
func startPlugins(ctx context.Context, dir string, sandbox config.Plugins, log *slog.Logger) []*bcx.Plugin {
	if dir == "" {
		return nil
	}
	base, err := sandboxOptions(sandbox)
	if err != nil {
		log.Error("plugins cannot be sandboxed; no plugin runs", "error", err.Error())
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
		o := base
		o.Sha256, o.Stderr = m[1], os.Stderr
		p, err := bcx.Start(ctx, name, filepath.Join(dir, name), o)
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
