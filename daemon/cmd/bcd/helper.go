package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/selfupdate"
)

// runHelper is `bcd helper` (PLAN.md §6, v0.4): as root beside an unprivileged `bcd node`, it serves
// the node's privileged operations on [helper] socket. Only the node's account (or root) running an
// installed bcd binary is served; every operation is checked and logged (internal/helper).
func runHelper(fs *flag.FlagSet, _, stderr io.Writer) int {
	cfg, _, err := loadConfig(fs)
	if err != nil {
		fmt.Fprintf(stderr, "bcd helper: %v\n", err)
		return exitFailure
	}
	if cfg.Helper.Socket == "" {
		fmt.Fprintln(stderr, "bcd helper: [helper] socket and user are not configured")
		return exitFailure
	}
	if os.Geteuid() != 0 && !devBuild {
		fmt.Fprintln(stderr, "bcd helper: runs as root")
		return exitFailure
	}
	log := newLogger(cfg, stderr)
	account, err := user.Lookup(cfg.Helper.User)
	if err != nil {
		fmt.Fprintf(stderr, "bcd helper: helper.user: %v\n", err)
		return exitFailure
	}
	uid, _ := strconv.ParseUint(account.Uid, 10, 32)
	gid, _ := strconv.ParseUint(account.Gid, 10, 32)
	h, err := newHost(cfg.DataDir)
	if err != nil {
		fmt.Fprintf(stderr, "bcd helper: %v\n", err)
		return exitFailure
	}
	host, ok := h.(*agent.RealHost)
	if !ok {
		fmt.Fprintln(stderr, "bcd helper: this build's host cannot serve the helper")
		return exitFailure
	}
	srv := &helper.Server{
		Ops:  host,
		Root: host.Root,
		Allowed: func(p helper.Peer) error {
			if p.UID != 0 && (p.UID != uint32(uid) || p.GID != uint32(gid)) {
				return fmt.Errorf("uid %d gid %d is not %s", p.UID, p.GID, cfg.Helper.User)
			}
			return installedBinary(cfg, p.PID)
		},
		KnownGPU: func(uuid string) bool {
			inv, err := host.Inventory()
			if err != nil || inv.Gpus == nil {
				return false
			}
			for _, g := range inv.Gpus.Gpus {
				if g.Uuid == uuid {
					return true
				}
			}
			return false
		},
		Log: func(msg string, args ...any) { log.Info(msg, args...) },
	}
	// Self-update: root's slots and records; the node downloads, the helper verifies and swaps, and
	// its own watchdog swaps back an update no gateway welcomed, whatever the node does.
	manager, err := updateManager(cfg, func(msg string, args ...any) { log.Info(msg, args...) })
	if err != nil {
		fmt.Fprintf(stderr, "bcd helper: %v\n", err)
		return exitFailure
	}
	u32 := uint32(uid)
	manager.StagedUID = &u32 // only the node's own staged file
	srv.Update = manager
	srv.OnSwap = func(p *selfupdate.Pending) { watchUpdate(manager, p, log) }
	if st, err := manager.Status(); err == nil && st.Pending != nil && st.Pending.State == selfupdate.StateSwapped {
		watchUpdate(manager, st.Pending, log)
	}
	if os.Geteuid() == 0 {
		// Every directory on the way to the slots and to the socket must be root's alone: a path the
		// node could swap for a symlink would steer root's writes (review 11 L1, L2).
		slots, _ := cfg.UpdateDirs()
		for _, p := range []string{slots, filepath.Dir(cfg.Helper.Socket)} {
			if err := rootOnlyPath(p); err != nil {
				fmt.Fprintf(stderr, "bcd helper: %v\n", err)
				return exitFailure
			}
		}
	}
	ln, err := listenHelper(cfg.Helper.Socket, int(gid))
	if err != nil {
		fmt.Fprintf(stderr, "bcd helper: %v\n", err)
		return exitFailure
	}
	defer os.Remove(cfg.Helper.Socket)
	ctx, cancel := signalContext()
	defer cancel()
	log.Info("bcd helper serving", "socket", cfg.Helper.Socket, "user", cfg.Helper.User, "version", version)
	if err := srv.Serve(ctx, ln); err != nil {
		fmt.Fprintf(stderr, "bcd helper: %v\n", err)
		return exitFailure
	}
	return exitOK
}

// listenHelper opens the socket: 0660, group the node's. Root never changes a path the node could
// swap for a symlink: the socket's directory must be root's and closed to others, and the socket
// is bound, chmod'ed and chown'ed inside a private 0700 directory, then renamed into place.
func listenHelper(socket string, gid int) (*net.UnixListener, error) {
	dir := filepath.Dir(socket)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if os.Geteuid() == 0 {
		if err := rootOnlyDir(dir); err != nil {
			return nil, err
		}
	}
	private, err := os.MkdirTemp(dir, ".bcd-helper-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(private)
	bound := filepath.Join(private, "helper.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: bound, Net: "unix"})
	if err != nil {
		return nil, err
	}
	ln.SetUnlinkOnClose(false)
	fail := func(err error) (*net.UnixListener, error) {
		ln.Close()
		return nil, err
	}
	if err := os.Chmod(bound, 0o660); err != nil {
		return fail(err)
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(bound, 0, gid); err != nil {
			return fail(err)
		}
	}
	// Rename replaces a stale socket atomically; nothing is removed by name first.
	if err := os.Rename(bound, socket); err != nil {
		return fail(err)
	}
	return ln, nil
}

// watchUpdate swaps back an update that is still unconfirmed shortly after its deadline, and
// restarts bcd.service into the old binary (the node's own watchdog normally does this first).
func watchUpdate(m *selfupdate.Manager, p *selfupdate.Pending, log *slog.Logger) {
	time.AfterFunc(time.Until(p.Deadline)+30*time.Second, func() {
		rolled, ok := m.Expire()
		if !ok {
			return
		}
		log.Warn("self-update: no Welcome confirmed the new binary; swapped back", "version", rolled.Version, "to", rolled.FromVersion)
		if !devBuild {
			if out, err := exec.Command("systemctl", "restart", "bcd.service").CombinedOutput(); err != nil {
				log.Error("self-update: restart bcd.service", "error", err.Error(), "output", string(out))
			}
		}
	})
}

// installedBinary reports whether a process runs an installed bcd: the entrypoint's target, a
// self-update slot, or this very binary.
func installedBinary(cfg *config.Config, pid int32) error {
	exe, err := os.Stat(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return fmt.Errorf("the peer's executable: %w", err)
	}
	slots, _ := cfg.UpdateDirs()
	candidates := []string{cfg.Update.Entrypoint, filepath.Join(slots, "bcd-a"), filepath.Join(slots, "bcd-b")}
	if self, err := os.Executable(); err == nil {
		candidates = append(candidates, self)
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && os.SameFile(fi, exe) {
			return nil
		}
	}
	return errors.New("the peer does not run an installed bcd binary")
}
