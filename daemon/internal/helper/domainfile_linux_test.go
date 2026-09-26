package helper

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNodeFileCheck(t *testing.T) {
	base := t.TempDir()
	inst := filepath.Join(base, "instances", "inst_1")
	if err := os.MkdirAll(inst, 0o755); err != nil {
		t.Fatal(err)
	}
	disk := filepath.Join(inst, "disk.qcow2")
	_ = os.WriteFile(disk, []byte("x"), 0o600)
	check := NodeFileCheck([]string{filepath.Join(base, "instances")}, os.Getuid())
	if err := check(disk); err != nil {
		t.Fatal(err)
	}
	// A symlinked file, a symlinked directory on the way, a hard link, another uid's file.
	_ = os.Symlink("/etc/passwd", filepath.Join(inst, "evil.qcow2"))
	outside := t.TempDir()
	_ = os.WriteFile(filepath.Join(outside, "disk.qcow2"), []byte("x"), 0o600)
	_ = os.Symlink(outside, filepath.Join(base, "instances", "inst_2"))
	_ = os.Link(disk, filepath.Join(inst, "twin.qcow2"))
	for what, file := range map[string]string{
		"symlinked file":  filepath.Join(inst, "evil.qcow2"),
		"symlinked dir":   filepath.Join(base, "instances", "inst_2", "disk.qcow2"),
		"hard link":       filepath.Join(inst, "twin.qcow2"),
		"outside the dir": filepath.Join(outside, "disk.qcow2"),
	} {
		if err := check(file); err == nil {
			t.Fatalf("%s: accepted", what)
		}
	}
	if err := NodeFileCheck([]string{filepath.Join(base, "instances")}, os.Getuid()+1)(filepath.Join(base, "instances", "inst_1", "sub")); err == nil {
		t.Fatal("a missing file was accepted")
	}
	_ = os.Remove(filepath.Join(inst, "twin.qcow2"))
	if err := NodeFileCheck([]string{filepath.Join(base, "instances")}, os.Getuid()+1)(disk); err == nil || !strings.Contains(err.Error(), "not the node's") {
		t.Fatalf("another uid's file: %v", err)
	}
}
