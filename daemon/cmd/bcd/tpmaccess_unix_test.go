//go:build unix

package main

import (
	"os"
	"os/user"
	"path/filepath"
	"testing"
)

// bcd join (root) keeps the node key in the TPM only when bcd node's user can open the device.
func TestUserCanOpen(t *testing.T) {
	me, err := user.Current()
	if err != nil {
		t.Skip(err)
	}
	device := filepath.Join(t.TempDir(), "tpmrm0")
	if err := os.WriteFile(device, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for mode, want := range map[os.FileMode]bool{0o600: true, 0o660: true, 0o400: false, 0o000: false} {
		if err := os.Chmod(device, mode); err != nil {
			t.Fatal(err)
		}
		if got := userCanOpen(me.Username, device) == nil; got != want {
			t.Fatalf("mode %04o: can open = %v", mode, got)
		}
	}
	if other, err := user.Lookup("nobody"); err == nil && other.Uid != me.Uid {
		_ = os.Chmod(device, 0o600)
		if userCanOpen("nobody", device) == nil {
			t.Fatal("another user opens a 0600 device")
		}
		_ = os.Chmod(device, 0o666)
		if err := userCanOpen("nobody", device); err != nil {
			t.Fatal(err)
		}
	}
	if userCanOpen(me.Username, device+".missing") == nil {
		t.Fatal("a missing device opens")
	}
}
