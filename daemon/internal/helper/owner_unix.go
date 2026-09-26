//go:build unix

package helper

import (
	"io/fs"
	"syscall"
)

// rootOnly reports whether a directory is root's and no one else can write it.
func rootOnly(fi fs.FileInfo) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && st.Uid == 0 && fi.Mode().Perm()&0o022 == 0
}
