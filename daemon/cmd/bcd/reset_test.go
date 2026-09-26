package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/agent"
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
	for _, name := range []string{agent.StateFile, agent.KeyFile} {
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
	if len(names) != 2 || !strings.HasPrefix(names[0], agent.StateFile+".reset-") || !strings.HasPrefix(names[1], agent.KeyFile+".reset-") {
		t.Fatalf("after the reset: %v", names)
	}
	if _, _, err := agent.LoadState(dir); err == nil {
		t.Fatal("an identity still loads")
	}
}
