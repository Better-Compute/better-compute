package main

import (
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
)

func TestReadTokenFile(t *testing.T) {
	if goruntime.GOOS == "windows" {
		t.Skip("file modes")
	}
	dir := t.TempDir()
	token := "bcjt_01k5w0000000000000000000000.secret\n"
	private := filepath.Join(dir, "private")
	if err := os.WriteFile(private, []byte(token), 0o600); err != nil {
		t.Fatal(err)
	}
	if b, err := readTokenFile(private); err != nil || string(b) != token {
		t.Fatalf("0600: %q %v", b, err)
	}
	// A Kubernetes Secret volume: 0400, reached through a symlink into ..data.
	data := filepath.Join(dir, "..data")
	_ = os.Mkdir(data, 0o755)
	target := filepath.Join(data, "join-token")
	_ = os.WriteFile(target, []byte(token), 0o400)
	link := filepath.Join(dir, "join-token")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readTokenFile(link); err != nil {
		t.Fatalf("secret volume: %v", err)
	}
	for mode, name := range map[os.FileMode]string{0o644: "world", 0o640: "group"} {
		p := filepath.Join(dir, name)
		_ = os.WriteFile(p, []byte(token), 0o600)
		_ = os.Chmod(p, mode)
		if _, err := readTokenFile(p); err == nil || !strings.Contains(err.Error(), "readable by others") {
			t.Fatalf("%04o: %v", mode, err)
		}
	}
	if _, err := readTokenFile(dir); err == nil {
		t.Fatal("a directory was read")
	}
	big := filepath.Join(dir, "big")
	_ = os.WriteFile(big, []byte(strings.Repeat("x", maxTokenFile+1)), 0o600)
	if _, err := readTokenFile(big); err == nil {
		t.Fatal("an oversized file was read")
	}
}
