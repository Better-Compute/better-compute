package selfupdate

import (
	"bytes"
	"crypto/sha256"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func newSlots(t *testing.T) (Slots, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	dir := t.TempDir()
	entry := filepath.Join(dir, "bcd")
	if err := os.WriteFile(entry, []byte("v1"), 0o755); err != nil {
		t.Fatal(err)
	}
	return Slots{Dir: filepath.Join(dir, "bin"), Entrypoint: entry}, dir
}

func TestAdoptStageSwap(t *testing.T) {
	s, _ := newSlots(t)
	if cur, err := s.Current(); err != nil || cur != "" {
		t.Fatalf("Current before adopting = %q, %v", cur, err)
	}
	if err := s.Adopt(s.Entrypoint, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if err := s.Adopt(s.Entrypoint, "1.0.0"); err != nil {
		t.Fatalf("Adopt again: %v", err)
	}
	if target, _ := os.Readlink(s.Entrypoint); target != filepath.Join(s.Dir, "current") {
		t.Fatalf("entrypoint -> %q", target)
	}
	if b, _ := os.ReadFile(s.Entrypoint); string(b) != "v1" {
		t.Fatalf("through the entrypoint: %q", b)
	}
	v2 := []byte("v2 binary")
	sum := sha256.Sum256(v2)
	bad := sha256.Sum256([]byte("other"))
	if _, err := s.Stage(bytes.NewReader(v2), int64(len(v2)), bad[:], "2.0.0"); err == nil {
		t.Fatal("a wrong digest was staged")
	}
	if _, err := s.Stage(bytes.NewReader(v2), int64(len(v2))-1, sum[:], "2.0.0"); err == nil {
		t.Fatal("a longer body than the manifest's size was staged")
	}
	if _, err := os.Lstat(filepath.Join(s.Dir, "bcd-b")); err == nil {
		t.Fatal("a refused binary was left in slot b")
	}
	slot, err := s.Stage(bytes.NewReader(v2), int64(len(v2)), sum[:], "2.0.0")
	if err != nil || slot != "b" || !s.Holds("b", sum[:]) || s.Versions()["b"] != "2.0.0" || s.Versions()["a"] != "1.0.0" {
		t.Fatalf("Stage = %q, %v; versions %v", slot, err, s.Versions())
	}
	if err := s.Swap("b"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(s.Entrypoint); string(b) != "v2 binary" {
		t.Fatalf("after the swap: %q", b)
	}
	if prev, _ := s.Previous(); prev != "a" {
		t.Fatalf("previous = %q", prev)
	}
	if fi, _ := os.Stat(filepath.Join(s.Dir, "bcd-b")); fi.Mode().Perm() != 0o755 {
		t.Fatalf("slot b mode %v", fi.Mode())
	}
}

func TestEntrypointLinkedElsewhereRefused(t *testing.T) {
	s, dir := newSlots(t)
	other := filepath.Join(dir, "elsewhere")
	_ = os.WriteFile(other, []byte("x"), 0o755)
	_ = os.Remove(s.Entrypoint)
	if err := os.Symlink(other, s.Entrypoint); err != nil {
		t.Fatal(err)
	}
	if err := s.Adopt(other, "1.0.0"); err == nil || !strings.Contains(err.Error(), "entrypoint") {
		t.Fatalf("Adopt = %v", err)
	}
}

func TestPendingAndRecord(t *testing.T) {
	dir := t.TempDir()
	if p, err := LoadPending(dir); p != nil || err != nil {
		t.Fatalf("LoadPending = %v, %v", p, err)
	}
	want := &Pending{Version: "2.0.0", FromVersion: "1.0.0", From: "a", To: "b", Sequence: 3, Deadline: time.Unix(100, 0).UTC(), State: StateSwapped}
	if err := SavePending(dir, want); err != nil {
		t.Fatal(err)
	}
	got, err := LoadPending(dir)
	if err != nil || *got != *want {
		t.Fatalf("LoadPending = %+v, %v", got, err)
	}
	if err := ClearPending(dir); err != nil || ClearPending(dir) != nil {
		t.Fatal(err)
	}
	rec := Record{Sequence: 3, Failed: map[string]string{}}
	for i := 0; i < 40; i++ {
		rec.Failed[string(rune('a'+i))] = "x"
	}
	if err := SaveRecord(dir, rec); err != nil {
		t.Fatal(err)
	}
	if back := LoadRecord(dir); back.Sequence != 3 || len(back.Failed) != maxFailed {
		t.Fatalf("LoadRecord = %d failed", len(back.Failed))
	}
}

func TestRollbackUnits(t *testing.T) {
	s := Slots{Dir: "/var/lib/bcd/bin", Entrypoint: DefaultEntrypoint}
	units, err := RollbackUnits("/var/lib/bcd", s)
	if err != nil {
		t.Fatal(err)
	}
	unit := units["bcd-rollback.service"]
	for _, want := range []string{"ExecCondition=/usr/bin/test -f /var/lib/bcd/upgrade.json -a -L /var/lib/bcd/bin/previous", "/bin/cp -P /var/lib/bcd/bin/previous /var/lib/bcd/bin/current.rollback"} {
		if !strings.Contains(unit, want) {
			t.Fatalf("unit lacks %q:\n%s", want, unit)
		}
	}
	if !strings.Contains(unit, "ExecCondition=/bin/grep -qF '\"state\":\"swapped\"' /var/lib/bcd/upgrade.json") {
		t.Fatalf("the unit does not require a pending swap:\n%s", unit)
	}
	if !strings.Contains(units["bcd.service.d/50-bcd-rollback.conf"], "OnFailure=bcd-rollback.service") {
		t.Fatal("drop-in")
	}
	if _, err := RollbackUnits("/var/lib/bcd dir", s); err == nil {
		t.Fatal("a path with a space went into a unit")
	}
}

func TestOlder(t *testing.T) {
	for _, c := range []struct {
		a, b  string
		older bool
	}{
		{"1.2.0", "1.10.0", true},
		{"v1.9.0", "1.10.0", true},
		{"2.0.0", "1.99.99", false},
		{"1.0.0-rc.1", "1.0.0", true},
		{"1.0.0", "1.0.0-rc.1", false},
		{"1.0.0", "1.0.0", false},
		{"dev", "1.0.0", false},
	} {
		if got := Older(c.a, c.b); got != c.older {
			t.Errorf("Older(%s, %s) = %v", c.a, c.b, got)
		}
	}
}

func TestRevertDropsPrevious(t *testing.T) {
	s, _ := newSlots(t)
	if err := s.Adopt(s.Entrypoint, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	v2 := []byte("v2")
	sum := sha256.Sum256(v2)
	if _, err := s.Stage(bytes.NewReader(v2), 2, sum[:], "2.0.0"); err != nil {
		t.Fatal(err)
	}
	_ = s.Swap("b")
	if err := s.Revert("a"); err != nil {
		t.Fatal(err)
	}
	if cur, _ := s.Current(); cur != "a" {
		t.Fatalf("current = %s", cur)
	}
	if prev, _ := s.Previous(); prev != "" {
		t.Fatalf("previous = %s after a revert", prev)
	}
}

// An install script's upgrade replaces the entrypoint symlink with a plain file (mv -f): the next
// update adopts that file, never the older binary the current slot held.
func TestAdoptAfterScriptReinstall(t *testing.T) {
	s, _ := newSlots(t)
	if err := s.Adopt(s.Entrypoint, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(s.Entrypoint)
	if err := os.WriteFile(s.Entrypoint, []byte("v1.5 from the script"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := s.Adopt(s.Entrypoint, "1.5.0"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(s.Entrypoint); string(b) != "v1.5 from the script" {
		t.Fatalf("through the entrypoint: %q", b)
	}
	if target, _ := os.Readlink(s.Entrypoint); target != filepath.Join(s.Dir, "current") || s.Versions()["a"] != "1.5.0" {
		t.Fatalf("entrypoint -> %q, versions %v", target, s.Versions())
	}
}
