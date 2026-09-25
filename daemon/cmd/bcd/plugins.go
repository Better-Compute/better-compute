package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"hash/fnv"
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

// Plugin uids when [plugins] user is unset: one per plugin in systemd's dynamic-user range.
const (
	pluginUIDBase  = 61184
	pluginUIDCount = 65519 - 61184 + 1
)

// pluginUID is a plugin's own uid (and gid), stable across restarts: derived from its name, moved
// on past any uid another plugin of this host already has.
func pluginUID(name string, taken map[uint32]bool) uint32 {
	h := fnv.New32a()
	h.Write([]byte(name))
	uid := pluginUIDBase + h.Sum32()%pluginUIDCount
	for taken[uid] {
		uid = pluginUIDBase + (uid-pluginUIDBase+1)%pluginUIDCount
	}
	taken[uid] = true
	return uid
}

// privileged reports whether [plugins] privileged names the plugin.
func privileged(c config.Plugins, name string) bool {
	for _, p := range strings.Split(c.Privileged, ",") {
		if p = strings.TrimSpace(p); p != "" && p == name {
			return true
		}
	}
	return false
}

// sandboxOptions is how one plugin runs. A privileged plugin runs as root without the filter.
// Every other one, when bcd is root, runs as [plugins] user or its own uid, and (unless [plugins]
// sandbox = false) under the shim: no new privileges, seccomp. All run in [plugins] cgroup.
func sandboxOptions(c config.Plugins, name string, taken map[uint32]bool) (bcx.StartOptions, error) {
	o := bcx.StartOptions{CgroupDir: c.Cgroup, MemoryMax: c.MemoryMax, PidsMax: int(c.PidsMax)}
	if privileged(c, name) {
		return o, nil
	}
	if c.Sandbox {
		self, err := os.Executable()
		if err != nil {
			return o, err
		}
		o.Shim = self
	}
	if os.Geteuid() != 0 {
		return o, nil
	}
	if c.User == "" {
		uid := pluginUID(name, taken)
		o.Credential = &bcx.Credential{UID: uid, GID: uid}
		return o, nil
	}
	u, err := user.Lookup(c.User)
	if err != nil {
		return o, fmt.Errorf("plugins.user: %w", err)
	}
	uid, _ := strconv.ParseUint(u.Uid, 10, 32)
	gid, _ := strconv.ParseUint(u.Gid, 10, 32)
	if uid == 0 {
		return o, errors.New("plugins.user may not be root; name the plugins that need root in plugins.privileged")
	}
	o.Credential = &bcx.Credential{UID: uint32(uid), GID: uint32(gid)}
	return o, nil
}

// startPlugins runs the bcx driver plugins of dir (PLAN.md §5.5): every plugin named in dir/pins,
// each only if its binary's sha256 is its pin, sandboxed as sandboxOptions says. A plugin that fails
// to start is logged and skipped. dir and pins are root-owned, like config.toml.
func startPlugins(ctx context.Context, dir string, sandbox config.Plugins, log *slog.Logger) []*bcx.Plugin {
	if dir == "" {
		return nil
	}
	taken := map[uint32]bool{}
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
		o, err := sandboxOptions(sandbox, name, taken)
		if err != nil {
			log.Error("plugin cannot be sandboxed; it does not run", "plugin", name, "error", err.Error())
			continue
		}
		if privileged(sandbox, name) {
			log.Warn("privileged plugin: root, no seccomp filter", "plugin", name)
		}
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
