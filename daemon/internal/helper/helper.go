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
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/selfupdate"
	"github.com/better-compute/better-compute/daemon/internal/slice"
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
	// update.prepare / update.swap
	Target *selfupdate.Target `json:"target,omitempty"`
	// update.confirm / update.rollback
	Version string `json:"version,omitempty"`
	// update.settle
	Running string `json:"running,omitempty"`
	// host.unit: a config unit of NodeSpec.host and its settings (absent: the unit left the spec, and
	// what it wrote is cleaned); GPUsBusy are the GPUs holding allocations (mig-layout skips them).
	// slice.apply / slice.remove: a GPU hold's slice (PLAN.md §3.8) and its limits.
	Slice    string          `json:"slice,omitempty"`
	Limits   *slice.Limits   `json:"limits,omitempty"`
	Unit     string          `json:"unit,omitempty"`
	Settings json.RawMessage `json:"settings,omitempty"`
	GPUsBusy []string        `json:"gpusBusy,omitempty"`
}

// Response is the helper's answer.
type Response struct {
	V     int    `json:"v"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	// Refused marks a terminal refusal (selfupdate.Refusal): the same request cannot succeed.
	Refused bool `json:"refused,omitempty"`
	// Result is the operation's answer (update.*), JSON.
	Result json.RawMessage `json:"result,omitempty"`
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
	// The node stages a kubeadm bootstrap token for host.unit k8s-join (kube.TokenFile); root-only.
	// Root's directory (hostconfig.StateDir), never one the node can write.
	"k8s-token": {dir: "/var/lib/bcd-hostconfig/k8s", file: func(string) string { return "bootstrap-token" }, mode: 0o600},
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

// firewallTables are the only tables a ruleset may name: the instances' bridge rules and the inet
// and arp backstops for taps off their bridge.
var firewallTables = []string{"bridge bcd_instances", "inet bcd_taps", "arp bcd_taps"}

// CheckRuleset accepts only the shape bcd node renders (agent/netpolicy.go): at the top level,
// "table", "delete table" and "flush table" of bcd's tables and "table … {" blocks of them; inside a
// block, chains and rules, which cannot reach another table. No include, define or ruleset verbs.
func CheckRuleset(ruleset string) error {
	allowed := map[string]bool{}
	for _, t := range firewallTables {
		own := "table " + t
		allowed[own], allowed["delete "+own], allowed["flush "+own], allowed[own+" {"] = true, true, true, true
	}
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
			if !allowed[l] {
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
	// Update is self-update's privileged half (update.*); nil refuses them.
	Update *selfupdate.Manager
	// OnSwap runs after a swap (the helper arms its own deadline watchdog).
	OnSwap func(p *selfupdate.Pending)
	// HostUnits builds the config units host.unit applies, as root, against HostSystem; nil refuses
	// host.unit. The units validate their settings themselves (hostconfig), exactly as in bcd node.
	HostUnits  func(hostconfig.Options) *hostconfig.Registry
	HostSystem hostconfig.System
	// SliceRunner runs systemctl for slice.apply and slice.remove (default: the real one).
	SliceRunner slice.Runner
}

// SliceTimeout bounds slice.apply and slice.remove (a few systemctl calls).
const SliceTimeout = 30 * time.Second

// ExecRunner runs a command, its output in the error.
func ExecRunner(ctx context.Context, name string, args ...string) error {
	if out, err := exec.CommandContext(ctx, name, args...).CombinedOutput(); err != nil {
		return fmt.Errorf("%s: %v: %s", name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// holdSlice applies or removes a hold's slice, as root, after slice.Check: only bcd-alloc-<id>.slice
// names and cpulists get to systemctl and cgroupfs.
func (s *Server) holdSlice(ctx context.Context, req Request) error {
	run := s.SliceRunner
	if run == nil {
		run = ExecRunner
	}
	ctx, cancel := context.WithTimeout(ctx, SliceTimeout)
	defer cancel()
	if req.Op == "slice.remove" {
		return slice.Remove(ctx, run, s.Root, req.Slice)
	}
	if req.Limits == nil {
		return errors.New("slice.apply needs limits")
	}
	return slice.Apply(ctx, run, s.Root, req.Slice, *req.Limits)
}

// HostUnitTimeout bounds host.unit: a driver install builds kernel modules.
const HostUnitTimeout = 30 * time.Minute

var unitName = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)

// hostUnit plans one unit again, as root, and applies it.
func (s *Server) hostUnit(ctx context.Context, req Request) error {
	if s.HostUnits == nil || s.HostSystem == nil {
		return errors.New("host config units are not configured on this helper")
	}
	if !unitName.MatchString(req.Unit) {
		return fmt.Errorf("%q is not a config unit name", req.Unit)
	}
	if len(req.GPUsBusy) > 1024 {
		return errors.New("too many busy GPUs")
	}
	busy := make(map[string]bool, len(req.GPUsBusy))
	for _, g := range req.GPUsBusy {
		busy[g] = true
	}
	r := s.HostUnits(hostconfig.Options{GPUBusy: func(uuid string) bool { return busy[uuid] }})
	ctx, cancel := context.WithTimeout(ctx, HostUnitTimeout)
	defer cancel()
	steps, err := r.PlanUnit(ctx, s.HostSystem, req.Unit, req.Settings)
	if err != nil {
		return err
	}
	for _, step := range steps {
		if err := step.Apply(ctx); err != nil {
			return fmt.Errorf("%s: %w", step.Description, err)
		}
	}
	return nil
}

// Serve accepts connections on l until ctx is done.
func (s *Server) Serve(ctx context.Context, l *net.UnixListener) error {
	go func() {
		<-ctx.Done()
		_ = l.Close()
	}()
	// At most maxConns requests at once: a peer cannot pile up goroutines and descriptors.
	slots := make(chan struct{}, maxConns)
	for {
		conn, err := l.AcceptUnix()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		select {
		case slots <- struct{}{}:
		default:
			// Over the cap: a retryable answer, not a bare EOF.
			_ = conn.SetDeadline(time.Now().Add(time.Second))
			_ = json.NewEncoder(conn).Encode(Response{V: Version, Error: "busy: the helper is serving its maximum of requests; retry"})
			_ = conn.Close()
			continue
		}
		go func() {
			defer func() { <-slots }()
			s.handle(ctx, conn)
		}()
	}
}

// maxConns bounds the requests the helper serves at once.
const maxConns = 32

func (s *Server) logf(msg string, args ...any) {
	if s.Log != nil {
		s.Log(msg, args...)
	}
}

func (s *Server) handle(ctx context.Context, conn *net.UnixConn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
	answer := func(result any, err error) {
		resp := Response{V: Version, OK: err == nil}
		if err != nil {
			resp.Error = err.Error()
			var r *selfupdate.Refusal
			resp.Refused = errors.As(err, &r)
		} else if result != nil {
			resp.Result, _ = json.Marshal(result)
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
		answer(nil, errors.New("not allowed"))
		return
	}
	dec := json.NewDecoder(io.LimitReader(conn, MaxRequest))
	dec.DisallowUnknownFields()
	var req Request
	if err := dec.Decode(&req); err != nil {
		s.logf("helper: malformed request", "pid", peer.PID, "error", err.Error())
		answer(nil, errors.New("malformed request"))
		return
	}
	if req.V != Version {
		s.logf("helper: request of another protocol version", "pid", peer.PID, "v", req.V)
		answer(nil, fmt.Errorf("protocol version %d; this helper speaks %d", req.V, Version))
		return
	}
	if req.Op == "host.unit" {
		_ = conn.SetDeadline(time.Now().Add(HostUnitTimeout + time.Minute))
	}
	result, err := s.do(ctx, req)
	outcome := "ok"
	if err != nil {
		outcome = err.Error()
	}
	s.logf("helper: operation", "pid", peer.PID, "op", req.Op, "kind", req.Kind, "name", req.Name, "gpu", req.GPU, "version", req.Version, "unit", req.Unit, "outcome", outcome)
	answer(result, err)
}

func (s *Server) do(ctx context.Context, req Request) (any, error) {
	if strings.HasPrefix(req.Op, "update.") {
		return s.update(req)
	}
	return nil, s.op(ctx, req)
}

// update serves self-update: every check (manifest, floor, digest) is the manager's, never the
// node's; the node names a version and hands the signed manifest.
func (s *Server) update(req Request) (any, error) {
	m := s.Update
	if m == nil {
		return nil, errors.New("self-update is not configured on this helper")
	}
	switch req.Op {
	case "update.status":
		return m.Status()
	case "update.prepare":
		if req.Target == nil {
			return nil, errors.New("no target")
		}
		return m.Prepare(*req.Target)
	case "update.swap":
		if req.Target == nil {
			return nil, errors.New("no target")
		}
		p, err := m.Swap(*req.Target)
		if err == nil && s.OnSwap != nil {
			s.OnSwap(p)
		}
		return p, err
	case "update.confirm":
		return nil, m.Confirm(req.Version)
	case "update.rollback":
		return m.RollBack(req.Version, req.Reason)
	case "update.settle":
		return m.Settle(req.Running)
	}
	return nil, fmt.Errorf("unknown operation %q", req.Op)
}

func (s *Server) op(ctx context.Context, req Request) error {
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
	case "host.unit":
		return s.hostUnit(ctx, req)
	case "slice.apply", "slice.remove":
		return s.holdSlice(ctx, req)
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
	_, err := c.Call(ctx, req)
	return err
}

// Call sends one request and returns its result.
func (c Client) Call(ctx context.Context, req Request) (json.RawMessage, error) {
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
		return nil, fmt.Errorf("helper: %w", err)
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return nil, fmt.Errorf("helper: %w", err)
	}
	dec := json.NewDecoder(io.LimitReader(conn, 1<<20))
	dec.DisallowUnknownFields()
	var resp Response
	if err := dec.Decode(&resp); err != nil {
		return nil, fmt.Errorf("helper: %w", err)
	}
	if resp.V != Version {
		return nil, fmt.Errorf("helper: protocol version %d, not %d", resp.V, Version)
	}
	if !resp.OK {
		if resp.Refused {
			return nil, &selfupdate.Refusal{Msg: resp.Error}
		}
		return nil, fmt.Errorf("helper: %s", resp.Error)
	}
	return resp.Result, nil
}

// UpdateClient is self-update through the helper (agent.UpdateBackend): the node downloads into
// StagingDir, the helper verifies and swaps.
type UpdateClient struct {
	Client
	StagingDir string
}

func (u UpdateClient) call(req Request, out any) error {
	raw, err := u.Call(context.Background(), req)
	if err != nil || out == nil || len(raw) == 0 || string(raw) == "null" {
		return err
	}
	return json.Unmarshal(raw, out)
}

// StagedPath is where the node downloads version (the helper reads the same path itself).
func (u UpdateClient) StagedPath(version string) string {
	return filepath.Join(u.StagingDir, "bcd-"+selfupdate.Bare(version))
}

// Prepare asks the helper to check a target before the download.
func (u UpdateClient) Prepare(t selfupdate.Target) (*pki.ReleaseArtifact, error) {
	var art *pki.ReleaseArtifact
	return art, u.call(Request{Op: "update.prepare", Target: &t}, &art)
}

// Swap asks the helper to verify the staged release and swap to it.
func (u UpdateClient) Swap(t selfupdate.Target) (*selfupdate.Pending, error) {
	var p *selfupdate.Pending
	return p, u.call(Request{Op: "update.swap", Target: &t}, &p)
}

// Confirm reports the new binary welcomed.
func (u UpdateClient) Confirm(version string) error {
	return u.call(Request{Op: "update.confirm", Version: version}, nil)
}

// RollBack swaps back from version.
func (u UpdateClient) RollBack(version, reason string) (*selfupdate.Pending, error) {
	var p *selfupdate.Pending
	return p, u.call(Request{Op: "update.rollback", Version: version, Reason: reason}, &p)
}

// Settle reports the process start.
func (u UpdateClient) Settle(running string) (selfupdate.Settlement, error) {
	var s selfupdate.Settlement
	return s, u.call(Request{Op: "update.settle", Running: running}, &s)
}

// HostUnit asks the helper to apply a config unit (settings nil: clean it), sparing busy GPUs.
func (c Client) HostUnit(ctx context.Context, unit string, settings json.RawMessage, gpusBusy []string) error {
	c.Timeout = HostUnitTimeout + time.Minute
	return c.Do(ctx, Request{Op: "host.unit", Unit: unit, Settings: settings, GPUsBusy: gpusBusy})
}

// ApplySlice asks the helper to create or update a hold's slice with its limits.
func (c Client) ApplySlice(ctx context.Context, name string, limits slice.Limits) error {
	return c.Do(ctx, Request{Op: "slice.apply", Slice: name, Limits: &limits})
}

// RemoveSlice asks the helper to stop a hold's slice once it is empty (slice.ErrBusy's text if not).
func (c Client) RemoveSlice(ctx context.Context, name string) error {
	return c.Do(ctx, Request{Op: "slice.remove", Slice: name})
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
