package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/converge"
	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/selfupdate"
	"google.golang.org/protobuf/proto"
)

// Self-update (PLAN.md §6 "Self-update", v0.4): NodeSpec.daemon names the version bcd should run,
// and daemon.upgrade carries the same DaemonSection to a session restricted to upgrades
// (Welcome.upgrade_required). DaemonSection.signature is the release's signed manifest
// (manifest.json, @better-compute/pki signReleaseManifest): at least Threshold of the pinned release
// keys must have signed it, it must be bcd's, for the section's version, not older than the release
// this node already ran (sequence) and not expired, and it must list the section's SHA-256 for this
// platform. Nothing but the pins is trusted: a control plane cannot hand a node a binary no release
// key signed. The download is checked against the manifest's size and digest while it is written.
//
// Going back to the version in the other slot (a rollout rolled back) needs no manifest: that
// binary ran here before, and its digest must still be the section's.

// ErrRestart is returned by Run after a self-update swapped the binary slots (or swapped them back):
// the caller closes everything and execs UpdateOptions.Slots.Entrypoint with the same arguments.
var ErrRestart = errors.New("agent: restart into the current binary slot")

// UpdateBackend is self-update's privileged half: a selfupdate.Manager in process, or bcd helper's
// (helper.UpdateClient), which takes every decision that matters itself.
type UpdateBackend interface {
	Prepare(t selfupdate.Target) (*pki.ReleaseArtifact, error)
	Swap(t selfupdate.Target) (*selfupdate.Pending, error)
	Confirm(version string) error
	RollBack(version, reason string) (*selfupdate.Pending, error)
	Settle(running string) (selfupdate.Settlement, error)
	StagedPath(version string) string
}

// UpdateOptions enable self-update. Without them the daemon section is reported SectionUnsupported
// and daemon.upgrade UNSUPPORTED.
type UpdateOptions struct {
	// Backend, when set, does the privileged half (bcd helper); otherwise a selfupdate.Manager over
	// the fields below runs in process, with its records in the data directory.
	Backend UpdateBackend
	Slots   selfupdate.Slots
	// Executable is the running binary: the first update adopts it into slot a.
	Executable string
	// Pins are the release keys' SPKI SHA-256 digests; Threshold how many must have signed (>= 1).
	Pins      [][]byte
	Threshold int
	// Platform is the os-arch this build runs as (linux-amd64): the manifest artifact it takes.
	Platform string
	// Sequence is the release sequence this node starts from (the binary's embedded one, or config
	// update.release_sequence): no manifest below it is taken. With none (0, a dev build) no version
	// below the running one is.
	Sequence int64
	// AllowHTTP accepts http:// download URLs (a dev stack); the digest is checked either way.
	AllowHTTP bool
	// InstallUnits writes the rollback units (selfupdate.RollbackUnits) and reloads systemd; nil
	// when bcd does not run under systemd.
	InstallUnits func(units map[string]string) error
	// Deadline is how long a new binary has to be welcomed (default selfupdate.Deadline).
	Deadline time.Duration
}

// backend is the configured backend, or the in-process manager over the options.
func (a *Agent) backend() UpdateBackend {
	u := a.o.Update
	if u.Backend != nil {
		return u.Backend
	}
	a.upd.mu.Lock()
	defer a.upd.mu.Unlock()
	if a.upd.local == nil {
		a.upd.local = &selfupdate.Manager{
			Slots: u.Slots, StateDir: a.o.DataDir, StagingDir: filepath.Join(a.o.DataDir, "staging"),
			Executable: u.Executable, Pins: u.Pins, Threshold: u.Threshold, Platform: u.Platform,
			Sequence: u.Sequence, InstallUnits: u.InstallUnits, Deadline: u.Deadline,
			Log: func(msg string, args ...any) { a.log.Info(msg, args...) },
		}
	}
	return a.upd.local
}

// updater is the self-update state of this process.
type updater struct {
	// stage serializes staging and swapping (the converger and daemon.upgrade).
	stage sync.Mutex

	mu    sync.Mutex
	local *selfupdate.Manager
	// awaiting is the update this binary was started by, until a Welcome confirms it.
	awaiting *selfupdate.Pending
	timer    *time.Timer
	// failed is the update the process before this one rolled back (its command fails).
	failed *selfupdate.Pending
}

// checkUpgrade settles a pending update at start: a new binary waits for its Welcome (and swaps
// back when none comes by the deadline); the old binary back in its slot has the version recorded
// as failed.
func (a *Agent) checkUpgrade() {
	u := a.o.Update
	if u == nil {
		return
	}
	s, err := a.backend().Settle(a.o.Version)
	if err != nil {
		a.log.Error("self-update: settle the upgrade record", "error", err.Error())
	}
	p := s.Pending
	switch s.Action {
	case "await":
		wait := time.Until(p.Deadline)
		a.upd.mu.Lock()
		a.upd.awaiting = p
		a.upd.timer = time.AfterFunc(max(wait, 0), func() {
			a.upd.mu.Lock()
			current := a.upd.awaiting == p
			a.upd.awaiting = nil
			a.upd.mu.Unlock()
			if current {
				a.rollBack(p, fmt.Sprintf("bcd %s was not welcomed by a gateway within %s", p.Version, u.deadline()))
			}
		})
		a.upd.mu.Unlock()
		a.log.Info("self-update: waiting for a Welcome", "version", p.Version, "from", p.FromVersion, "deadline", p.Deadline.Format(time.RFC3339))
	case "failed":
		a.upd.mu.Lock()
		a.upd.failed = p
		a.upd.mu.Unlock()
		a.log.Warn("self-update failed; running the previous version", "version", p.Version, "running", a.o.Version, "reason", p.Reason)
	case "restart":
		a.log.Warn("self-update: not welcomed before the deadline; swapped back", "version", p.Version)
		a.requestRestart()
	}
}

func (u *UpdateOptions) deadline() time.Duration {
	if u.Deadline > 0 {
		return u.Deadline
	}
	return selfupdate.Deadline
}

// confirmUpgrade runs on every Welcome: the first one confirms the update this binary was started
// by (the release floor moves up, upgrade.json goes, and a daemon.upgrade command succeeds).
func (a *Agent) confirmUpgrade() {
	a.upd.mu.Lock()
	p := a.upd.awaiting
	a.upd.awaiting = nil
	if a.upd.timer != nil {
		a.upd.timer.Stop()
	}
	a.upd.mu.Unlock()
	if p == nil {
		return
	}
	if err := a.backend().Confirm(p.Version); err != nil {
		a.log.Error("self-update: confirm", "error", err.Error())
	}
	a.log.Info("self-update confirmed", "version", p.Version, "from", p.FromVersion)
	if p.CommandID == "" {
		return
	}
	r := journal.Result{Outcome: journal.OutcomeSucceeded, BootID: a.bootID}
	a.mu.Lock()
	defer a.mu.Unlock()
	if c, ok, err := a.j.Command(p.CommandID); err != nil || !ok || c.State == journal.StateDone {
		return
	}
	if err := journal.Complete(a.j, p.CommandID, r, time.Now()); err != nil {
		a.log.Error("journal: complete", "id", p.CommandID, "error", err.Error())
		return
	}
	a.sendLocked(updateFrame(a.updateOf(p.CommandID, r)))
}

// restartedResult is journal.Runtime.Restarted: daemon.upgrade completes through upgrade.json.
func (a *Agent) restartedResult(c journal.Command) (*journal.Result, bool) {
	if c.Kind != "daemon.upgrade" {
		return nil, false
	}
	a.upd.mu.Lock()
	defer a.upd.mu.Unlock()
	if p := a.upd.awaiting; p != nil && p.CommandID == c.ID {
		return nil, true
	}
	if p := a.upd.failed; p != nil && p.CommandID == c.ID {
		return &journal.Result{Outcome: journal.OutcomeFailed, Reason: "update-failed", Message: p.Reason}, true
	}
	return nil, false
}

// rollBack swaps back to the old slot and restarts into it.
func (a *Agent) rollBack(p *selfupdate.Pending, reason string) {
	a.upd.stage.Lock()
	defer a.upd.stage.Unlock()
	if _, err := a.backend().RollBack(p.Version, reason); err != nil {
		a.log.Error("self-update: swap back", "error", err.Error())
		return
	}
	a.log.Warn("self-update: swapping back", "version", p.Version, "to", p.FromVersion, "reason", reason)
	a.requestRestart()
}

// requestRestart ends Run with ErrRestart.
func (a *Agent) requestRestart() {
	a.restarting.Store(true)
	if a.stop != nil {
		a.stop()
	}
}

// terminal reports a refusal no retry can fix.
func terminal(err error) bool {
	var r *selfupdate.Refusal
	return errors.As(err, &r)
}

// upgradeTo verifies and stages sec's release and swaps to it (then restarts). The node downloads;
// the backend checks the manifest, the floor and the digest itself and swaps. beforeSwap runs just
// before the swap (daemon.upgrade marks itself running). The caller holds upd.stage.
func (a *Agent) upgradeTo(ctx context.Context, sec *agentv1.DaemonSection, commandID string, beforeSwap func() error) error {
	u := a.o.Update
	b := a.backend()
	t := selfupdate.Target{
		Version: selfupdate.Bare(sec.GetVersion()), Sha256: sec.GetSha256(), Manifest: sec.GetSignature(),
		Running: selfupdate.Bare(a.o.Version), CommandID: commandID, ServerTime: a.serverNow(),
	}
	art, err := b.Prepare(t)
	if err != nil {
		return err
	}
	if art != nil {
		src, err := url.Parse(sec.GetUrl())
		if err != nil || src.Host == "" || src.User != nil || !(src.Scheme == "https" || (u.AllowHTTP && src.Scheme == "http")) {
			return &selfupdate.Refusal{Msg: "the daemon section's url must be https://"}
		}
		staged := b.StagedPath(t.Version)
		defer os.Remove(staged)
		if err := a.download(ctx, src.String(), *art, sec.GetSha256(), staged, u); err != nil {
			return fmt.Errorf("download bcd %s: %w", t.Version, err)
		}
	}
	if beforeSwap != nil {
		if err := beforeSwap(); err != nil {
			return err
		}
	}
	p, err := b.Swap(t)
	if err != nil {
		return err
	}
	a.log.Warn("self-update: restarting into the new binary", "version", p.Version, "from", p.FromVersion, "slot", p.To)
	a.requestRestart()
	return nil
}

// download writes the binary to staged (the node's staging directory), checked against the
// manifest's size and digest; the backend checks it again as it copies it into a slot.
func (a *Agent) download(ctx context.Context, rawURL string, art pki.ReleaseArtifact, sum []byte, staged string, u *UpdateOptions) error {
	ctx, watch, stop := withProgress(ctx, transferIdle, transferMinBytes, transferMax)
	defer stop()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	client := *a.imageClient()
	if !u.AllowHTTP {
		client.CheckRedirect = httpsOnly
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET returned %s", resp.Status)
	}
	if err := os.MkdirAll(filepath.Dir(staged), 0o755); err != nil {
		return err
	}
	tmp := staged + ".part"
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(progressReader{resp.Body, watch}, art.Size+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if n != art.Size || !bytes.Equal(h.Sum(nil), sum) {
		return fmt.Errorf("the download is not the release (%d bytes, sha256 %x)", n, h.Sum(nil))
	}
	return os.Rename(tmp, staged)
}

// runDaemonUpgrade is daemon.upgrade: self-terminating, it completes once the new binary is
// welcomed (or fails after it is swapped back).
func (a *Agent) runDaemonUpgrade(ctx context.Context, cmd dispatch.Command) (journal.Result, error) {
	sec := &agentv1.DaemonSection{}
	if err := payloadOf(cmd, sec); err != nil {
		return journal.Result{}, err
	}
	if sec.GetVersion() == "" {
		return journal.Result{}, invalidPayload(errors.New("version is required"))
	}
	if selfupdate.Bare(sec.GetVersion()) == selfupdate.Bare(a.o.Version) {
		return journal.Result{Outcome: journal.OutcomeSucceeded}, nil
	}
	a.upd.stage.Lock()
	defer a.upd.stage.Unlock()
	err := a.upgradeTo(ctx, sec, cmd.ID, func() error {
		if err := a.markRunning(cmd.ID); err != nil {
			return err
		}
		a.flush(2 * time.Second)
		return nil
	})
	if err != nil {
		return journal.Result{}, &KindError{Code: "update-failed", Message: err.Error()}
	}
	<-ctx.Done()
	return journal.Result{}, ctx.Err()
}

// daemonConverger converges NodeSpec.daemon: another version is verified, staged and swapped to.
type daemonConverger struct{ a *Agent }

func (daemonConverger) Section() converge.Section { return converge.SectionDaemon }

func (c daemonConverger) Plan(_ context.Context, desired []byte) ([]converge.Action, error) {
	sec := &agentv1.DaemonSection{}
	if err := proto.Unmarshal(desired, sec); err != nil {
		return nil, converge.Terminal(err)
	}
	a := c.a
	target := selfupdate.Bare(sec.GetVersion())
	if target == "" || target == selfupdate.Bare(a.o.Version) {
		return nil, nil
	}
	return []converge.Action{{
		Description: "update bcd to " + target,
		Apply: func(ctx context.Context) error {
			if !a.upd.stage.TryLock() {
				return errors.New("an update is already in progress")
			}
			defer a.upd.stage.Unlock()
			if err := a.upgradeTo(ctx, sec, "", nil); err != nil {
				if terminal(err) {
					return converge.Terminal(err)
				}
				return err
			}
			return fmt.Errorf("restarting into bcd %s", target)
		},
	}}, nil
}
