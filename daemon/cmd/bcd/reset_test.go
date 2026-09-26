package main

import (
	"bytes"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
)

// bcd join --reset moves the identity aside only when confirmed, and keeps the old files.
func TestJoinReset(t *testing.T) {
	if !devBuild && os.Geteuid() != 0 {
		t.Skip("--reset runs as root outside development builds")
	}
	dir := t.TempDir()
	var out, errOut bytes.Buffer
	// Nothing to move: the join goes on.
	if code := resetIdentity(dir, false, &out, &errOut); code != exitOK {
		t.Fatalf("an empty data directory: %d %s", code, errOut.String())
	}
	for _, name := range []string{agent.StateFile, agent.KeyFile, agent.JournalFile} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// Unconfirmed: it says what it would move, and moves nothing.
	if code := resetIdentity(dir, false, &out, &errOut); code != exitUsage || !strings.Contains(errOut.String(), "--reset --yes") {
		t.Fatalf("unconfirmed: %d %s", code, errOut.String())
	}
	if _, err := os.Stat(filepath.Join(dir, agent.KeyFile)); err != nil {
		t.Fatal("an unconfirmed reset moved the key")
	}
	if code := resetIdentity(dir, true, &out, &errOut); code != exitOK {
		t.Fatalf("confirmed: %d %s", code, errOut.String())
	}
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	// The journal is the old node's: bcd node would refuse it under the new identity.
	if len(names) != 3 || !strings.HasPrefix(names[0], agent.StateFile+".reset-") || !strings.HasPrefix(names[1], agent.JournalFile+".reset-") ||
		!strings.HasPrefix(names[2], agent.KeyFile+".reset-") {
		t.Fatalf("after the reset: %v", names)
	}
	if _, _, err := agent.LoadState(dir); err == nil {
		t.Fatal("an identity still loads")
	}
}

// A root join under [helper] hands the identity it wrote to the node's user.
func TestJoinHandsTheIdentityToTheNode(t *testing.T) {
	dir := t.TempDir()
	cfg := &config.Config{DataDir: dir}
	if err := handToNode(cfg); err != nil {
		t.Fatalf("without [helper]: %v", err)
	}
	if os.Geteuid() != 0 {
		t.Skip("handing files to another user needs root")
	}
	for _, name := range []string{agent.StateFile, agent.KeyFile} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cfg.Helper.Socket, cfg.Helper.User = "/run/bcd-helper/helper.sock", "nobody"
	if err := handToNode(cfg); err != nil {
		t.Fatal(err)
	}
	nobody, _ := user.Lookup("nobody")
	for _, name := range []string{agent.StateFile, agent.KeyFile} {
		if uid := ownerOf(t, filepath.Join(dir, name)); uid != nobody.Uid {
			t.Fatalf("%s: uid %s, want %s", name, uid, nobody.Uid)
		}
	}
}
