//go:build unix

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// bcd helper's config.toml ([host] units, the pins) must be root's alone: a file the node could have
// written, or a link to one, decides nothing.
func TestRootOnlyFile(t *testing.T) {
	if err := rootOnlyFile("/etc/passwd"); err != nil {
		t.Fatalf("/etc/passwd: %v", err)
	}
	dir := t.TempDir()
	mine := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(mine, []byte("# not root's\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.toml")
	if err := os.Symlink("/etc/passwd", link); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{mine, link, "/etc", "/etc/bcd-no-such-config.toml"} {
		if err := rootOnlyFile(f); err == nil {
			t.Fatalf("%s was taken as root's config", f)
		}
	}
}
