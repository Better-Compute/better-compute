//go:build unix

package helper

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// NodeFileCheck is DomainPolicy.CheckFile for a node running as uid: from the policy directory the
// file lies under down to the file, no component is a symlink, and the file is a regular file of
// the node's with one link. A disk path can then not lead libvirt (which chowns disks to qemu) to a
// file the node does not own.
//
// The node owns these directories, so it could still swap a component between this check and
// libvirt's open: under bcd helper, libvirt's dynamic_ownership is off (the install sets it), so
// qemu opens only what the node's group lets it, and this check is the second line.
func NodeFileCheck(dirs []string, uid int) func(string) error {
	return func(file string) error {
		var base string
		for _, dir := range dirs {
			if strings.HasPrefix(file, strings.TrimSuffix(dir, "/")+"/") {
				base = dir
			}
		}
		if base == "" {
			return errors.New("not under a policy directory")
		}
		rel, err := filepath.Rel(base, file)
		if err != nil || strings.HasPrefix(rel, "..") {
			return errors.New("not under a policy directory")
		}
		at := base
		parts := strings.Split(rel, string(filepath.Separator))
		for i, part := range parts {
			at = filepath.Join(at, part)
			fi, err := os.Lstat(at)
			if err != nil {
				return err
			}
			if fi.Mode()&fs.ModeSymlink != 0 {
				return fmt.Errorf("%s is a symlink", at)
			}
			if i < len(parts)-1 {
				if !fi.IsDir() {
					return fmt.Errorf("%s is not a directory", at)
				}
				continue
			}
			st, ok := fi.Sys().(*syscall.Stat_t)
			if !fi.Mode().IsRegular() || !ok {
				return errors.New("not a regular file")
			}
			if int(st.Uid) != uid || st.Nlink != 1 {
				return fmt.Errorf("owned by uid %d with %d links, not the node's (%d) alone", st.Uid, st.Nlink, uid)
			}
		}
		return nil
	}
}
