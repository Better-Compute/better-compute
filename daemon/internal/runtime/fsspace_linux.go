//go:build linux

package runtime

import (
	"os"
	"syscall"
)

// statfsBytes is the filesystem holding dir: its size, and what an unprivileged writer may still use.
func statfsBytes(dir string) (total, avail uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, 0, err
	}
	return st.Blocks * uint64(st.Bsize), st.Bavail * uint64(st.Bsize), nil
}

// allocatedBytes is what a (sparse) file occupies on disk.
func allocatedBytes(info os.FileInfo) uint64 {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Blocks) * 512
	}
	return uint64(info.Size())
}
