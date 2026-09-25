// Package helper is bcd's privilege separation (PLAN.md §6, v0.4): `bcd node` runs unprivileged
// and asks `bcd helper`, running as root beside it, for a few typed operations over a unix socket.
// The helper trusts nothing the node sends:
//
//   - the peer is checked with SO_PEERCRED (uid and gid) and by its executable (/proc/<pid>/exe must
//     be an installed bcd binary);
//   - requests are versioned JSON, strictly decoded (an unknown field or version fails closed, so
//     a node and helper of different versions during a self-update refuse rather than guess);
//   - files are named by kind and id, never by path: the helper builds the path from a fixed table,
//     refuses symlinks on the way down, and caps the size;
//   - an nftables ruleset must keep every statement inside bcd's table; a GPU reset names a GPU
//     the host has; a reboot reason is truncated;
//   - every operation is logged.
package helper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Version is the node ↔ helper protocol version.
const Version = 1

// MaxRequest bounds a request; MaxFile a written file.
const (
	MaxRequest = 4 << 20
	MaxFile    = 1 << 20
)

// DefaultSocket is where the helper listens.
const DefaultSocket = "/run/bcd/helper.sock"

// Request is one operation.
type Request struct {
	V  int    `json:"v"`
	Op string `json:"op"`
	// file.write / file.remove: the kind of file (FileKinds) and its id.
	Kind string `json:"kind,omitempty"`
	Name string `json:"name,omitempty"`
	Data []byte `json:"data,omitempty"`
	// reboot
	Reason string `json:"reason,omitempty"`
	// gpu.reset
	GPU string `json:"gpu,omitempty"`
	// firewall.apply / firewall.check
	Ruleset string `json:"ruleset,omitempty"`
	Rules   int    `json:"rules,omitempty"`
}

// Response is the helper's answer.
type Response struct {
	V     int    `json:"v"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// fileKind is one kind of file bcd node owns: its directory, how an id names a file in it (or the
// one fixed file), and its mode.
type fileKind struct {
	dir  string
	name *regexp.Regexp
	file func(id string) string
	mode os.FileMode
}

// FileKinds are the files the helper writes and removes, by kind.
var FileKinds = map[string]fileKind{
	"cdi":            {dir: "/etc/cdi", name: regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`), file: func(id string) string { return "bcd-" + id + ".json" }, mode: 0o644},
	"allocation-env": {dir: "/run/bcd/allocations", name: regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`), file: func(id string) string { return id + ".env" }, mode: 0o644},
	"ssh-dropin":     {dir: "/etc/ssh/sshd_config.d", file: func(string) string { return "10-better-compute.conf" }, mode: 0o644},
	"ssh-ca":         {dir: "/etc/ssh", file: func(string) string { return "bc_ca.pub" }, mode: 0o644},
	"ssh-krl":        {dir: "/etc/ssh", file: func(string) string { return "bc_krl" }, mode: 0o644},
	"ssh-principals": {dir: "/etc/ssh/bc_principals", name: regexp.MustCompile(`^[A-Za-z0-9._@-]{1,64}$`), file: func(id string) string { return id }, mode: 0o644},
}

// Classify maps a path bcd node writes to its file kind and id (the node's side of the table).
func Classify(abs string) (kind, name string, ok bool) {
	for k, fk := range FileKinds {
		dir, base := filepath.ToSlash(filepath.Dir(abs)), filepath.Base(abs)
		if dir != fk.dir {
			continue
		}
		if fk.name == nil {
			if base == fk.file("") {
				return k, "", true
			}
			continue
		}
		for _, id := range []string{strings.TrimSuffix(strings.TrimPrefix(base, "bcd-"), ".json"), strings.TrimSuffix(base, ".env"), base} {
			if fk.name.MatchString(id) && fk.file(id) == base {
				return k, id, true
			}
		}
	}
	return "", "", false
}

var gpuUUID = regexp.MustCompile(`^GPU-[0-9A-Fa-f-]{8,64}$`)

// firewallTable is the only table a ruleset may name.
const firewallTable = "bridge bcd_instances"

// CheckRuleset accepts only the shape bcd node renders (agent/netpolicy.go): at the top level,
// "table", "delete table" and "flush table" of bcd's table and "table … {" blocks of it; inside a
// block, chains and rules, which cannot reach another table. No include, define or ruleset verbs.
func CheckRuleset(ruleset string) error {
	own := "table " + firewallTable
	depth := 0
	for _, line := range strings.Split(ruleset, "\n") {
		l := strings.TrimSpace(line)
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		lower := strings.ToLower(l)
		if strings.HasPrefix(lower, "include") || strings.Contains(lower, "ruleset") || strings.HasPrefix(lower, "define") {
			return fmt.Errorf("ruleset line %q reaches beyond bcd's table", l)
		}
		if depth == 0 {
			switch l {
			case own, "delete " + own, "flush " + own, own + " {":
			default:
				return fmt.Errorf("ruleset line %q is not bcd's table", l)
			}
		} else if strings.HasPrefix(lower, "table ") {
			return fmt.Errorf("ruleset line %q nests a table", l)
		}
		depth += strings.Count(l, "{") - strings.Count(l, "}")
		if depth < 0 {
			return errors.New("unbalanced braces in the ruleset")
		}
	}
	if depth != 0 {
		return errors.New("unbalanced braces in the ruleset")
	}
	return nil
}

// Ops performs the privileged work once a request passed every check.
type Ops interface {
	Reboot(reason string) error
	ResetGPU(ctx context.Context, uuid string) error
	ApplyFirewall(ctx context.Context, ruleset string) error
	CheckFirewall(ctx context.Context, rules int) error
	ReloadSSH() error
}

// Peer is who connected: the kernel's credentials for the socket.
type Peer struct {
	PID      int32
	UID, GID uint32
}

// Server serves one socket.
type Server struct {
	Ops Ops
	// Root prefixes the files' paths ("" or "/": the real filesystem; tests set a directory).
	Root string
	// Allowed decides a peer: its uid and gid, and its executable (/proc/<pid>/exe).
	Allowed func(p Peer) error
	// KnownGPU reports whether the host has a GPU (gpu.reset names only those).
	KnownGPU func(uuid string) bool
	// Log records every operation and refusal.
	Log func(msg string, args ...any)
}

// Serve accepts connections on l until ctx is done.
func (s *Server) Serve(ctx context.Context, l *net.UnixListener) error {
	go func() {
		<-ctx.Done()
		_ = l.Close()
	}()
	for {
		conn, err := l.AcceptUnix()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go s.handle(ctx, conn)
	}
}

func (s *Server) logf(msg string, args ...any) {
	if s.Log != nil {
		s.Log(msg, args...)
	}
}

func (s *Server) handle(ctx context.Context, conn *net.UnixConn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
	answer := func(err error) {
		resp := Response{V: Version, OK: err == nil}
		if err != nil {
			resp.Error = err.Error()
		}
		_ = json.NewEncoder(conn).Encode(resp)
	}
	peer, err := peerCred(conn)
	if err == nil {
		if s.Allowed == nil {
			err = errors.New("no peer policy")
		} else {
			err = s.Allowed(peer)
		}
	}
	if err != nil {
		s.logf("helper: connection refused", "pid", peer.PID, "uid", peer.UID, "reason", err.Error())
		answer(errors.New("not allowed"))
		return
	}
	dec := json.NewDecoder(io.LimitReader(conn, MaxRequest))
	dec.DisallowUnknownFields()
	var req Request
	if err := dec.Decode(&req); err != nil {
		s.logf("helper: malformed request", "pid", peer.PID, "error", err.Error())
		answer(errors.New("malformed request"))
		return
	}
	if req.V != Version {
		s.logf("helper: request of another protocol version", "pid", peer.PID, "v", req.V)
		answer(fmt.Errorf("protocol version %d; this helper speaks %d", req.V, Version))
		return
	}
	err = s.do(ctx, req)
	outcome := "ok"
	if err != nil {
		outcome = err.Error()
	}
	s.logf("helper: operation", "pid", peer.PID, "op", req.Op, "kind", req.Kind, "name", req.Name, "gpu", req.GPU, "outcome", outcome)
	answer(err)
}

func (s *Server) do(ctx context.Context, req Request) error {
	switch req.Op {
	case "file.write", "file.remove":
		fk, ok := FileKinds[req.Kind]
		if !ok {
			return fmt.Errorf("%q is not a kind of file bcd owns", req.Kind)
		}
		if fk.name != nil && !fk.name.MatchString(req.Name) {
			return fmt.Errorf("%q is not a %s name", req.Name, req.Kind)
		}
		if fk.name == nil && req.Name != "" {
			return fmt.Errorf("%s takes no name", req.Kind)
		}
		if req.Op == "file.remove" {
			return s.remove(fk, fk.file(req.Name))
		}
		if len(req.Data) > MaxFile {
			return fmt.Errorf("%d bytes; at most %d are written", len(req.Data), MaxFile)
		}
		return s.write(fk, fk.file(req.Name), req.Data)
	case "reboot":
		reason := req.Reason
		if len(reason) > 200 {
			reason = reason[:200]
		}
		return s.Ops.Reboot(reason)
	case "gpu.reset":
		if !gpuUUID.MatchString(req.GPU) || s.KnownGPU == nil || !s.KnownGPU(req.GPU) {
			return fmt.Errorf("%q is not a GPU of this host", req.GPU)
		}
		return s.Ops.ResetGPU(ctx, req.GPU)
	case "firewall.apply":
		if err := CheckRuleset(req.Ruleset); err != nil {
			return err
		}
		return s.Ops.ApplyFirewall(ctx, req.Ruleset)
	case "firewall.check":
		if req.Rules < 0 || req.Rules > 1_000_000 {
			return errors.New("bad rule count")
		}
		return s.Ops.CheckFirewall(ctx, req.Rules)
	case "ssh.reload":
		return s.Ops.ReloadSSH()
	}
	return fmt.Errorf("unknown operation %q", req.Op)
}

// openDir opens a kind's directory, creating it, with no symlink anywhere on the way down.
func (s *Server) openDir(fk fileKind) (*os.Root, error) {
	base := s.Root
	if base == "" {
		base = "/"
	}
	root, err := os.OpenRoot(base)
	if err != nil {
		return nil, err
	}
	rel := strings.TrimPrefix(fk.dir, "/")
	walked := ""
	for _, part := range strings.Split(rel, "/") {
		walked = filepath.Join(walked, part)
		fi, err := root.Lstat(walked)
		if errors.Is(err, fs.ErrNotExist) {
			if err := root.Mkdir(walked, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
				root.Close()
				return nil, err
			}
			continue
		}
		if err != nil {
			root.Close()
			return nil, err
		}
		if fi.Mode()&fs.ModeSymlink != 0 || !fi.IsDir() {
			root.Close()
			return nil, fmt.Errorf("%s is not a plain directory", "/"+walked)
		}
	}
	dir, err := root.OpenRoot(rel)
	root.Close()
	return dir, err
}

// write replaces a file atomically: a temporary created exclusively in its directory, renamed over
// whatever is there (a symlink is replaced, never followed).
func (s *Server) write(fk fileKind, name string, data []byte) error {
	dir, err := s.openDir(fk)
	if err != nil {
		return err
	}
	defer dir.Close()
	tmp := "." + name + ".bcd-helper"
	_ = dir.Remove(tmp)
	f, err := dir.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fk.mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(fk.mode); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return dir.Rename(tmp, name)
}

func (s *Server) remove(fk fileKind, name string) error {
	dir, err := s.openDir(fk)
	if err != nil {
		return err
	}
	defer dir.Close()
	if err := dir.Remove(name); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// Client talks to the helper.
type Client struct {
	Socket  string
	Timeout time.Duration
}

// Do sends one request and waits for its answer.
func (c Client) Do(ctx context.Context, req Request) error {
	req.V = Version
	timeout := c.Timeout
	if timeout == 0 {
		timeout = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", c.Socket)
	if err != nil {
		return fmt.Errorf("helper: %w", err)
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return fmt.Errorf("helper: %w", err)
	}
	dec := json.NewDecoder(io.LimitReader(conn, 1<<16))
	dec.DisallowUnknownFields()
	var resp Response
	if err := dec.Decode(&resp); err != nil {
		return fmt.Errorf("helper: %w", err)
	}
	if resp.V != Version {
		return fmt.Errorf("helper: protocol version %d, not %d", resp.V, Version)
	}
	if !resp.OK {
		return fmt.Errorf("helper: %s", resp.Error)
	}
	return nil
}

// WriteFile writes a file bcd node owns, named by its path (classified into kind and id).
func (c Client) WriteFile(ctx context.Context, abs string, data []byte) error {
	kind, name, ok := Classify(abs)
	if !ok {
		return fmt.Errorf("helper: %s is not a file the helper writes", abs)
	}
	return c.Do(ctx, Request{Op: "file.write", Kind: kind, Name: name, Data: data})
}

// RemoveFile removes a file bcd node owns.
func (c Client) RemoveFile(ctx context.Context, abs string) error {
	kind, name, ok := Classify(abs)
	if !ok {
		return fmt.Errorf("helper: %s is not a file the helper removes", abs)
	}
	return c.Do(ctx, Request{Op: "file.remove", Kind: kind, Name: name})
}
