//go:build !unix

package selfupdate

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// openStaged: bcd runs on Linux; elsewhere a symlink or non-regular file is refused, checked
// before the open.
func openStaged(dir, name string, _ *uint32) (*os.File, error) {
	p := filepath.Join(dir, name)
	fi, err := os.Lstat(p)
	if err != nil {
		return nil, err
	}
	if fi.Mode()&fs.ModeSymlink != 0 || !fi.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	return os.Open(p)
}

// openOwned opens a binary to adopt (ownership is checked on Linux only).
func openOwned(path string) (*os.File, error) { return os.Open(path) }
