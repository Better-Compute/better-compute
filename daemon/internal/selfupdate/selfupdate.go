// Package selfupdate holds bcd's A/B binary slots and the upgrade record (PLAN.md §6 "Self-update",
// v0.4). The layout under Dir (<data_dir>/bin):
//
//	bcd-a, bcd-b   the two slots
//	current        -> bcd-a | bcd-b, the slot that runs
//	previous       -> the slot that ran before the last swap (bcd-rollback.service restores it)
//	slots.json     the version in each slot
//
// and the entrypoint systemd starts (/usr/local/bin/bcd) is a symlink to Dir/current. The first
// update adopts the binary the install script put at the entrypoint into slot a.
//
// An update stages the new binary in the other slot (size and SHA-256 checked while writing),
// writes upgrade.json{deadline: now+120s}, swaps current and execs the entrypoint. The new process
// confirms when a gateway welcomes it; no Welcome by the deadline swaps back and execs the old
// binary, which reports the update failed. A binary that crash-loops before it can do either trips
// StartLimitBurst, and bcd-rollback.service restores previous.
package selfupdate

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Deadline is how long a new binary has to be welcomed.
const Deadline = 120 * time.Second

// MaxBinaryBytes bounds a downloaded binary.
const MaxBinaryBytes = 512 << 20

// DefaultEntrypoint is where the install script puts bcd (bcd.service's ExecStart).
const DefaultEntrypoint = "/usr/local/bin/bcd"

// PendingFile is the upgrade record, in the data directory.
const PendingFile = "upgrade.json"

// Slots are the two binary slots under Dir and the entrypoint that links to the current one.
type Slots struct {
	Dir        string
	Entrypoint string
}

func (s Slots) slot(name string) string { return filepath.Join(s.Dir, "bcd-"+name) }
func (s Slots) link(name string) string { return filepath.Join(s.Dir, name) }

// Other is the slot that is not name.
func Other(name string) string {
	if name == "a" {
		return "b"
	}
	return "a"
}

// Current returns the running slot ("a" or "b"), or "" before the first update.
func (s Slots) Current() (string, error) { return s.readLink("current") }

// Previous returns the slot that ran before the last swap, or "".
func (s Slots) Previous() (string, error) { return s.readLink("previous") }

func (s Slots) readLink(name string) (string, error) {
	target, err := os.Readlink(s.link(name))
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	switch target {
	case "bcd-a":
		return "a", nil
	case "bcd-b":
		return "b", nil
	}
	return "", fmt.Errorf("selfupdate: %s links to %q, not a slot", s.link(name), target)
}

// Versions returns the version in each slot (slots.json).
func (s Slots) Versions() map[string]string {
	out := map[string]string{}
	if b, err := os.ReadFile(s.link("slots.json")); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

func (s Slots) setVersion(slot, version string) error {
	v := s.Versions()
	v[slot] = version
	b, _ := json.Marshal(v)
	return writeAtomic(s.link("slots.json"), b, 0o600)
}

// Adopt makes the slots exist: before the first update it copies exe (the binary that runs, of
// version) into slot a, points current at it and replaces the entrypoint with a symlink to current.
// Afterwards it only checks that the entrypoint still links to current.
func (s Slots) Adopt(exe, version string) error {
	cur, err := s.Current()
	if err != nil {
		return err
	}
	if cur == "" {
		if err := os.MkdirAll(s.Dir, 0o755); err != nil {
			return err
		}
		f, err := os.Open(exe)
		if err != nil {
			return err
		}
		_, err = s.write("a", f, -1, nil)
		f.Close()
		if err != nil {
			return err
		}
		if err := s.setVersion("a", version); err != nil {
			return err
		}
		if err := s.relink("current", "a"); err != nil {
			return err
		}
	} else if fi, err := os.Lstat(s.Entrypoint); err == nil && fi.Mode().IsRegular() {
		// The slots exist but the entrypoint is a plain file again: an install script replaced the
		// binary (mv -f). That file is what runs: it becomes the current slot, so relinking the
		// entrypoint never falls back to the older binary the slot held.
		f, err := os.Open(s.Entrypoint)
		if err != nil {
			return err
		}
		_, err = s.write(cur, f, -1, nil)
		f.Close()
		if err != nil {
			return err
		}
		if err := s.setVersion(cur, version); err != nil {
			return err
		}
	}
	return s.linkEntrypoint()
}

// linkEntrypoint makes the entrypoint a symlink to Dir/current. A regular file there (the install
// script's binary) is replaced; a symlink anywhere else is refused.
func (s Slots) linkEntrypoint() error {
	target := s.link("current")
	fi, err := os.Lstat(s.Entrypoint)
	switch {
	case err == nil && fi.Mode()&fs.ModeSymlink != 0:
		have, err := os.Readlink(s.Entrypoint)
		if err != nil {
			return err
		}
		if have == target {
			return nil
		}
		return fmt.Errorf("selfupdate: %s links to %s, not %s; set [update] entrypoint", s.Entrypoint, have, target)
	case err == nil && !fi.Mode().IsRegular():
		return fmt.Errorf("selfupdate: %s is not a file", s.Entrypoint)
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		return err
	}
	return symlinkAtomic(target, s.Entrypoint)
}

// Stage writes r into the slot that is not current, checking its size and SHA-256 as it goes, and
// returns that slot. Nothing is swapped.
func (s Slots) Stage(r io.Reader, size int64, sum []byte, version string) (string, error) {
	cur, err := s.Current()
	if err != nil {
		return "", err
	}
	if cur == "" {
		return "", errors.New("selfupdate: no slots yet (Adopt first)")
	}
	next := Other(cur)
	if _, err := s.write(next, r, size, sum); err != nil {
		return "", err
	}
	return next, s.setVersion(next, version)
}

// Holds reports whether slot holds a binary with this SHA-256.
func (s Slots) Holds(slot string, sum []byte) bool {
	f, err := os.Open(s.slot(slot))
	if err != nil {
		return false
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, io.LimitReader(f, MaxBinaryBytes+1)); err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(h.Sum(nil), sum) == 1
}

// write replaces slot with r (size -1: any size up to MaxBinaryBytes; sum nil: unchecked).
func (s Slots) write(slot string, r io.Reader, size int64, sum []byte) (string, error) {
	tmp := s.slot(slot) + ".tmp"
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp)
	limit := int64(MaxBinaryBytes)
	if size >= 0 {
		limit = size
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(r, limit+1))
	if err == nil && (n > limit || (size >= 0 && n != size)) {
		err = fmt.Errorf("selfupdate: the binary is %d bytes, not %d", n, limit)
	}
	if err == nil && sum != nil && subtle.ConstantTimeCompare(h.Sum(nil), sum) != 1 {
		err = errors.New("selfupdate: the binary's SHA-256 does not match")
	}
	if err == nil {
		err = f.Chmod(0o755)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	if err := os.Rename(tmp, s.slot(slot)); err != nil {
		return "", err
	}
	return s.slot(slot), syncDir(s.Dir)
}

// Swap points current at slot and previous at the slot that was current.
func (s Slots) Swap(slot string) error {
	cur, err := s.Current()
	if err != nil {
		return err
	}
	if cur != "" && cur != slot {
		if err := s.relink("previous", cur); err != nil {
			return err
		}
	}
	return s.relink("current", slot)
}

// Revert points current back at slot and removes previous (a rollback): bcd-rollback.service then
// has nothing to restore.
func (s Slots) Revert(slot string) error {
	if err := os.Remove(s.link("previous")); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return s.relink("current", slot)
}

func (s Slots) relink(name, slot string) error {
	return symlinkAtomic("bcd-"+slot, s.link(name))
}

// symlinkAtomic makes path a symlink to target, replacing whatever is there in one rename.
func symlinkAtomic(target, path string) error {
	tmp := path + ".bcd-new"
	_ = os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return syncDir(filepath.Dir(path))
}

// Pending is upgrade.json: an update between the swap and its confirmation, or its failure until
// the old binary has reported it.
type Pending struct {
	// Version is the new binary's; FromVersion the one it replaced.
	Version     string `json:"version"`
	FromVersion string `json:"fromVersion"`
	From        string `json:"from"`
	To          string `json:"to"`
	// Sequence is the release manifest's, recorded as the rollback floor once confirmed.
	Sequence int64     `json:"sequence,omitempty"`
	Deadline time.Time `json:"deadline"`
	// CommandID is the daemon.upgrade command that asked for it ("" for NodeSpec.daemon).
	CommandID string `json:"commandId,omitempty"`
	// State is StateSwapped until the new binary is welcomed, or StateRolledBack.
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

// Pending states.
const (
	StateSwapped    = "swapped"
	StateRolledBack = "rolled-back"
)

// LoadPending reads upgrade.json from dataDir (nil when there is none).
func LoadPending(dataDir string) (*Pending, error) {
	b, err := os.ReadFile(filepath.Join(dataDir, PendingFile))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p Pending
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, fmt.Errorf("selfupdate: %s: %w", PendingFile, err)
	}
	return &p, nil
}

// SavePending writes upgrade.json (fsynced before the swap it describes).
func SavePending(dataDir string, p *Pending) error {
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(dataDir, PendingFile), b, 0o600)
}

// ClearPending removes upgrade.json.
func ClearPending(dataDir string) error {
	err := os.Remove(filepath.Join(dataDir, PendingFile))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err == nil {
		err = syncDir(dataDir)
	}
	return err
}

// Record is update.json: the release floor and the versions that failed to start.
type Record struct {
	// Sequence is the highest release manifest sequence this node ran: an older one is a rollback.
	Sequence int64 `json:"sequence,omitempty"`
	// Failed maps versions that did not start (or were not welcomed) to why; they are not retried.
	Failed map[string]string `json:"failed,omitempty"`
}

// maxFailed bounds Record.Failed.
const maxFailed = 32

// LoadRecord reads update.json (empty when absent).
func LoadRecord(dataDir string) Record {
	var r Record
	if b, err := os.ReadFile(filepath.Join(dataDir, "update.json")); err == nil {
		_ = json.Unmarshal(b, &r)
	}
	return r
}

// SaveRecord writes update.json.
func SaveRecord(dataDir string, r Record) error {
	if len(r.Failed) > maxFailed {
		for v := range r.Failed {
			if len(r.Failed) <= maxFailed {
				break
			}
			delete(r.Failed, v)
		}
	}
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(dataDir, "update.json"), b, 0o600)
}

// Bare strips a leading "v" (release versions are compared without it).
func Bare(version string) string { return strings.TrimPrefix(version, "v") }

// Older reports whether semantic version a precedes b (a pre-release precedes its release). Versions
// that do not parse are never older.
func Older(a, b string) bool {
	pa, oka := parseSemver(Bare(a))
	pb, okb := parseSemver(Bare(b))
	if !oka || !okb {
		return false
	}
	for i := 0; i < 3; i++ {
		if pa.core[i] != pb.core[i] {
			return pa.core[i] < pb.core[i]
		}
	}
	switch {
	case pa.pre == pb.pre:
		return false
	case pa.pre == "":
		return false
	case pb.pre == "":
		return true
	}
	return pa.pre < pb.pre
}

type semver struct {
	core [3]uint64
	pre  string
}

func parseSemver(v string) (semver, bool) {
	var out semver
	if i := strings.IndexByte(v, '+'); i >= 0 {
		v = v[:i]
	}
	if i := strings.IndexByte(v, '-'); i >= 0 {
		v, out.pre = v[:i], v[i+1:]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.ParseUint(p, 10, 64)
		if err != nil {
			return out, false
		}
		out.core[i] = n
	}
	return out, true
}

var unitPath = regexp.MustCompile(`^/[A-Za-z0-9/._-]+$`)

// RollbackUnits are bcd-rollback.service and the bcd.service drop-in that starts it when bcd
// crash-loops (StartLimitBurst): it restores previous, but only while an update is pending.
func RollbackUnits(dataDir string, s Slots) (map[string]string, error) {
	for _, p := range []string{dataDir, s.Dir} {
		if !unitPath.MatchString(p) {
			return nil, fmt.Errorf("selfupdate: %q cannot be written into a unit", p)
		}
	}
	pending := filepath.ToSlash(filepath.Join(dataDir, PendingFile))
	dir := filepath.ToSlash(s.Dir)
	return map[string]string{
		"bcd-rollback.service": "# Written by bcd (self-update): restores the previous slot after a crash loop.\n" +
			"[Unit]\nDescription=Roll bcd back to its previous binary\n" +
			"[Service]\nType=oneshot\n" +
			"ExecCondition=/usr/bin/test -f " + pending + " -a -L " + dir + "/previous\n" +
			// Only while a swap awaits its Welcome, never after a rollback.
			"ExecCondition=/bin/grep -qF '\"state\":\"swapped\"' " + pending + "\n" +
			"ExecStart=/bin/cp -P " + dir + "/previous " + dir + "/current.rollback\n" +
			"ExecStart=/bin/mv -Tf " + dir + "/current.rollback " + dir + "/current\n" +
			"ExecStart=/bin/systemctl reset-failed bcd.service\n" +
			"ExecStart=/bin/systemctl start --no-block bcd.service\n",
		"bcd.service.d/50-bcd-rollback.conf": "# Written by bcd (self-update).\n" +
			"[Unit]\nStartLimitIntervalSec=600\nStartLimitBurst=5\nOnFailure=bcd-rollback.service\n",
	}, nil
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(mode); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	return syncDir(dir)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	if err := d.Sync(); err != nil && !errors.Is(err, errors.ErrUnsupported) && !isWindowsSyncErr(err) {
		return err
	}
	return nil
}

// isWindowsSyncErr: directories cannot be fsynced on Windows (tests only; bcd runs on Linux).
func isWindowsSyncErr(err error) bool {
	return strings.Contains(err.Error(), "Access is denied") || strings.Contains(err.Error(), "Incorrect function")
}
