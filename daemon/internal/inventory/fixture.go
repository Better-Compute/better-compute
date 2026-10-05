package inventory

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Captured hosts travel as .tar.gz fixtures: sysfs is mostly symlinks, which a git checkout on
// Windows (core.symlinks=false) turns into text files. A tarball keeps them, and tests extract it
// into a temporary directory before replaying it (testdata/hosts/*.tar.gz).

var fixtureTime = time.Unix(0, 0).UTC()

// WriteFixture archives the capture directory dir as a gzipped tar at file.
func WriteFixture(dir, file string) error {
	f, err := os.Create(file)
	if err != nil {
		return err
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	walkErr := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil || rel == "." {
			return err
		}
		info, err := os.Lstat(p)
		if err != nil {
			return err
		}
		link := ""
		if info.Mode()&fs.ModeSymlink != 0 {
			if link, err = os.Readlink(p); err != nil {
				return err
			}
		}
		h, err := tar.FileInfoHeader(info, filepath.ToSlash(link))
		if err != nil {
			return err
		}
		h.Name = filepath.ToSlash(rel)
		// Reproducible archives: no owners, times or modes beyond what matters.
		h.Uid, h.Gid, h.Uname, h.Gname = 0, 0, "", ""
		h.ModTime = fixtureTime
		h.AccessTime, h.ChangeTime = fixtureTime, fixtureTime
		h.Format = tar.FormatPAX
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			b, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			_, err = tw.Write(b)
			return err
		}
		return nil
	})
	for _, closeErr := range []error{walkErr, tw.Close(), gz.Close(), f.Close()} {
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

// ExtractFixture unpacks a fixture archive into dir (which must exist). Paths that would leave dir
// and absolute symlink targets are refused: a fixture only ever describes its own tree.
func ExtractFixture(file, dir string) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		name := filepath.FromSlash(h.Name)
		if !filepath.IsLocal(name) {
			return fmt.Errorf("fixture entry %q leaves the tree", h.Name)
		}
		out := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(out, 0o755); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if filepath.IsAbs(h.Linkname) || strings.HasPrefix(h.Linkname, "/") {
				return fmt.Errorf("fixture link %q has an absolute target", h.Name)
			}
			if err := os.Symlink(filepath.FromSlash(h.Linkname), out); err != nil {
				return err
			}
		case tar.TypeReg:
			w, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(w, io.LimitReader(tr, 16<<20))
			if err := w.Close(); copyErr != nil || err != nil {
				return errors.Join(copyErr, err)
			}
		}
	}
}
