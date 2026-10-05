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
	"regexp"
	"sort"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// hw.read (read-only): the inventory details only root can read, for an unprivileged bcd node.
//   - DIMMs: SMBIOS type 17 structures (/sys/firmware/dmi/entries/17-*/raw, mode 0400), parsed here;
//     only the parsed values go back, never the raw table.
//   - NVMe health: each controller's SMART / Health log (inventory.NVMeHealth: /dev/nvmeN opened
//     O_RDONLY, one Get Log Page, opcode 0x02 log 0x02, 5 s kernel timeout per command).
//
// The op takes no arguments: the entries and controllers are enumerated here, never named by the
// node. At most maxHWEntries of each, within hwBudget overall.

const (
	maxHWEntries = 64
	maxSMBIOSRaw = 4 << 10
	hwBudget     = 30 * time.Second
)

var (
	smbiosMemoryEntry = regexp.MustCompile(`^17-[0-9]+$`)
	nvmeControllerDir = regexp.MustCompile(`^nvme[0-9]+$`)
)

// HWInfo is hw.read's answer.
type HWInfo struct {
	Dimms []*inventory.Dimm               `json:"dimms,omitempty"`
	NVMe  map[string]*inventory.SmartStatus `json:"nvme,omitempty"`
}

func (s *Server) hwRead(ctx context.Context, req Request) (*HWInfo, error) {
	if !reflect.DeepEqual(req, Request{V: req.V, Op: req.Op}) {
		return nil, errors.New("hw.read takes no arguments")
	}
	ctx, cancel := context.WithTimeout(ctx, hwBudget)
	defer cancel()
	base := s.Root
	if base == "" {
		base = "/"
	}
	out := &HWInfo{Dimms: inventory.DimmsFromSMBIOS(readMemoryDevices(filepath.Join(base, "sys", "firmware", "dmi", "entries")))}

	health := s.NVMeHealth
	if health == nil {
		health = inventory.NVMeHealth
	}
	entries, err := os.ReadDir(filepath.Join(base, "sys", "class", "nvme"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	var ctrls []string
	for _, e := range entries {
		if nvmeControllerDir.MatchString(e.Name()) {
			ctrls = append(ctrls, e.Name())
		}
	}
	sort.Strings(ctrls)
	for _, ctrl := range ctrls {
		if len(out.NVMe) >= maxHWEntries || ctx.Err() != nil {
			break // the rest stay unknown, as for an unprivileged read
		}
		if h := health(ctrl); h != nil {
			if out.NVMe == nil {
				out.NVMe = map[string]*inventory.SmartStatus{}
			}
			out.NVMe[ctrl] = h
		}
	}
	return out, nil
}

// readMemoryDevices reads up to maxHWEntries type 17 structures, each a regular file (never
// through a symlink) of at most maxSMBIOSRaw bytes.
func readMemoryDevices(dir string) [][]byte {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil
	}
	defer root.Close()
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return nil
	}
	var raws [][]byte
	for _, e := range entries {
		if len(raws) >= maxHWEntries {
			break
		}
		if !smbiosMemoryEntry.MatchString(e.Name()) {
			continue
		}
		name := e.Name() + "/raw"
		if fi, err := root.Lstat(name); err != nil || !fi.Mode().IsRegular() {
			continue
		}
		f, err := root.Open(name)
		if err != nil {
			continue
		}
		b, err := io.ReadAll(io.LimitReader(f, maxSMBIOSRaw))
		f.Close()
		if err == nil {
			raws = append(raws, b)
		}
	}
	return raws
}

// ReadHW asks the helper for the root-only inventory details (DIMMs, NVMe health). An error reads as
// none: the inventory carries what an unprivileged read saw.
func (c Client) ReadHW(ctx context.Context) (*HWInfo, error) {
	raw, err := c.Call(ctx, Request{Op: "hw.read"})
	if err != nil {
		return nil, err
	}
	var out HWInfo
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
