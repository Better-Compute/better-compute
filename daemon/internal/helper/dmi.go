package helper

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
)

// dmi.read (read-only): the DMI values sysfs keeps root-only (mode 0400), which an unprivileged
// bcd node reads empty: the product UUID and the serials its hardware key is built from. The op
// takes no arguments; the files are a fixed list under /sys/class/dmi/id, each opened without
// following a symlink, capped at 128 bytes, trimmed, and stripped of anything non-printable.

// DMIFiles are the files dmi.read returns, by sysfs name.
var DMIFiles = []string{"product_uuid", "product_serial", "board_serial", "chassis_serial", "board_asset_tag", "chassis_asset_tag"}

const dmiDir = "/sys/class/dmi/id"

// maxDMIValue caps one value (SMBIOS strings are far shorter).
const maxDMIValue = 128

// dmiRead serves dmi.read: refuses any argument, then reads the fixed list.
func (s *Server) dmiRead(req Request) (map[string]string, error) {
	if !reflect.DeepEqual(req, Request{V: req.V, Op: req.Op}) {
		return nil, errors.New("dmi.read takes no arguments")
	}
	base := s.Root
	if base == "" {
		base = "/"
	}
	out := make(map[string]string, len(DMIFiles))
	dir, err := os.OpenRoot(filepath.Join(base, filepath.FromSlash(strings.TrimPrefix(dmiDir, "/"))))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return out, nil // no SMBIOS on this machine
		}
		return nil, err
	}
	defer dir.Close()
	for _, name := range DMIFiles {
		out[name] = readDMIValue(dir, name)
	}
	return out, nil
}

// readDMIValue reads one file of the list; a missing, unreadable or symlinked file reads empty.
func readDMIValue(dir *os.Root, name string) string {
	fi, err := dir.Lstat(name)
	if err != nil || !fi.Mode().IsRegular() {
		return ""
	}
	f, err := dir.Open(name)
	if err != nil {
		return ""
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxDMIValue))
	if err != nil {
		return ""
	}
	return printable(string(b))
}

// printable keeps printable ASCII only (dropping the rest, never escaping it), trimmed.
func printable(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 0x20 && r < 0x7f {
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

// ReadDMI asks the helper for the root-only DMI values (inventory.Collector.DMI). An error reads as
// no values: the inventory then carries what an unprivileged read saw.
func (c Client) ReadDMI(ctx context.Context) (map[string]string, error) {
	raw, err := c.Call(ctx, Request{Op: "dmi.read"})
	if err != nil {
		return nil, err
	}
	var out map[string]string
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}
