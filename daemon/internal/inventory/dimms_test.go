package inventory

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

// memoryDevice builds an SMBIOS 3.3 type 17 structure (0x5c bytes formatted) with its strings:
// device locator, bank locator, manufacturer, serial, asset tag, part number (empty: no string).
type memDev struct {
	size, totalWidth, dataWidth, speed, configured uint16
	extSize, extSpeed                              uint32
	memType                                        byte
	locator, bank, maker, serial, asset, part      string
}

func (m memDev) raw() []byte {
	f := make([]byte, 0x5c)
	f[0], f[1] = 17, 0x5c
	le := binary.LittleEndian
	le.PutUint16(f[0x08:], m.totalWidth)
	le.PutUint16(f[0x0a:], m.dataWidth)
	le.PutUint16(f[0x0c:], m.size)
	f[0x12] = m.memType
	le.PutUint16(f[0x15:], m.speed)
	le.PutUint32(f[0x1c:], m.extSize)
	le.PutUint16(f[0x20:], m.configured)
	le.PutUint32(f[0x54:], m.extSpeed)
	var strs []string
	for _, s := range []struct {
		off int
		v   string
	}{{0x10, m.locator}, {0x11, m.bank}, {0x17, m.maker}, {0x18, m.serial}, {0x19, m.asset}, {0x1a, m.part}} {
		if s.v != "" {
			strs = append(strs, s.v)
			f[s.off] = byte(len(strs))
		}
	}
	for _, s := range strs {
		f = append(append(f, s...), 0)
	}
	if len(strs) == 0 {
		f = append(f, 0)
	}
	return append(f, 0)
}

var rdimm = memDev{
	size: 0x7fff, extSize: 65536, totalWidth: 80, dataWidth: 64, speed: 5600, configured: 4800, memType: 0x22,
	locator: "DIMM_A1", bank: "P0 CHANNEL A", maker: "Samsung", serial: "S3R1AL07", asset: "DIMM_A1_AssetTag", part: "M321R8GA0BB0-CQKZJ ",
}

func TestParseMemoryDevice(t *testing.T) {
	d := parseMemoryDevice(rdimm.raw())
	if d == nil || d.Slot != "DIMM_A1" || d.SizeBytes != 64<<30 || d.Type != "DDR5" || d.SpeedMts != 4800 || !d.Ecc ||
		d.Manufacturer != "Samsung" || d.Serial != "S3R1AL07" || d.PartNumber != "M321R8GA0BB0-CQKZJ" {
		t.Fatalf("rdimm = %+v", d)
	}
	for name, tc := range map[string]struct {
		dev  memDev
		want *Dimm
	}{
		"kilobyte units, rated speed, no ECC": {
			memDev{size: 0x8000 | 512, totalWidth: 64, dataWidth: 64, speed: 3200, memType: 0x1a, locator: "ChannelA-DIMM0", maker: "Not Specified", serial: "00000000"},
			&Dimm{Slot: "ChannelA-DIMM0", SizeBytes: 512 << 10, Type: "DDR4", SpeedMts: 3200, Serial: "00000000"},
		},
		"unknown size, extended speed, bank as slot": {
			memDev{size: 0xffff, totalWidth: 0xffff, dataWidth: 0xffff, speed: 0xffff, extSpeed: 70000, memType: 0x99, bank: "NODE 1"},
			&Dimm{Slot: "NODE 1", SpeedMts: 70000},
		},
	} {
		got := parseMemoryDevice(tc.dev.raw())
		if got == nil || *got != *tc.want {
			t.Errorf("%s: %+v, want %+v", name, got, tc.want)
		}
	}
	empty := rdimm
	empty.size = 0
	if parseMemoryDevice(empty.raw()) != nil {
		t.Fatal("an empty slot is a DIMM")
	}
	for _, raw := range [][]byte{nil, {17, 0x5c, 0, 0}, append([]byte{16}, rdimm.raw()[1:]...)} {
		if parseMemoryDevice(raw) != nil {
			t.Fatalf("parsed %x", raw)
		}
	}
}

func TestCollectorDIMMs(t *testing.T) {
	root := t.TempDir()
	write := func(p string, b []byte) {
		t.Helper()
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("/proc/meminfo", []byte("MemTotal: 134217728 kB\n"))
	// EDAC alone (an unprivileged run: the SMBIOS entries are root-only).
	for k, v := range map[string]string{
		"mc0/dimm0/size": "65536", "mc0/dimm0/dimm_label": "CPU_SrcID#0_MC#0_Chan#0_DIMM#0", "mc0/dimm0/dimm_mem_type": "Registered-DDR5",
		"mc0/dimm0/dimm_edac_mode": "S8ECD8ED", "mc0/dimm1/size": "0", "mc0/rank3/size": "32768", "mc0/rank3/dimm_edac_mode": "None",
		"mc0/ce_count": "0", "mc0/dimmfoo/size": "1",
	} {
		write("/sys/devices/system/edac/mc/"+k, []byte(v+"\n"))
	}
	inv, _ := Collector{Root: root}.Collect()
	d := inv.Memory.Dimms
	if len(d) != 2 || d[0].Slot != "CPU_SrcID#0_MC#0_Chan#0_DIMM#0" || d[0].SizeBytes != 64<<30 || d[0].Type != "DDR5" || !d[0].Ecc ||
		d[1].Slot != "mc0/rank3" || d[1].SizeBytes != 32<<30 || d[1].Ecc || d[1].Type != "" {
		t.Fatalf("edac dimms = %+v %+v", d[0], d[len(d)-1])
	}

	// SMBIOS wins where it is readable: empty slots and other structure types are skipped, a slot
	// name repeated per socket is qualified.
	second := rdimm
	second.serial = "S3R1AL08"
	empty := rdimm
	empty.size = 0
	write("/sys/firmware/dmi/entries/17-0/raw", rdimm.raw())
	write("/sys/firmware/dmi/entries/17-1/raw", empty.raw())
	write("/sys/firmware/dmi/entries/17-2/raw", second.raw())
	write("/sys/firmware/dmi/entries/16-0/raw", []byte{16, 4, 0, 0, 0, 0})
	inv, _ = Collector{Root: root}.Collect()
	d = inv.Memory.Dimms
	if len(d) != 2 || d[0].Slot != "DIMM_A1#1" || d[0].Serial != "S3R1AL07" || d[1].Slot != "DIMM_A1#2" || d[1].Serial != "S3R1AL08" {
		t.Fatalf("smbios dimms = %+v", d)
	}
}

func TestDIMMFindings(t *testing.T) {
	find := func(inv *NodeInventory, privileged bool) *Finding {
		for _, f := range HostFindings(inv, privileged) {
			if f.Check == "dimms" {
				return &f
			}
		}
		return nil
	}
	sys := &SystemSection{Vendor: "Supermicro"}
	mixed := &NodeInventory{System: sys, Memory: &MemorySection{TotalBytes: 1, Dimms: []*Dimm{
		{Slot: "A1", SizeBytes: 64 << 30, Type: "DDR5", Ecc: true}, {Slot: "B1", SizeBytes: 64 << 30, Type: "DDR5"},
	}}}
	if f := find(mixed, true); f == nil || f.Status != "warn" || f.Detail != "2 DIMMs, 128.0 GiB DDR5; only 1 of them ECC: the non-ECC modules leave memory errors uncorrected" {
		t.Fatalf("mixed = %+v", f)
	}
	mixed.Memory.Dimms[1].Ecc = true
	if f := find(mixed, true); f == nil || f.Status != "ok" || f.Detail != "2 DIMMs, 128.0 GiB DDR5, ECC" {
		t.Fatalf("ecc = %+v", f)
	}
	none := &NodeInventory{System: sys, Memory: &MemorySection{TotalBytes: 1}}
	if f := find(none, true); f == nil || f.Status != "warn" {
		t.Fatalf("root, no SMBIOS memory devices = %+v", f)
	}
	if f := find(none, false); f != nil {
		t.Fatalf("unprivileged: SMBIOS is root-only, nothing to say = %+v", f)
	}
	if f := find(&NodeInventory{Memory: &MemorySection{TotalBytes: 1}}, true); f != nil {
		t.Fatalf("no SMBIOS at all (a VM) = %+v", f)
	}
}

func TestRedactMemoryDevice(t *testing.T) {
	out := redactMemoryDevice(rdimm.raw())
	if bytes.Contains(out, []byte("S3R1AL07")) || bytes.Contains(out, []byte("AssetTag")) {
		t.Fatalf("serial or asset tag kept: %q", out)
	}
	d := parseMemoryDevice(out)
	if d == nil || d.Serial == "" || d.Serial == "S3R1AL07" || d.PartNumber != "M321R8GA0BB0-CQKZJ" || d.Slot != "DIMM_A1" || d.SizeBytes != 64<<30 {
		t.Fatalf("redacted = %+v", d)
	}
	if again := parseMemoryDevice(redactMemoryDevice(rdimm.raw())); again.Serial != d.Serial {
		t.Fatal("redaction is not deterministic")
	}
	plain := rdimm
	plain.serial, plain.asset = "", ""
	if !bytes.Equal(redactMemoryDevice(plain.raw()), plain.raw()) {
		t.Fatal("a structure without identifiers changed")
	}
}
