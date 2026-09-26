package runtime

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// A read-only volume is readable by exactly the VMM users that have it open, and root's 0600 again
// once the last one stops.
func TestReadOnlyVolumesAreSharedPerVMM(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vol_ro.raw")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := aclReaders(path); errors.Is(err, errors.ErrUnsupported) {
		t.Skip("no POSIX ACLs on this filesystem")
	}
	c := &CloudHypervisor{Dir: t.TempDir()}
	for _, uid := range []int{70001, 70002} {
		if err := c.shareReadOnly(path, uid); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := aclReaders(path); err != nil || !slices.Equal(got, []int{70001, 70002}) {
		t.Fatalf("readers = %v, %v", got, err)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o640 { // group bits show the ACL mask
		t.Fatalf("mode %v", info.Mode())
	}
	if err := c.unshareReadOnly(path, 70001, "inst_a"); err != nil {
		t.Fatal(err)
	}
	if got, _ := aclReaders(path); !slices.Equal(got, []int{70002}) {
		t.Fatalf("after one stop: %v", got)
	}
	if err := c.unshareReadOnly(path, 70002, "inst_b"); err != nil {
		t.Fatal(err)
	}
	if got, _ := aclReaders(path); len(got) != 0 {
		t.Fatalf("after the last stop: %v", got)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v after the last reader", info.Mode())
	}
}
