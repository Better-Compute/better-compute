package inventory

import (
	"encoding/binary"
	"os"
	"strconv"
	"strings"
)

// DIMMs. The firmware's SMBIOS table lists each memory device (type 17: slot, size, speed, type,
// part, serial); the kernel exports every structure under /sys/firmware/dmi/entries/<type>-<n>/raw,
// root-only, which is how dmidecode reads them too, so no tool is needed. An unprivileged run falls
// back to EDAC's per-DIMM view (/sys/devices/system/edac/mc/mc*/dimm*, world-readable: slot label,
// size, type and ECC mode, no part or serial) where an EDAC driver is loaded.

func (c Collector) dimms() []*Dimm {
	if out := c.smbiosDimms(); len(out) > 0 {
		return out
	}
	return c.edacDimms()
}

func (c Collector) readRaw(abs string) []byte {
	b, err := os.ReadFile(c.p(abs))
	if err != nil {
		return nil
	}
	return b
}

func (c Collector) smbiosDimms() []*Dimm {
	var out []*Dimm
	for _, name := range c.list("/sys/firmware/dmi/entries") {
		if !strings.HasPrefix(name, "17-") {
			continue
		}
		if d := parseMemoryDevice(c.readRaw("/sys/firmware/dmi/entries/" + name + "/raw")); d != nil {
			out = append(out, d)
		}
	}
	return uniqueSlots(out)
}

// smbiosMemoryTypes names SMBIOS 3.x memory types (type 17, offset 0x12).
var smbiosMemoryTypes = map[byte]string{
	0x12: "DDR", 0x13: "DDR2", 0x14: "DDR2 FB-DIMM", 0x18: "DDR3", 0x1a: "DDR4", 0x1b: "LPDDR", 0x1c: "LPDDR2",
	0x1d: "LPDDR3", 0x1e: "LPDDR4", 0x1f: "Logical non-volatile device", 0x20: "HBM", 0x21: "HBM2", 0x22: "DDR5",
	0x23: "LPDDR5", 0x24: "HBM3",
}

// parseMemoryDevice reads one SMBIOS type 17 structure (formatted area, then its strings); nil for
// anything else, a truncated structure, or an empty slot.
func parseMemoryDevice(raw []byte) *Dimm {
	if len(raw) < 0x15 || raw[0] != 17 || int(raw[1]) > len(raw) || raw[1] < 0x15 {
		return nil
	}
	formatted := raw[:raw[1]]
	strs := smbiosStrings(raw[raw[1]:])
	str := func(off int) string {
		if off >= len(formatted) {
			return ""
		}
		i := int(formatted[off])
		if i == 0 || i > len(strs) {
			return ""
		}
		return strings.TrimSpace(strs[i-1])
	}
	word := func(off int) uint16 {
		if off+2 > len(formatted) {
			return 0
		}
		return binary.LittleEndian.Uint16(formatted[off:])
	}
	dword := func(off int) uint32 {
		if off+4 > len(formatted) {
			return 0
		}
		return binary.LittleEndian.Uint32(formatted[off:])
	}

	var size uint64
	switch s := word(0x0c); {
	case s == 0:
		return nil // no module in this slot
	case s == 0xffff:
		// unknown size: the slot is populated, the firmware cannot say with what
	case s == 0x7fff:
		size = uint64(dword(0x1c)&0x7fffffff) << 20
	case s&0x8000 != 0:
		size = uint64(s&0x7fff) << 10
	default:
		size = uint64(s) << 20
	}
	d := &Dimm{
		Slot:         str(0x10),
		SizeBytes:    size,
		Type:         smbiosMemoryTypes[formatted[0x12]],
		Manufacturer: str(0x17),
		Serial:       str(0x18),
		PartNumber:   str(0x1a),
	}
	if d.Slot == "" {
		d.Slot = str(0x11)
	}
	// The speed it runs at (configured), else its rated speed; 0xffff defers to the 32-bit field.
	for _, off := range [][2]int{{0x20, 0x58}, {0x15, 0x54}} {
		if v := word(off[0]); v != 0 && v != 0xffff {
			d.SpeedMts = uint32(v)
		} else if v == 0xffff {
			d.SpeedMts = dword(off[1])
		}
		if d.SpeedMts != 0 {
			break
		}
	}
	// ECC: a total width wider than the data width carries check bits (72 vs 64; 80 vs 64 on DDR5).
	if total, data := word(0x08), word(0x0a); total != 0xffff && data != 0xffff && total > data {
		d.Ecc = true
	}
	for _, p := range []*string{&d.Manufacturer, &d.Serial, &d.PartNumber} {
		if IsPlaceholderDMI(*p) || strings.EqualFold(*p, "unknown") || strings.HasPrefix(strings.ToLower(*p), "not specified") {
			*p = ""
		}
	}
	return d
}

// smbiosStrings splits a structure's string set (NUL-terminated, ended by an empty string).
func smbiosStrings(b []byte) []string {
	var out []string
	for len(b) > 0 {
		i := 0
		for i < len(b) && b[i] != 0 {
			i++
		}
		if i == 0 {
			break
		}
		out = append(out, string(b[:i]))
		if i == len(b) {
			break
		}
		b = b[i+1:]
	}
	return out
}

// uniqueSlots qualifies slot names a board repeats per socket ("A1" under CPU0 and CPU1) with
// their position, so every DIMM keeps its own entry once sorted by slot.
func uniqueSlots(dimms []*Dimm) []*Dimm {
	count := map[string]int{}
	for _, d := range dimms {
		count[d.Slot]++
	}
	seen := map[string]int{}
	for _, d := range dimms {
		if count[d.Slot] > 1 {
			seen[d.Slot]++
			d.Slot += "#" + strconv.Itoa(seen[d.Slot])
		}
	}
	return dimms
}

// edacDimms reads EDAC's per-DIMM directories (dimmN; rankN on older drivers).
func (c Collector) edacDimms() []*Dimm {
	var out []*Dimm
	base := "/sys/devices/system/edac/mc"
	for _, mc := range c.list(base) {
		if !strings.HasPrefix(mc, "mc") {
			continue
		}
		for _, name := range c.list(base + "/" + mc) {
			if !strings.HasPrefix(name, "dimm") && !strings.HasPrefix(name, "rank") {
				continue
			}
			if _, err := strconv.Atoi(strings.TrimLeft(name, "dimrank")); err != nil {
				continue
			}
			dir := base + "/" + mc + "/" + name
			mib, ok := c.uint(dir + "/size")
			if !ok || mib == 0 {
				continue
			}
			d := &Dimm{Slot: c.read(dir + "/dimm_label"), SizeBytes: mib << 20}
			if d.Slot == "" {
				d.Slot = mc + "/" + name
			}
			// "Registered-DDR5", "Unbuffered-DDR4".
			if t := c.read(dir + "/dimm_mem_type"); t != "" && !strings.EqualFold(t, "unknown") {
				d.Type = t[strings.LastIndex(t, "-")+1:]
			}
			switch mode := c.read(dir + "/dimm_edac_mode"); mode {
			case "", "None", "Unknown", "Reserved":
			default:
				d.Ecc = true
			}
			out = append(out, d)
		}
	}
	return uniqueSlots(out)
}

// redactMemoryDevice rewrites a type 17 structure's serial and asset tag strings for a fixture.
func redactMemoryDevice(raw []byte) []byte {
	if len(raw) < 0x1b || raw[0] != 17 || int(raw[1]) > len(raw) || raw[1] < 0x1b {
		return raw
	}
	formatted := raw[:raw[1]]
	strs := smbiosStrings(raw[raw[1]:])
	for _, off := range []int{0x18, 0x19} {
		if i := int(formatted[off]); i > 0 && i <= len(strs) {
			if v := strings.TrimSpace(strs[i-1]); !IsPlaceholderDMI(v) {
				strs[i-1] = "R" + strings.ToUpper(stable(v, max(7, len(v)-1)))
			}
		}
	}
	out := append([]byte{}, formatted...)
	for _, s := range strs {
		out = append(append(out, s...), 0)
	}
	if len(strs) == 0 {
		out = append(out, 0)
	}
	return append(out, 0)
}
