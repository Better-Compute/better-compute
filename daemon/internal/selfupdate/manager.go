package selfupdate

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/pki"
)

// Manager is the privileged half of self-update: the binary slots, the upgrade record
// (upgrade.json) and the release record (update.json: the floor and the versions that failed). A
// node without bcd helper runs one in process; under bcd helper the helper does, so the slots and
// the records are root's and the unprivileged node cannot rewrite them. Every decision that matters
// (the manifest, the floor, the digest) is taken here, whatever the caller claims.
type Manager struct {
	Slots Slots
	// StateDir holds upgrade.json and update.json.
	StateDir string
	// StagingDir is where the node downloads a release (<data_dir>/staging): the manager reads
	// bcd-<version> from it and re-hashes it as it copies.
	StagingDir string
	// Executable is adopted into slot a on the first update (the install script's binary).
	Executable string
	// SelfVersion is the version of the process running the manager (the helper's own, or the
	// agent's): the running version before the first adoption. After it, slots.json says; what a
	// node claims (Target.Running) is never trusted under the helper.
	SelfVersion string
	// StagedUID, when set, is the only owner a staged binary may have (the node's uid).
	StagedUID *uint32
	// Pins and Threshold are the release keys; Platform the os-arch this host takes.
	Pins      [][]byte
	Threshold int
	Platform  string
	// Sequence is the release this node was installed at (embedded or configured).
	Sequence int64
	// InstallUnits writes the crash-loop rollback units (nil: not under systemd).
	InstallUnits func(units map[string]string) error
	// Deadline is how long a new binary has to be welcomed (default Deadline).
	Deadline time.Duration
	// Now is the clock (default time.Now).
	Now func() time.Time
	// Log reports what the manager does (optional).
	Log func(msg string, args ...any)

	mu sync.Mutex
}

// Target is the release a node asks for.
type Target struct {
	Version string `json:"version"`
	Sha256  []byte `json:"sha256"`
	// Manifest is the signed release manifest (DaemonSection.signature).
	Manifest []byte `json:"manifest,omitempty"`
	// Running is the version the node says it runs: used only by a manager without SelfVersion
	// (the in-process one, whose own version it is); the helper reads its slots instead.
	Running string `json:"running"`
	// CommandID is the daemon.upgrade command, if any.
	CommandID string `json:"commandId,omitempty"`
	// ServerTime is the node's server clock: it can only make the expiry check stricter.
	ServerTime time.Time `json:"serverTime,omitempty"`
}

// Refusal is a terminal refusal: retrying the same target cannot succeed.
type Refusal struct{ Msg string }

func (r *Refusal) Error() string { return r.Msg }

func refuse(format string, args ...any) error {
	return &Refusal{Msg: fmt.Sprintf(format, args...)}
}

// Status is what a node reads back: the pending update, the release record and the slots.
type Status struct {
	Pending  *Pending          `json:"pending,omitempty"`
	Record   Record            `json:"record"`
	Current  string            `json:"current,omitempty"`
	Versions map[string]string `json:"versions,omitempty"`
}

// Settlement tells a starting process what its start means for a pending update.
type Settlement struct {
	// Action is "none", "await" (a new binary waiting for its Welcome), "failed" (the old binary
	// back: Pending.Reason says why) or "restart" (the deadline passed; swapped back).
	Action  string   `json:"action"`
	Pending *Pending `json:"pending,omitempty"`
}

var versionName = regexp.MustCompile(`^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,64})?$`)

func (m *Manager) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

func (m *Manager) deadline() time.Duration {
	if m.Deadline > 0 {
		return m.Deadline
	}
	return Deadline
}

func (m *Manager) logf(msg string, args ...any) {
	if m.Log != nil {
		m.Log(msg, args...)
	}
}

// Status reads the records and the slots.
func (m *Manager) Status() (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, err := LoadPending(m.StateDir)
	if err != nil {
		return Status{}, err
	}
	cur, _ := m.Slots.Current()
	return Status{Pending: p, Record: LoadRecord(m.StateDir), Current: cur, Versions: m.Slots.Versions()}, nil
}

// Prepare checks a target before anything is downloaded, and returns the artifact to download, or
// nil when the other slot already holds the target (a rollout rolled back to the binary that ran
// here before: its digest is checked instead of a manifest).
func (m *Manager) Prepare(t Target) (*pki.ReleaseArtifact, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.prepareLocked(t)
}

// running is the version that runs now: the current slot's record, else this process's own.
func (m *Manager) running(t Target) string {
	if cur, err := m.Slots.Current(); err == nil && cur != "" {
		if v := m.Slots.Infos()[cur].Version; v != "" {
			return Bare(v)
		}
	}
	if m.SelfVersion != "" {
		return Bare(m.SelfVersion)
	}
	return Bare(t.Running)
}

// floor is the lowest release sequence taken: the highest this node ran or was installed at.
func (m *Manager) floor() int64 {
	return max(LoadRecord(m.StateDir).Sequence, m.Sequence)
}

func (m *Manager) prepareLocked(t Target) (*pki.ReleaseArtifact, error) {
	target, running := Bare(t.Version), m.running(t)
	if !versionName.MatchString(target) {
		return nil, refuse("%q is not a release version", t.Version)
	}
	rec := LoadRecord(m.StateDir)
	if why, failed := rec.Failed[target]; failed {
		return nil, refuse("bcd %s did not start; running %s (%s)", target, running, why)
	}
	if len(t.Sha256) != 32 {
		return nil, refuse("the release sha256 must be 32 bytes")
	}
	// The other slot may already hold the target (swapped away from, and back to). Without a manifest
	// that is taken only for a release whose recorded sequence meets the floor: a binary the node
	// once ran is never a way below it (review 11 H1).
	if cur, err := m.Slots.Current(); err == nil && cur != "" {
		next := Other(cur)
		info := m.Slots.Infos()[next]
		if Bare(info.Version) == target && info.Sequence > 0 && info.Sequence >= m.floor() && m.Slots.Holds(next, t.Sha256) {
			return nil, nil
		}
	}
	if len(m.Pins) == 0 {
		return nil, refuse("no release keys are pinned ([update] release_pins): bcd takes no binary on the control plane's word")
	}
	if len(t.Manifest) == 0 {
		return nil, refuse("no signed release manifest")
	}
	man, err := pki.VerifyReleaseManifest(t.Manifest, m.Pins, max(m.Threshold, 1))
	if err != nil {
		return nil, refuse("%v", err)
	}
	floor := m.floor()
	now := m.now()
	if t.ServerTime.After(now) {
		now = t.ServerTime // a later clock can only refuse more
	}
	switch {
	case man.Product != "bcd":
		return nil, refuse("the manifest releases %s, not bcd", man.Product)
	case Bare(man.Version) != target:
		return nil, refuse("the manifest releases bcd %s, not %s", man.Version, target)
	case man.Sequence < floor:
		return nil, refuse("release sequence %d is older than %d, which this node ran or was installed at (rollback)", man.Sequence, floor)
	case floor == 0 && Older(target, running):
		return nil, refuse("bcd %s is older than the running %s (rollback)", target, running)
	case !now.Before(man.Expires()):
		return nil, refuse("the release manifest expired at %s", man.Expires().UTC().Format(time.RFC3339))
	}
	art, ok := man.Artifact(m.Platform, t.Sha256)
	if want := "bcd_" + target + "_" + strings.ReplaceAll(m.Platform, "-", "_"); !ok || art.Name != want {
		return nil, refuse("the manifest lists no %s with the release sha256", want)
	}
	if art.Size > MaxBinaryBytes {
		return nil, refuse("the binary is %d bytes; at most %d are taken", art.Size, MaxBinaryBytes)
	}
	return &art, nil
}

// StagedPath is where the node downloads version.
func (m *Manager) StagedPath(version string) string {
	return filepath.Join(m.StagingDir, "bcd-"+Bare(version))
}

// Swap verifies the target again, copies the staged binary into the other slot (its size and
// SHA-256 checked while it is written, so what is checked is what runs), records upgrade.json and
// points current at it. The caller restarts into the entrypoint.
func (m *Manager) Swap(t Target) (*Pending, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, err := LoadPending(m.StateDir); err == nil && p != nil && p.State == StateSwapped {
		return nil, fmt.Errorf("an update to %s is already pending", p.Version)
	}
	art, err := m.prepareLocked(t)
	if err != nil {
		return nil, err
	}
	target := Bare(t.Version)
	// The entrypoint's binary (installed, or put back by an install script) is this very release
	// when the manager runs in the helper: label it with the helper's own version.
	adopted := m.SelfVersion
	if adopted == "" {
		adopted = m.running(t)
	}
	if err := m.Slots.Adopt(m.Executable, Bare(adopted), m.Sequence); err != nil {
		return nil, fmt.Errorf("adopt the running binary: %w", err)
	}
	running := m.running(t)
	if m.InstallUnits != nil {
		units, err := RollbackUnits(m.StateDir, m.Slots)
		if err == nil {
			err = m.InstallUnits(units)
		}
		if err != nil {
			m.logf("self-update: no crash-loop rollback unit", "error", err.Error())
		}
	}
	cur, err := m.Slots.Current()
	if err != nil {
		return nil, err
	}
	p := &Pending{Version: target, FromVersion: running, From: cur, To: Other(cur), CommandID: t.CommandID}
	if art == nil {
		p.Sequence = m.Slots.Infos()[p.To].Sequence
	} else {
		man, err := pki.VerifyReleaseManifest(t.Manifest, m.Pins, max(m.Threshold, 1))
		if err != nil {
			return nil, refuse("%v", err)
		}
		p.Sequence = man.Sequence
		// Beneath the staging directory's parent, no symlink, no FIFO (O_NONBLOCK), a regular file
		// with one link owned by the node: the node owns the staging directory.
		f, err := openStaged(m.StagingDir, "bcd-"+target, m.StagedUID)
		if err != nil {
			return nil, fmt.Errorf("the staged binary: %w", err)
		}
		_, err = m.Slots.Stage(f, art.Size, t.Sha256, target, man.Sequence)
		f.Close()
		if err != nil {
			return nil, err
		}
	}
	p.State = StateSwapped
	p.Deadline = m.now().Add(m.deadline())
	if err := SavePending(m.StateDir, p); err != nil {
		return nil, err
	}
	if err := m.Slots.Swap(p.To); err != nil {
		_ = ClearPending(m.StateDir)
		return nil, err
	}
	m.logf("self-update: swapped", "version", p.Version, "from", p.FromVersion, "slot", p.To)
	return p, nil
}

// Confirm records a welcomed update: the floor moves up and upgrade.json goes.
func (m *Manager) Confirm(version string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, err := LoadPending(m.StateDir)
	if err != nil {
		return err
	}
	if p == nil || p.State != StateSwapped || p.Version != Bare(version) {
		return errors.New("no swap to that version is pending")
	}
	if cur, _ := m.Slots.Current(); cur != p.To {
		return errors.New("the pending version is not the current slot")
	}
	rec := LoadRecord(m.StateDir)
	if p.Sequence > rec.Sequence {
		rec.Sequence = p.Sequence
	}
	if err := SaveRecord(m.StateDir, rec); err != nil {
		return err
	}
	m.logf("self-update: confirmed", "version", p.Version)
	return ClearPending(m.StateDir)
}

// RollBack swaps back from a pending update to version (no Welcome by its deadline) and drops
// previous, so a later crash loop cannot reinstate it. The caller restarts into the entrypoint.
func (m *Manager) RollBack(version, reason string) (*Pending, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rollBackLocked(version, reason)
}

func (m *Manager) rollBackLocked(version, reason string) (*Pending, error) {
	p, err := LoadPending(m.StateDir)
	if err != nil {
		return nil, err
	}
	if p == nil || p.State != StateSwapped || p.Version != Bare(version) {
		return nil, errors.New("no swap to that version is pending")
	}
	if len(reason) > 500 {
		reason = reason[:500]
	}
	p.State, p.Reason = StateRolledBack, reason
	if err := SavePending(m.StateDir, p); err != nil {
		return nil, err
	}
	if err := m.Slots.Revert(p.From); err != nil {
		return nil, err
	}
	m.logf("self-update: swapped back", "version", p.Version, "to", p.FromVersion, "reason", reason)
	return p, nil
}

// Settle is a process start: where current points decides, never what the process claims (review
// 11 M2). Current on the new slot: the new binary awaits its Welcome (past the deadline it is
// swapped back: "restart"). Current back on the old slot (swapped back by the new binary, the
// helper, bcd-rollback.service or by hand): the version is recorded as failed.
func (m *Manager) Settle(_ string) (Settlement, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, err := LoadPending(m.StateDir)
	if err != nil {
		_ = ClearPending(m.StateDir)
		return Settlement{Action: "none"}, err
	}
	if p == nil {
		return Settlement{Action: "none"}, nil
	}
	cur, _ := m.Slots.Current()
	switch {
	case p.State == StateSwapped && cur == p.To:
		if !m.now().Before(p.Deadline) {
			rolled, err := m.rollBackLocked(p.Version, fmt.Sprintf("bcd %s was not welcomed by a gateway before its deadline", p.Version))
			if err != nil {
				return Settlement{Action: "none"}, err
			}
			return Settlement{Action: "restart", Pending: rolled}, nil
		}
		return Settlement{Action: "await", Pending: p}, nil
	case cur == p.From:
		reason := p.Reason
		if p.State != StateRolledBack || reason == "" {
			reason = fmt.Sprintf("bcd %s did not start", p.Version)
		}
		rec := LoadRecord(m.StateDir)
		if rec.Failed == nil {
			rec.Failed = map[string]string{}
		}
		rec.Failed[p.Version] = reason
		if err := SaveRecord(m.StateDir, rec); err != nil {
			return Settlement{Action: "none"}, err
		}
		p.Reason = reason
		_ = ClearPending(m.StateDir)
		return Settlement{Action: "failed", Pending: p}, nil
	}
	_ = ClearPending(m.StateDir)
	return Settlement{Action: "none"}, nil
}

// ClearFailed forgets the versions that failed (bcd update --clear-failed).
func (m *Manager) ClearFailed() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec := LoadRecord(m.StateDir)
	rec.Failed = nil
	return SaveRecord(m.StateDir, rec)
}

// Expire swaps back a pending update whose deadline passed without a Confirm (the helper's own
// watchdog, independent of the node). It reports whether it did.
func (m *Manager) Expire() (*Pending, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, err := LoadPending(m.StateDir)
	if err != nil || p == nil || p.State != StateSwapped || m.now().Before(p.Deadline) {
		return nil, false
	}
	rolled, err := m.rollBackLocked(p.Version, fmt.Sprintf("bcd %s was not welcomed by a gateway before its deadline", p.Version))
	return rolled, err == nil
}
