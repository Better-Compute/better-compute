//go:build unix

package main

import (
	"fmt"
	"os"
	"syscall"
)

// rootOnlyDir refuses a directory another user could write to (or that is not root's).
func rootOnlyDir(dir string) error {
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !fi.IsDir() || !ok || st.Uid != 0 || fi.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("%s must be a directory root owns that no one else can write (the helper socket lives there)", dir)
	}
	return nil
}
