package runtime

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
)

// qcow2Header is what bcd reads of a qcow2 image before anything else opens it (security review 12,
// the verification of 933c51b): the file names a backing file and format, or an external data
// file, that the hypervisor (and qemu-img) would open. Reading the header in Go opens nothing else,
// unlike `qemu-img info`, which may follow what an image names (a VMDK descriptor's extents, a
// data file on an unpatched QEMU).
type qcow2Header struct {
	Backing       string
	BackingFormat string
	Size          uint64
}

// Header extension types (qcow2 spec).
const (
	qcow2ExtEnd           = 0x00000000
	qcow2ExtBackingFormat = 0xE2792ACA
	qcow2ExtDataFile      = 0x44415441
)

// qcow2Incompatible are the incompatible feature bits bcd accepts: dirty, corrupt, compression
// type, extended L2. Bit 2 (an external data file) and unknown bits are refused.
const qcow2Incompatible = 1<<0 | 1<<1 | 1<<3 | 1<<4

// readQcow2 parses a qcow2 image's header and header extensions; anything else, an encrypted
// image or one with an external data file is an error.
func readQcow2(path string) (*qcow2Header, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	head := make([]byte, 64<<10) // the header, its extensions and the backing name sit in the first cluster
	n, err := f.ReadAt(head, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	head = head[:n]
	if len(head) < 72 || binary.BigEndian.Uint32(head[0:4]) != 0x514649fb {
		return nil, errors.New("not a qcow2 image")
	}
	u32 := func(off int) uint32 { return binary.BigEndian.Uint32(head[off:]) }
	u64 := func(off int) uint64 { return binary.BigEndian.Uint64(head[off:]) }
	version := u32(4)
	if version != 2 && version != 3 {
		return nil, fmt.Errorf("qcow2 version %d", version)
	}
	h := &qcow2Header{Size: u64(24)}
	if u32(32) != 0 {
		return nil, errors.New("the qcow2 image is encrypted")
	}
	extStart := 72
	if version == 3 {
		if len(head) < 104 {
			return nil, errors.New("truncated qcow2 header")
		}
		if u64(72)&^qcow2Incompatible != 0 {
			return nil, fmt.Errorf("the qcow2 image has incompatible features %#x (an external data file?)", u64(72))
		}
		extStart = int(u32(100))
		if extStart < 104 || extStart > len(head) {
			return nil, errors.New("bad qcow2 header length")
		}
	}
	for off := extStart; ; {
		if off+8 > len(head) {
			return nil, errors.New("truncated qcow2 header extensions")
		}
		typ, size := u32(off), int(u32(off+4))
		off += 8
		if typ == qcow2ExtEnd {
			break
		}
		if size < 0 || off+size > len(head) {
			return nil, errors.New("truncated qcow2 header extension")
		}
		switch typ {
		case qcow2ExtDataFile:
			return nil, errors.New("the qcow2 image names an external data file")
		case qcow2ExtBackingFormat:
			h.BackingFormat = string(head[off : off+size])
		}
		off += (size + 7) &^ 7
	}
	if boff, bsize := u64(8), int(u32(16)); boff != 0 || bsize != 0 {
		if bsize <= 0 || bsize > 1023 || bsize > len(head) || boff > uint64(len(head)-bsize) {
			return nil, errors.New("bad qcow2 backing file name")
		}
		h.Backing = string(head[boff : boff+uint64(bsize)])
	}
	return h, nil
}

// checkBase refuses a tenant's base image that would make anything open another file: a qcow2 that
// names a backing or data file, is encrypted or is not qcow2 at all. Raw and iso images are opened
// with their format stated everywhere (never probed), so their content is only data.
func checkBase(path, format string) error {
	if format != "qcow2" {
		return nil
	}
	h, err := readQcow2(path)
	if err != nil {
		return fmt.Errorf("the image is not a plain qcow2: %w", err)
	}
	if h.Backing != "" {
		return errors.New("the image names a backing file")
	}
	return nil
}

// CheckOverlay is checkOverlay, for bcd helper: root checks the disk of a domain it defines again,
// since the node wrote it.
func CheckOverlay(path, base, baseFormat string) error { return checkOverlay(path, base, baseFormat) }

// CheckBase is checkBase, for bcd helper (a domain's cdrom and backing base).
func CheckBase(path, format string) error { return checkBase(path, format) }

// checkOverlay checks an instance's disk before anything opens it (every start, snapshot and
// resize): a VMM that once ran it can rewrite its header. The disk is bcd's overlay on base (format
// baseFormat), or a flat disk when base is empty (a restored snapshot, an iso install).
func checkOverlay(path, base, baseFormat string) error {
	h, err := readQcow2(path)
	if err != nil {
		return fmt.Errorf("the instance's disk: %w", err)
	}
	if h.Backing != base || (base != "" && h.BackingFormat != baseFormat) {
		return fmt.Errorf("the instance's disk names backing file %q (%s), not bcd's %q (%s)", h.Backing, h.BackingFormat, base, baseFormat)
	}
	return nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
