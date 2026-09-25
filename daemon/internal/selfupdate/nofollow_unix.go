//go:build unix

package selfupdate

import (
	"os"
	"syscall"
)

// openNoFollow opens a file for reading, refusing a symlink in its last component.
func openNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}
