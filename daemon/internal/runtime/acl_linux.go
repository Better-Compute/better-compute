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

// aclErr maps a filesystem without ACLs to errors.ErrUnsupported.
func aclErr(err error) error {
	if errors.Is(err, syscall.EOPNOTSUPP) || errors.Is(err, syscall.ENOTSUP) {
		return fmt.Errorf("%w: %v", errors.ErrUnsupported, err)
	}
	return err
}
