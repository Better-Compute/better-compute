package agent

import (
	"os"
	"path/filepath"
	"testing"
)

// An image's own symlinks never redirect what the ramdisk writes into it.
func TestWriteInRootStaysInTheImage(t *testing.T) {
	image, outside := t.TempDir(), t.TempDir()
	victim := filepath.Join(outside, "sdb")
	_ = os.WriteFile(victim, []byte("disk"), 0o600)

	// The file itself is a symlink out of the image: replaced, the target untouched.
	_ = os.MkdirAll(filepath.Join(image, "etc/bcd"), 0o755)
	if err := os.Symlink(victim, filepath.Join(image, "etc/bcd/config.toml")); err != nil {
		t.Skipf("symlinks: %v", err)
	}
	if err := writeInRoot(image, "etc/bcd/config.toml", []byte("gateway_url = \"x\"\n")); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(victim); string(got) != "disk" {
		t.Fatalf("the symlink's target was written: %q", got)
	}
	if info, err := os.Lstat(filepath.Join(image, "etc/bcd/config.toml")); err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Fatalf("config.toml = %v, %v", info, err)
	}

	// A directory on the way is a symlink out of the image: refused.
	_ = os.Symlink(outside, filepath.Join(image, "var"))
	if err := writeInRoot(image, "var/lib/cloud/seed/nocloud/user-data", []byte("x")); err == nil {
		t.Fatal("a write escaped the image through a symlinked directory")
	}
	if _, err := os.Stat(filepath.Join(outside, "lib")); err == nil {
		t.Fatal("directories were created outside the image")
	}
}
