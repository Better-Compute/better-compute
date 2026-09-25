//go:build unix

package selfupdate

import (
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// review 11 H1: a confirmed update is never undone through the other slot, which holds a release
// below the floor; M2: what the node claims to run decides nothing.
func TestManagerNeverSwapsBelowTheFloor(t *testing.T) {
	m, target, binary := newManager(t)
	_ = os.WriteFile(m.StagedPath("0.4.0"), binary, 0o644)
	if _, err := m.Swap(target); err != nil {
		t.Fatal(err)
	}
	// Right after the swap a lying node claims to run the old version: nothing is recorded failed.
	if s, err := m.Settle("0.3.0"); err != nil || s.Action != "await" {
		t.Fatalf("Settle with a false claim = %+v, %v", s, err)
	}
	if err := m.Confirm("0.4.0"); err != nil {
		t.Fatal(err)
	}
	// Back to the adopted 0.3.0 in slot a, by its digest, and claiming to run anything: refused.
	old := sha256.Sum256([]byte("bcd 0.3.0"))
	var r *Refusal
	for _, running := range []string{"0.4.0", "0.0.0", "9.9.9"} {
		if _, err := m.Swap(Target{Version: "0.3.0", Sha256: old[:], Running: running}); !errors.As(err, &r) {
			t.Fatalf("a swap below the floor (running %q): %v", running, err)
		}
	}
	if cur, _ := m.Slots.Current(); cur != "b" {
		t.Fatalf("current = %s", cur)
	}
}

// review 11 M1: the staged binary must be a plain file of the node's, beneath the data directory.
func TestManagerStagedFileChecks(t *testing.T) {
	m, target, binary := newManager(t)
	staged := m.StagedPath("0.4.0")
	// A FIFO does not block the manager.
	if err := syscall.Mkfifo(staged, 0o644); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := m.Swap(target); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a FIFO was staged")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a FIFO blocked the manager")
	}
	_ = os.Remove(staged)
	// A second link, a staging directory that is a symlink, another owner: refused.
	_ = os.WriteFile(staged, binary, 0o644)
	_ = os.Link(staged, staged+".other")
	if _, err := m.Swap(target); err == nil {
		t.Fatal("a hard-linked staged file was taken")
	}
	_ = os.Remove(staged + ".other")
	uid := uint32(os.Getuid()) + 1
	m.StagedUID = &uid
	if _, err := m.Swap(target); err == nil {
		t.Fatal("a staged file of another owner was taken")
	}
	m.StagedUID = nil
	real := m.StagingDir + ".real"
	_ = os.Rename(m.StagingDir, real)
	_ = os.Symlink(real, m.StagingDir)
	if _, err := m.Swap(target); err == nil {
		t.Fatal("a symlinked staging directory was followed")
	}
	_ = os.Remove(m.StagingDir)
	_ = os.Rename(real, m.StagingDir)
	if _, err := m.Swap(target); err != nil {
		t.Fatalf("a plain staged file: %v", err)
	}
	if fi, err := os.Stat(filepath.Join(m.Slots.Dir)); err != nil || fi.Mode().Perm() != 0o755 {
		t.Fatalf("slots dir mode = %v, %v", fi.Mode(), err)
	}
}

// Under a hardened unit's UMask=0077, every directory the slots need is still 0755 (the node execs
// the entrypoint through them).
func TestSlotsDirectoriesUnderUmask077(t *testing.T) {
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)
	dir := t.TempDir()
	entry := filepath.Join(dir, "bcd")
	_ = os.WriteFile(entry, []byte("bcd"), 0o755)
	s := Slots{Dir: filepath.Join(dir, "usr", "local", "lib", "bcd"), Entrypoint: entry}
	if err := s.Adopt(entry, "1.0.0", 0); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{filepath.Join(dir, "usr"), filepath.Join(dir, "usr", "local"), filepath.Join(dir, "usr", "local", "lib"), s.Dir} {
		if fi, err := os.Stat(d); err != nil || fi.Mode().Perm() != 0o755 {
			t.Fatalf("%s: %v %v", d, fi.Mode(), err)
		}
	}
}
