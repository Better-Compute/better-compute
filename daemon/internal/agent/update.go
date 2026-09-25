package agent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
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

// UpdateOptions enable self-update. Without them the daemon section is reported SectionUnsupported
// and daemon.upgrade UNSUPPORTED.
type UpdateOptions struct {
	Slots selfupdate.Slots
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

// updater is the self-update state of this process.
type updater struct {
	// stage serializes staging and swapping (the converger and daemon.upgrade).
	stage sync.Mutex

	mu sync.Mutex
	// awaiting is the update this binary was started by, until a Welcome confirms it.
	awaiting *selfupdate.Pending
	timer    *time.Timer
	// failed is the update the process before this one rolled back (its command fails).
	failed *selfupdate.Pending
}

// checkUpgrade reads upgrade.json at start: a new binary waits for its Welcome (and swaps back
// when none comes by the deadline); the old binary back in its slot records the version as failed.
func (a *Agent) checkUpgrade() {
	u := a.o.Update
	if u == nil {
		return
	}
	p, err := selfupdate.LoadPending(a.o.DataDir)
	if err != nil {
		a.log.Error("self-update: unreadable upgrade record", "error", err.Error())
		_ = selfupdate.ClearPending(a.o.DataDir)
		return
	}
	if p == nil {
		return
	}
	running := selfupdate.Bare(a.o.Version)
	switch {
	case p.State == selfupdate.StateSwapped && running == p.Version:
		wait := time.Until(p.Deadline)
		if wait <= 0 {
			a.rollBack(p, fmt.Sprintf("bcd %s was not welcomed by a gateway before its deadline", p.Version))
			return
		}
		a.upd.mu.Lock()
		a.upd.awaiting = p
		a.upd.timer = time.AfterFunc(wait, func() {
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
	case running == p.FromVersion:
		// Back on the old binary: swapped back by the new one, by bcd-rollback.service or by hand.
		reason := p.Reason
		if p.State != selfupdate.StateRolledBack || reason == "" {
			reason = fmt.Sprintf("bcd %s did not start", p.Version)
		}
		rec := selfupdate.LoadRecord(a.o.DataDir)
		if rec.Failed == nil {
			rec.Failed = map[string]string{}
		}
		rec.Failed[p.Version] = reason
		if err := selfupdate.SaveRecord(a.o.DataDir, rec); err != nil {
			a.log.Error("self-update: record the failed version", "error", err.Error())
		}
		p.Reason = reason
		a.upd.mu.Lock()
		a.upd.failed = p
		a.upd.mu.Unlock()
		_ = selfupdate.ClearPending(a.o.DataDir)
		a.log.Warn("self-update failed; running the previous version", "version", p.Version, "running", running, "reason", reason)
	default:
		a.log.Warn("self-update: the upgrade record names neither this version nor the previous one; dropped",
			"version", p.Version, "from", p.FromVersion, "running", running)
		_ = selfupdate.ClearPending(a.o.DataDir)
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
	rec := selfupdate.LoadRecord(a.o.DataDir)
	if p.Sequence > rec.Sequence {
		rec.Sequence = p.Sequence
	}
	if err := selfupdate.SaveRecord(a.o.DataDir, rec); err != nil {
		a.log.Error("self-update: record the release", "error", err.Error())
	}
	if err := selfupdate.ClearPending(a.o.DataDir); err != nil {
		a.log.Error("self-update: clear the upgrade record", "error", err.Error())
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

// rollBack points current back at the old slot and restarts into it.
func (a *Agent) rollBack(p *selfupdate.Pending, reason string) {
	u := a.o.Update
	a.upd.stage.Lock()
	defer a.upd.stage.Unlock()
	p.State = selfupdate.StateRolledBack
	p.Reason = reason
	if err := selfupdate.SavePending(a.o.DataDir, p); err != nil {
		a.log.Error("self-update: record the rollback", "error", err.Error())
	}
	// Back to the old slot, and no previous: a later crash loop must not reinstate the failed binary.
	if err := u.Slots.Revert(p.From); err != nil {
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

// updateError is a self-update refusal; terminal ones are not retried.
type updateError struct {
	msg      string
	terminal bool
}

func (e *updateError) Error() string { return e.msg }

func refuse(format string, args ...any) error {
	return &updateError{msg: fmt.Sprintf(format, args...), terminal: true}
}

// prepareUpgrade verifies the target and stages it in the other slot. The caller holds upd.stage.
func (a *Agent) prepareUpgrade(ctx context.Context, sec *agentv1.DaemonSection) (*selfupdate.Pending, error) {
	u := a.o.Update
	target := selfupdate.Bare(sec.GetVersion())
	running := selfupdate.Bare(a.o.Version)
	rec := selfupdate.LoadRecord(a.o.DataDir)
	if why, failed := rec.Failed[target]; failed {
		return nil, refuse("bcd %s did not start; running %s (%s)", target, running, why)
	}
	if len(sec.GetSha256()) != 32 {
		return nil, refuse("the daemon section's sha256 must be 32 bytes")
	}
	if err := u.Slots.Adopt(u.Executable, running); err != nil {
		return nil, &updateError{msg: "adopt the running binary: " + err.Error()}
	}
	if u.InstallUnits != nil {
		units, err := selfupdate.RollbackUnits(a.o.DataDir, u.Slots)
		if err == nil {
			err = u.InstallUnits(units)
		}
		if err != nil {
			a.log.Warn("self-update: no crash-loop rollback unit", "error", err.Error())
		}
	}
	cur, err := u.Slots.Current()
	if err != nil {
		return nil, &updateError{msg: err.Error()}
	}
	next := selfupdate.Other(cur)
	p := &selfupdate.Pending{Version: target, FromVersion: running, From: cur, To: next}
	if selfupdate.Bare(u.Slots.Versions()[next]) == target && u.Slots.Holds(next, sec.GetSha256()) {
		return p, nil // the binary that ran here before (a rollout rolled back)
	}
	if len(u.Pins) == 0 {
		return nil, refuse("no release keys are pinned ([update] release_pins): bcd takes no binary on the control plane's word")
	}
	if len(sec.GetSignature()) == 0 {
		return nil, refuse("the daemon section carries no signed release manifest")
	}
	m, err := pki.VerifyReleaseManifest(sec.GetSignature(), u.Pins, max(u.Threshold, 1))
	if err != nil {
		return nil, refuse("%v", err)
	}
	switch {
	case m.Product != "bcd":
		return nil, refuse("the manifest releases %s, not bcd", m.Product)
	case selfupdate.Bare(m.Version) != target:
		return nil, refuse("the manifest releases bcd %s, not %s", m.Version, target)
	case m.Sequence < max(rec.Sequence, u.Sequence):
		return nil, refuse("release sequence %d is older than %d, which this node ran or was installed at (rollback)", m.Sequence, max(rec.Sequence, u.Sequence))
	case max(rec.Sequence, u.Sequence) == 0 && selfupdate.Older(target, running):
		// Without a known floor (a build without an embedded sequence), never below its own version.
		return nil, refuse("bcd %s is older than the running %s (rollback)", target, running)
	case !time.Now().Before(m.Expires()) || !a.serverNow().Before(m.Expires()):
		// Either clock past the expiry: neither the gateway nor the host clock alone can revive it.
		return nil, refuse("the release manifest expired at %s", m.Expires().UTC().Format(time.RFC3339))
	}
	art, ok := m.Artifact(u.Platform, sec.GetSha256())
	// The bare binary only (goreleaser's bcd_<version>_<os>_<arch>): pointed at an archive or an SBOM
	// the swap could only fail, and the version would be blocked.
	if want := "bcd_" + target + "_" + strings.ReplaceAll(u.Platform, "-", "_"); !ok || art.Name != want {
		return nil, refuse("the manifest lists no %s with the section's sha256", want)
	}
	src, err := url.Parse(sec.GetUrl())
	if err != nil || src.Host == "" || src.User != nil || !(src.Scheme == "https" || (u.AllowHTTP && src.Scheme == "http")) {
		return nil, refuse("the daemon section's url must be https://")
	}
	if err := a.download(ctx, src.String(), art, sec.GetSha256(), target, u); err != nil {
		return nil, &updateError{msg: "download bcd " + target + ": " + err.Error()}
	}
	p.Sequence = m.Sequence
	return p, nil
}

// download writes the binary into the other slot, checked against the manifest's size and digest.
func (a *Agent) download(ctx context.Context, rawURL string, art pki.ReleaseArtifact, sum []byte, version string, u *UpdateOptions) error {
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
	if art.Size > selfupdate.MaxBinaryBytes {
		return fmt.Errorf("the binary is %d bytes; at most %d are taken", art.Size, selfupdate.MaxBinaryBytes)
	}
	_, err = u.Slots.Stage(progressReader{resp.Body, watch}, art.Size, sum, version)
	return err
}

// swapTo records the update and swaps: upgrade.json first (fsynced), then current, then a restart.
func (a *Agent) swapTo(p *selfupdate.Pending) error {
	u := a.o.Update
	p.State = selfupdate.StateSwapped
	p.Deadline = time.Now().Add(u.deadline())
	if err := selfupdate.SavePending(a.o.DataDir, p); err != nil {
		return err
	}
	if err := u.Slots.Swap(p.To); err != nil {
		_ = selfupdate.ClearPending(a.o.DataDir)
		return err
	}
	a.log.Warn("self-update: restarting into the new binary", "version", p.Version, "from", p.FromVersion, "slot", p.To)
	a.requestRestart()
	return nil
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
	p, err := a.prepareUpgrade(ctx, sec)
	if err != nil {
		return journal.Result{}, &KindError{Code: "update-failed", Message: err.Error()}
	}
	p.CommandID = cmd.ID
	if err := a.markRunning(cmd.ID); err != nil {
		return journal.Result{}, err
	}
	a.flush(2 * time.Second)
	if err := a.swapTo(p); err != nil {
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
			p, err := a.prepareUpgrade(ctx, sec)
			if err != nil {
				var ue *updateError
				if errors.As(err, &ue) && ue.terminal {
					return converge.Terminal(err)
				}
				return err
			}
			if err := a.swapTo(p); err != nil {
				return err
			}
			return fmt.Errorf("restarting into bcd %s", target)
		},
	}}, nil
}
