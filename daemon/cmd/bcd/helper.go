package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strconv"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/helper"
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

// listenHelper opens the socket: 0660, group the node's, in a 0755 directory.
func listenHelper(socket string, gid int) (*net.UnixListener, error) {
	if err := os.MkdirAll(filepath.Dir(socket), 0o755); err != nil {
		return nil, err
	}
	if err := os.Remove(socket); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		return nil, err
	}
	ln.SetUnlinkOnClose(true)
	if err := os.Chmod(socket, 0o660); err != nil {
		ln.Close()
		return nil, err
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(socket, 0, gid); err != nil {
			ln.Close()
			return nil, err
		}
	}
	return ln, nil
}

// installedBinary reports whether a process runs an installed bcd: the entrypoint's target, a
// self-update slot, or this very binary.
func installedBinary(cfg *config.Config, pid int32) error {
	exe, err := os.Stat(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return fmt.Errorf("the peer's executable: %w", err)
	}
	candidates := []string{cfg.Update.Entrypoint, filepath.Join(cfg.DataDir, "bin", "bcd-a"), filepath.Join(cfg.DataDir, "bin", "bcd-b")}
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
