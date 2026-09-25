//go:build linux

package agent

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

// A FIFO (or device node) where bcd writes is replaced, never written through: opening a FIFO for
// writing would block the ramdisk, and a device node would be the disk itself.
func TestWriteInRootReplacesSpecialFiles(t *testing.T) {
	image := t.TempDir()
	_ = os.MkdirAll(filepath.Join(image, "etc/bcd"), 0o755)
	fifo := filepath.Join(image, "etc/bcd/join-encryption.jwk")
	if err := unix.Mkfifo(fifo, 0o644); err != nil {
		t.Skipf("mkfifo: %v", err)
	}
	if err := writeInRoot(image, "etc/bcd/join-encryption.jwk", []byte("{}")); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(fifo); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("join-encryption.jwk = %v, %v", info, err)
	}
	if err := writeInRoot(image, "etc", []byte("x")); err == nil {
		t.Fatal("a directory was replaced")
	}
}
