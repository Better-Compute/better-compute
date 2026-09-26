//go:build unix

package helper

import (
	"io/fs"
	"syscall"
)

// rootOnly reports whether a directory is root's and no one else can write it.
// fileOwner is a file's owner uid (ok false where the platform does not say).
func fileOwner(fi fs.FileInfo) (uint32, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return st.Uid, true
}

func rootOnly(fi fs.FileInfo) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && st.Uid == 0 && fi.Mode().Perm()&0o022 == 0
}
