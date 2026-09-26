//go:build unix

package hostconfig

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// checkRootPath refuses to let root write under a directory another user controls: every existing
// directory from / down to dir must be a real directory (no symlink) that root owns and no one else
// can write. A directory that does not exist yet is created by root inside a checked parent. It is
// checked only when this process is root (bcd node as root, or bcd helper).
func checkRootPath(dir string) error {
	if os.Geteuid() != 0 {
		return nil
	}
	dir = filepath.Clean(dir)
	var dirs []string
	for d := dir; ; d = filepath.Dir(d) {
		dirs = append([]string{d}, dirs...)
		if d == "/" || d == "." {
			break
		}
	}
	for _, d := range dirs {
		fi, err := os.Lstat(d)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !fi.IsDir() || fi.Mode()&fs.ModeSymlink != 0 || !ok || st.Uid != 0 || fi.Mode().Perm()&0o022 != 0 {
			return fmt.Errorf("%s is not a directory only root can write: bcd will not write as root under it", d)
		}
	}
	return nil
}
