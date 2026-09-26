//go:build linux

package runtime

import (
	"os"
	"syscall"
)

// discard punches out every block of f (FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE): the
// filesystem gives them back (and discards them on a device that supports it) before the file is
// unlinked, so a destroyed volume's data does not linger in blocks the next file reuses.
func discard(f *os.File, size int64) error {
	const punchHole, keepSize = 0x02, 0x01
	err := syscall.Fallocate(int(f.Fd()), punchHole|keepSize, 0, size)
	if err == syscall.EOPNOTSUPP {
		// A filesystem without hole punching: overwrite nothing, just unlink.
		return nil
	}
	return err
}
