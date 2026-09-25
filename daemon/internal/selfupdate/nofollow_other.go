//go:build !unix

package selfupdate

import (
	"errors"
	"io/fs"
	"os"
)

// openNoFollow opens a file for reading, refusing a symlink (checked, then opened: bcd runs on
// Linux, where the unix version refuses in the open itself).
func openNoFollow(path string) (*os.File, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		return nil, errors.New("selfupdate: a symlink is not a staged binary")
	}
	return os.Open(path)
}
