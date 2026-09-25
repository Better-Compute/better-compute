//go:build unix

package selfupdate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// openStaged opens dir/name for reading without following a symlink anywhere below dir's parent
// (os.Root), without blocking on a FIFO (O_NONBLOCK), and only as a regular file with one link,
// owned by uid when uid is set.
func openStaged(dir, name string, uid *uint32) (*os.File, error) {
	root, err := os.OpenRoot(filepath.Dir(dir))
	if err != nil {
		return nil, err
	}
	defer root.Close()
	base := filepath.Base(dir)
	fi, err := root.Lstat(base)
	if err != nil {
		return nil, err
	}
	if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		return nil, errors.New("the staging directory is not a plain directory")
	}
	f, err := root.OpenFile(filepath.Join(base, name), os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	switch {
	case !st.Mode().IsRegular() || !ok:
		err = errors.New("not a regular file")
	case sys.Nlink != 1:
		err = fmt.Errorf("%d links", sys.Nlink)
	case uid != nil && sys.Uid != *uid:
		err = fmt.Errorf("owned by uid %d", sys.Uid)
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
