package agent

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/selfupdate"
)

// release is the signed bcd 0.4.0 manifest of pki/testdata (scripts/daemon-release-fixture.mjs).
type release struct {
	signed   []byte
	pins     [][]byte
	other    []byte
	binary   []byte
	sha256   []byte
	url      string
	requests int
}

func loadRelease(t *testing.T) *release {
	t.Helper()
	raw, err := os.ReadFile("../pki/testdata/release.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Signed   string            `json:"signed"`
		Pins     []string          `json:"pins"`
		OtherPin string            `json:"otherPin"`
		Binaries map[string]string `json:"binaries"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	pin := func(s string) []byte {
		b, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(s, "sha256/"))
		return b
	}
	r := &release{signed: []byte(f.Signed), pins: [][]byte{pin(f.Pins[0]), pin(f.Pins[1])}, other: pin(f.OtherPin)}
	r.binary, _ = base64.StdEncoding.DecodeString(f.Binaries["linux-amd64"])
	sum := sha256.Sum256(r.binary)
	r.sha256 = sum[:]
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		r.requests++
		_, _ = w.Write(r.binary)
	}))
	t.Cleanup(srv.Close)
	r.url = srv.URL + "/downloads/bcd/0.4.0/linux-amd64"
	return r
}

func (r *release) section() *agentv1.DaemonSection {
	return &agentv1.DaemonSection{Version: "0.4.0", Url: r.url, Sha256: r.sha256, Signature: r.signed}
}

// updateNode is a node whose data directory survives restarts; the install script's binary is
// entrypoint (the first update adopts it).
type updateNode struct {
	*harness
	dir   string
	entry string
	pins  [][]byte
}

func newUpdateNode(t *testing.T, r *release) *updateNode {
	dir := t.TempDir()
	entry := filepath.Join(dir, "usr-local-bin-bcd")
	if err := os.WriteFile(entry, []byte("bcd 0.3.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	n := &updateNode{dir: dir, entry: entry, pins: r.pins}
	n.harness = newHarness(t, n.options("0.3.0"))
	return n
}

func (n *updateNode) options(version string) func(*Options) {
	return func(o *Options) {
		o.DataDir = n.dir
		o.Version = version
		o.ConvergeRetry = 50 * time.Millisecond
		o.Update = &UpdateOptions{
			Slots:      selfupdate.Slots{Dir: filepath.Join(n.dir, "bin"), Entrypoint: n.entry},
			Executable: n.entry,
			Pins:       n.pins,
			Threshold:  2,
			Platform:   "linux-amd64",
			AllowHTTP:  true,
			Deadline:   time.Second,
		}
	}
}

// restart waits for Run to end with ErrRestart and starts the binary now in the current slot.
func (n *updateNode) restart(t *testing.T, version string) {
	t.Helper()
	n.waitRestart(t)
	n.start(n.options(version))
}

func (n *updateNode) waitRestart(t *testing.T) {
	t.Helper()
	select {
	case <-n.done:
	case <-time.After(10 * time.Second):
		t.Fatal("the agent did not restart")
	}
	if !errors.Is(n.runErr, ErrRestart) {
		t.Fatalf("Run = %v; want ErrRestart", n.runErr)
	}
}

func (n *updateNode) link(t *testing.T, name string) string {
	t.Helper()
	target, err := os.Readlink(filepath.Join(n.dir, "bin", name))
	if err != nil {
		t.Fatal(err)
	}
	return target
}

func daemonStatus(t *testing.T, s *fakeStream, state agentv1.SectionState) *agentv1.SectionStatus {
	t.Helper()
	var found *agentv1.SectionStatus
	s.next(t, "daemon section "+state.String(), func(f *agentv1.AgentFrame) bool {
		for _, st := range f.GetStatus().GetSections() {
			if st.GetSection() == "daemon" && st.GetState() == state {
				found = st
				return true
			}
		}
		return false
	})
	return found
}

// NodeSpec.daemon: the release is verified, staged in slot b and swapped to; the new binary is
// confirmed by its Welcome and records the release as the rollback floor.
func TestSelfUpdateSwapsAndConfirms(t *testing.T) {
	r := loadRelease(t)
	n := newUpdateNode(t, r)
	s, _ := n.open()
	s.push(desired(1, &agentv1.NodeSpec{Daemon: r.section()}))
	n.restart(t, "0.4.0")

	if target, _ := os.Readlink(n.entry); target != filepath.Join(n.dir, "bin", "current") {
		t.Fatalf("the entrypoint links to %q", target)
	}
	if n.link(t, "current") != "bcd-b" || n.link(t, "previous") != "bcd-a" {
		t.Fatalf("current = %s, previous = %s", n.link(t, "current"), n.link(t, "previous"))
	}
	if b, _ := os.ReadFile(filepath.Join(n.dir, "bin", "bcd-b")); string(b) != string(r.binary) {
		t.Fatalf("slot b = %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(n.dir, "bin", "bcd-a")); string(b) != "bcd 0.3.0\n" {
		t.Fatalf("slot a = %q", b)
	}
	if p, _ := selfupdate.LoadPending(n.dir); p == nil || p.State != selfupdate.StateSwapped || p.Sequence != 7 || p.To != "b" {
		t.Fatalf("upgrade.json = %+v", p)
	}

	s, _ = n.open()
	daemonStatus(t, s, agentv1.SectionState_SECTION_STATE_CONVERGED)
	deadline := time.Now().Add(5 * time.Second)
	for {
		p, _ := selfupdate.LoadPending(n.dir)
		if p == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the Welcome did not confirm the update")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if rec := selfupdate.LoadRecord(n.dir); rec.Sequence != 7 {
		t.Fatalf("update.json = %+v", rec)
	}
	// Past the deadline nothing swaps back.
	time.Sleep(1200 * time.Millisecond)
	if n.link(t, "current") != "bcd-b" {
		t.Fatal("a confirmed update was rolled back")
	}

	// A rollout rolled back: the version in the other slot, by its digest, needs no manifest.
	old := sha256.Sum256([]byte("bcd 0.3.0\n"))
	s.push(desired(2, &agentv1.NodeSpec{Daemon: &agentv1.DaemonSection{Version: "v0.3.0", Sha256: old[:]}}))
	n.restart(t, "0.3.0")
	if n.link(t, "current") != "bcd-a" || n.link(t, "previous") != "bcd-b" || r.requests != 1 {
		t.Fatalf("current = %s, previous = %s, %d downloads", n.link(t, "current"), n.link(t, "previous"), r.requests)
	}
	s, _ = n.open()
	daemonStatus(t, s, agentv1.SectionState_SECTION_STATE_CONVERGED)
}

// No Welcome by the deadline: the new binary swaps back, and the old one reports the version failed
// and does not try it again.
func TestSelfUpdateRollsBackWithoutWelcome(t *testing.T) {
	r := loadRelease(t)
	n := newUpdateNode(t, r)
	s, _ := n.open()
	s.push(desired(1, &agentv1.NodeSpec{Daemon: r.section()}))
	n.restart(t, "0.4.0")
	n.gw.accept() // dials, but no gateway ever welcomes it
	n.restart(t, "0.3.0")
	if n.link(t, "current") != "bcd-a" {
		t.Fatalf("current = %s after the rollback", n.link(t, "current"))
	}
	s, _ = n.open()
	st := daemonStatus(t, s, agentv1.SectionState_SECTION_STATE_FAILED)
	if st.GetReason() != "UpdateFailed" || !strings.Contains(st.GetMessage(), "bcd 0.4.0 did not start") {
		t.Fatalf("daemon section = %v", st)
	}
	if p, _ := selfupdate.LoadPending(n.dir); p != nil {
		t.Fatalf("upgrade.json left: %+v", p)
	}
	if downloads := r.requests; downloads != 1 {
		t.Fatalf("%d downloads; the failed version was fetched again", downloads)
	}
}

// daemon.upgrade is self-terminating: RUNNING before the swap, SUCCEEDED from the new binary once
// it is welcomed.
func TestDaemonUpgradeCommand(t *testing.T) {
	r := loadRelease(t)
	n := newUpdateNode(t, r)
	s, _ := n.open()
	up := body("cmd_up", "daemon.upgrade", r.section())
	up.SelfTerminating = true
	s.push(command(up))
	s.update(t, "cmd_up", commonv1.CommandState_COMMAND_STATE_RUNNING)
	n.restart(t, "0.4.0")
	s = n.gw.accept()
	hello := s.next(t, "Hello", func(f *agentv1.AgentFrame) bool { return f.GetHello() != nil }).GetHello()
	for _, u := range hello.GetUnackedResults() {
		if u.GetCommandId() == "cmd_up" {
			t.Fatalf("the upgrade was reported before a Welcome: %v", u)
		}
	}
	s.push(welcome())
	s.update(t, "cmd_up", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)

	// Redelivered once done: the stored result.
	s.push(command(up))
	s.update(t, "cmd_up", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
}

// Only the pinned release keys decide: a manifest they did not sign, or none, is refused.
func TestSelfUpdateRefusesUnpinnedReleases(t *testing.T) {
	r := loadRelease(t)
	n := newUpdateNode(t, r)
	n.gw.accept() // the first start's session
	n.cancel()
	<-n.done
	n.pins = [][]byte{r.other, r.pins[0]}
	n.start(n.options("0.3.0"))
	s, _ := n.open()
	s.push(desired(1, &agentv1.NodeSpec{Daemon: r.section()}))
	st := daemonStatus(t, s, agentv1.SectionState_SECTION_STATE_FAILED)
	if !strings.Contains(st.GetMessage(), "1 of 2 required release keys") {
		t.Fatalf("daemon section = %v", st)
	}
	unsigned := r.section()
	unsigned.Signature = nil
	s.push(desired(2, &agentv1.NodeSpec{Daemon: unsigned}))
	st = daemonStatus(t, s, agentv1.SectionState_SECTION_STATE_FAILED)
	if !strings.Contains(st.GetMessage(), "no signed release manifest") {
		t.Fatalf("daemon section = %v", st)
	}
	wrong := r.section()
	wrong.Sha256 = make([]byte, 32)
	n.pins = r.pins
	s.push(desired(3, &agentv1.NodeSpec{Daemon: wrong}))
	daemonStatus(t, s, agentv1.SectionState_SECTION_STATE_FAILED)
	if r.requests != 0 {
		t.Fatalf("%d downloads of an unverified binary", r.requests)
	}
	if _, err := os.Lstat(filepath.Join(n.dir, "bin", "bcd-b")); err == nil {
		t.Fatal("slot b was written")
	}
}
