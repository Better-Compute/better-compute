package selfupdate

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// release is pki/testdata/release.json: bcd 0.4.0 (sequence 7) signed by two keys.
func release(t *testing.T) (signed []byte, pins [][]byte, binary []byte) {
	t.Helper()
	raw, err := os.ReadFile("../pki/testdata/release.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Signed   string            `json:"signed"`
		Pins     []string          `json:"pins"`
		Binaries map[string]string `json:"binaries"`
	}
	_ = json.Unmarshal(raw, &f)
	for _, p := range f.Pins {
		b, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(p, "sha256/"))
		pins = append(pins, b)
	}
	binary, _ = base64.StdEncoding.DecodeString(f.Binaries["linux-amd64"])
	return []byte(f.Signed), pins, binary
}

func newManager(t *testing.T) (*Manager, Target, []byte) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	signed, pins, binary := release(t)
	dir := t.TempDir()
	entry := filepath.Join(dir, "bcd")
	_ = os.WriteFile(entry, []byte("bcd 0.3.0"), 0o755)
	now := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	m := &Manager{
		Slots: Slots{Dir: filepath.Join(dir, "slots"), Entrypoint: entry}, StateDir: filepath.Join(dir, "state"),
		StagingDir: filepath.Join(dir, "staging"), Executable: entry, Pins: pins, Threshold: 2, Platform: "linux-amd64",
		Deadline: time.Minute, Now: func() time.Time { return now },
	}
	_ = os.MkdirAll(m.StateDir, 0o700)
	_ = os.MkdirAll(m.StagingDir, 0o755)
	sum := sha256.Sum256(binary)
	return m, Target{Version: "0.4.0", Sha256: sum[:], Manifest: signed, Running: "0.3.0"}, binary
}

func TestManagerSwapVerifiesTheStagedBinaryItself(t *testing.T) {
	m, target, binary := newManager(t)
	if art, err := m.Prepare(target); err != nil || art == nil || art.Name != "bcd_0.4.0_linux_amd64" {
		t.Fatalf("Prepare = %+v, %v", art, err)
	}
	// Whatever the node staged, only the manifest's bytes are taken.
	_ = os.WriteFile(m.StagedPath("0.4.0"), append([]byte("evil"), binary[4:]...), 0o644)
	if _, err := m.Swap(target); err == nil {
		t.Fatal("a staged binary that is not the release was swapped in")
	}
	_ = os.Remove(m.StagedPath("0.4.0"))
	_ = os.Symlink("/etc/passwd", m.StagedPath("0.4.0"))
	if _, err := m.Swap(target); err == nil {
		t.Fatal("a symlinked staging file was followed")
	}
	_ = os.Remove(m.StagedPath("0.4.0"))
	_ = os.WriteFile(m.StagedPath("0.4.0"), binary, 0o644)
	p, err := m.Swap(target)
	if err != nil || p.To != "b" || p.Sequence != 7 || p.State != StateSwapped {
		t.Fatalf("Swap = %+v, %v", p, err)
	}
	if _, err := m.Swap(target); err == nil {
		t.Fatal("a second swap while one is pending")
	}
	// The new binary starts: it awaits its Welcome, then confirms; the floor moves to 7.
	s, err := m.Settle("0.4.0")
	if err != nil || s.Action != "await" {
		t.Fatalf("Settle = %+v, %v", s, err)
	}
	if err := m.Confirm("0.9.9"); err == nil {
		t.Fatal("confirmed another version")
	}
	if err := m.Confirm("0.4.0"); err != nil {
		t.Fatal(err)
	}
	if st, _ := m.Status(); st.Pending != nil || st.Record.Sequence != 7 || st.Current != "b" {
		t.Fatalf("status = %+v", st)
	}
}

func TestManagerRollBackAndSettle(t *testing.T) {
	m, target, binary := newManager(t)
	_ = os.WriteFile(m.StagedPath("0.4.0"), binary, 0o644)
	if _, err := m.Swap(target); err != nil {
		t.Fatal(err)
	}
	// The helper's own watchdog: nothing before the deadline, a swap back after it.
	if _, ok := m.Expire(); ok {
		t.Fatal("expired before the deadline")
	}
	later := m.Now().Add(2 * time.Minute)
	m.Now = func() time.Time { return later }
	rolled, ok := m.Expire()
	if !ok || rolled.State != StateRolledBack {
		t.Fatalf("Expire = %+v %v", rolled, ok)
	}
	if cur, _ := m.Slots.Current(); cur != "a" {
		t.Fatalf("current = %s", cur)
	}
	if prev, _ := m.Slots.Previous(); prev != "" {
		t.Fatal("previous survived the rollback")
	}
	// The old binary starts: the version is recorded as failed and not tried again.
	s, err := m.Settle("0.3.0")
	if err != nil || s.Action != "failed" || !strings.Contains(s.Pending.Reason, "not welcomed") {
		t.Fatalf("Settle = %+v, %v", s, err)
	}
	var r *Refusal
	if _, err := m.Prepare(target); !errors.As(err, &r) {
		t.Fatalf("a failed version was prepared: %v", err)
	}
	if err := m.ClearFailed(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Prepare(target); err != nil {
		t.Fatalf("after clearing: %v", err)
	}
}

func TestManagerRefusals(t *testing.T) {
	m, target, _ := newManager(t)
	var r *Refusal
	for name, mutate := range map[string]func(*Target){
		"bad version":    func(t *Target) { t.Version = "../../x" },
		"short digest":   func(t *Target) { t.Sha256 = []byte{1} },
		"no manifest":    func(t *Target) { t.Manifest = nil },
		"another digest": func(t *Target) { t.Sha256 = make([]byte, 32) },
		"server later":   func(t *Target) { t.ServerTime = time.Date(2200, 1, 1, 0, 0, 0, 0, time.UTC) },
	} {
		tt := target
		mutate(&tt)
		if _, err := m.Prepare(tt); !errors.As(err, &r) {
			t.Errorf("%s: %v", name, err)
		}
	}
	m.Sequence = 8
	if _, err := m.Prepare(target); err == nil || !strings.Contains(err.Error(), "older than 8") {
		t.Fatalf("below the floor: %v", err)
	}
}
