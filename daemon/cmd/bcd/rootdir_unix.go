//go:build unix

package main

import (
	"fmt"
	"os"
	"path/filepath"
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

// rootOnlyFile refuses a file another user could have written: bcd helper's config.toml decides what
// root does for the node ([host] units, the pins), so only root may have set it. The file itself (not
// a symlink), root's, writable by no one else, in directories only root can write.
func rootOnlyFile(file string) error {
	file, err := filepath.Abs(file)
	if err != nil {
		return err
	}
	if err := rootOnlyPath(filepath.Dir(file)); err != nil {
		return err
	}
	fi, err := os.Lstat(file)
	if err != nil {
		return err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !fi.Mode().IsRegular() || !ok || st.Uid != 0 || fi.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("%s must be a regular file root owns that no one else can write", file)
	}
	return nil
}

// rootOnlyPath checks every existing directory from / down to p with rootOnlyDir (a directory that
// does not exist yet is created later by root, inside a checked parent).
func rootOnlyPath(p string) error {
	p = filepath.Clean(p)
	var dirs []string
	for d := p; ; d = filepath.Dir(d) {
		dirs = append([]string{d}, dirs...)
		if d == "/" || d == "." {
			break
		}
	}
	for _, d := range dirs {
		if _, err := os.Lstat(d); os.IsNotExist(err) {
			return nil
		}
		if err := rootOnlyDir(d); err != nil {
			return err
		}
	}
	return nil
}
