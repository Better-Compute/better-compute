package runtime

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// A grant adds (and takes away) one user's entry, keeps the others, and on a directory is inherited
// by what is created in it.
func TestACLGrantsInheritAndRevoke(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "inst")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := aclGrant(dir, 70001, aclRWX, true); errors.Is(err, errors.ErrUnsupported) {
		t.Skip("no POSIX ACLs on this filesystem")
	} else if err != nil {
		t.Fatal(err)
	}
	if err := aclGrant(dir, 70002, aclRead, false); err != nil {
		t.Fatal(err)
	}
	entries, _ := readACLEntries(dir, aclXattr)
	perms := map[uint32]uint16{}
	for _, e := range entries {
		if e.tag == aclUser {
			perms[e.id] = e.perm
		}
	}
	if perms[70001] != aclRWX || perms[70002] != aclRead {
		t.Fatalf("entries = %+v", entries)
	}
	// Created inside: inherits 70001 (the default ACL), not 70002 (not inherited).
	file := filepath.Join(dir, "api.sock")
	if err := os.WriteFile(file, nil, 0o660); err != nil {
		t.Fatal(err)
	}
	inherited, _ := readACLEntries(file, aclXattr)
	found := false
	for _, e := range inherited {
		if e.tag == aclUser && e.id == 70001 {
			found = true
		}
		if e.tag == aclUser && e.id == 70002 {
			t.Fatalf("a non-inherited grant was inherited: %+v", inherited)
		}
	}
	if !found {
		t.Fatalf("not inherited: %+v", inherited)
	}
	if err := aclGrant(dir, 70001, 0, true); err != nil {
		t.Fatal(err)
	}
	entries, _ = readACLEntries(dir, aclXattr)
	for _, e := range entries {
		if e.tag == aclUser && e.id == 70001 {
			t.Fatalf("not revoked: %+v", entries)
		}
	}
}

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
