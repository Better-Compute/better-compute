//go:build linux

package runtime

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"slices"
	"syscall"
)

// POSIX access ACLs (system.posix_acl_access, the kernel's xattr format): a read-only volume is
// root's 0600 plus read for exactly the VMM users that have it open, instead of a group every VMM
// shares.

const (
	aclXattr    = "system.posix_acl_access"
	aclVersion  = 2
	aclUserObj  = 0x01
	aclUser     = 0x02
	aclGroupObj = 0x04
	aclMask     = 0x10
	aclOther    = 0x20
	aclRead     = 0x04
	aclRW       = 0x06
)

// aclReaders are the users path's ACL grants read to.
func aclReaders(path string) ([]int, error) {
	buf := make([]byte, 4096)
	n, err := syscall.Getxattr(path, aclXattr, buf)
	if errors.Is(err, syscall.ENODATA) {
		return nil, nil
	}
	if err != nil {
		return nil, aclErr(err)
	}
	buf = buf[:n]
	if len(buf) < 4 || binary.LittleEndian.Uint32(buf) != aclVersion || (len(buf)-4)%8 != 0 {
		return nil, fmt.Errorf("%s: not a POSIX ACL", path)
	}
	var uids []int
	for i := 4; i < len(buf); i += 8 {
		if binary.LittleEndian.Uint16(buf[i:]) == aclUser {
			uids = append(uids, int(binary.LittleEndian.Uint32(buf[i+4:])))
		}
	}
	return uids, nil
}

// setACLReaders makes path root's 0600 plus read for exactly uids (none: no ACL at all).
func setACLReaders(path string, uids []int) error {
	if err := os.Lchown(path, 0, 0); err != nil && !errors.Is(err, syscall.EPERM) {
		return err
	}
	if len(uids) == 0 {
		if err := syscall.Removexattr(path, aclXattr); err != nil && !errors.Is(err, syscall.ENODATA) {
			return aclErr(err)
		}
		return os.Chmod(path, 0o600)
	}
	uids = slices.Clone(uids)
	slices.Sort(uids)
	uids = slices.Compact(uids)
	entry := func(tag, perm uint16, id uint32) []byte {
		b := make([]byte, 8)
		binary.LittleEndian.PutUint16(b, tag)
		binary.LittleEndian.PutUint16(b[2:], perm)
		binary.LittleEndian.PutUint32(b[4:], id)
		return b
	}
	const undefinedID = 0xffffffff
	buf := binary.LittleEndian.AppendUint32(nil, aclVersion)
	buf = append(buf, entry(aclUserObj, aclRW, undefinedID)...)
	for _, uid := range uids {
		buf = append(buf, entry(aclUser, aclRead, uint32(uid))...)
	}
	buf = append(buf, entry(aclGroupObj, 0, undefinedID)...)
	buf = append(buf, entry(aclMask, aclRead, undefinedID)...)
	buf = append(buf, entry(aclOther, 0, undefinedID)...)
	return aclErr(syscall.Setxattr(path, aclXattr, buf, 0))
}

const (
	aclDefaultXattr = "system.posix_acl_default"
	aclRWX          = 0x07
	aclGroup        = 0x08
)

type aclEntry struct {
	tag, perm uint16
	id        uint32
}

func readACLEntries(path, name string) ([]aclEntry, error) {
	buf := make([]byte, 8192)
	n, err := syscall.Getxattr(path, name, buf)
	if errors.Is(err, syscall.ENODATA) {
		return nil, nil
	}
	if err != nil {
		return nil, aclErr(err)
	}
	buf = buf[:n]
	if len(buf) < 4 || binary.LittleEndian.Uint32(buf) != aclVersion || (len(buf)-4)%8 != 0 {
		return nil, fmt.Errorf("%s: not a POSIX ACL", path)
	}
	var out []aclEntry
	for i := 4; i < len(buf); i += 8 {
		out = append(out, aclEntry{binary.LittleEndian.Uint16(buf[i:]), binary.LittleEndian.Uint16(buf[i+2:]), binary.LittleEndian.Uint32(buf[i+4:])})
	}
	return out, nil
}

func writeACLEntries(path, name string, entries []aclEntry) error {
	slices.SortFunc(entries, func(a, b aclEntry) int {
		if a.tag != b.tag {
			return int(a.tag) - int(b.tag)
		}
		return int(int64(a.id) - int64(b.id))
	})
	buf := binary.LittleEndian.AppendUint32(nil, aclVersion)
	for _, e := range entries {
		buf = binary.LittleEndian.AppendUint16(buf, e.tag)
		buf = binary.LittleEndian.AppendUint16(buf, e.perm)
		buf = binary.LittleEndian.AppendUint32(buf, e.id)
	}
	return aclErr(syscall.Setxattr(path, name, buf, 0))
}

// withUser sets (perm > 0) or drops (perm 0) uid's entry, filling the base entries from mode and
// recomputing the mask as the union of the group class.
func withUser(entries []aclEntry, mode os.FileMode, uid int, perm uint16) []aclEntry {
	const undefinedID = 0xffffffff
	if len(entries) == 0 {
		m := uint16(mode.Perm())
		entries = []aclEntry{{aclUserObj, m >> 6 & 7, undefinedID}, {aclGroupObj, m >> 3 & 7, undefinedID}, {aclOther, m & 7, undefinedID}}
	}
	out := entries[:0:0]
	for _, e := range entries {
		if e.tag == aclMask || (e.tag == aclUser && e.id == uint32(uid)) {
			continue
		}
		out = append(out, e)
	}
	if perm > 0 {
		out = append(out, aclEntry{aclUser, perm, uint32(uid)})
	}
	var mask uint16
	named := false
	for _, e := range out {
		if e.tag == aclUser || e.tag == aclGroup || e.tag == aclGroupObj {
			mask |= e.perm
		}
		if e.tag == aclUser || e.tag == aclGroup {
			named = true
		}
	}
	if named {
		out = append(out, aclEntry{aclMask, mask, undefinedID})
	}
	return out
}

// aclGrant gives uid perm (aclRead, aclRW, aclRWX; 0 takes it away) on path, keeping every other
// entry; on a directory with inherit, the same entry goes into its default ACL, so what is created
// in it later carries it too. The owner of a file may set its ACL: no privilege needed.
func aclGrant(path string, uid int, perm uint16, inherit bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is a symlink", path)
	}
	entries, err := readACLEntries(path, aclXattr)
	if err != nil {
		return err
	}
	if err := writeACLEntries(path, aclXattr, withUser(entries, info.Mode(), uid, perm)); err != nil {
		return err
	}
	if !inherit || !info.IsDir() {
		return nil
	}
	defaults, err := readACLEntries(path, aclDefaultXattr)
	if err != nil {
		return err
	}
	return writeACLEntries(path, aclDefaultXattr, withUser(defaults, info.Mode(), uid, perm))
}

// aclErr maps a filesystem without ACLs to errors.ErrUnsupported.
func aclErr(err error) error {
	if errors.Is(err, syscall.EOPNOTSUPP) || errors.Is(err, syscall.ENOTSUP) {
		return fmt.Errorf("%w: %v", errors.ErrUnsupported, err)
	}
	return err
}
