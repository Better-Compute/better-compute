package inventory

import (
	"bytes"
	"encoding/hex"
	"reflect"
	"testing"
)

// The golden hex strings below are protobuf-es toBinary output for the same messages (built from
// the inventory.proto descriptor, in canonical order), so they pin encode.go to the reference
// encoding. TODO(v0.1): proto.Marshal on the daemon/gen types must reproduce them unchanged.

func TestGoldenCpuSection(t *testing.T) {
	inv := &NodeInventory{Cpu: &CpuSection{
		Vendor:       "GenuineIntel",
		Model:        "x",
		Architecture: "x86_64",
		Sockets:      2,
		Threads:      300,
		Flags:        []string{"b", "", "a"},
		NumaNodes: []*NumaNode{
			{Id: 1, Cpus: "8-15", MemoryBytes: 1 << 33},
			{Id: 0, Cpus: "0-7", MemoryBytes: 1024},
		},
	}}
	wantSection(t, inv, "cpu",
		"0a0c47656e75696e65496e74656c1201781a067838365f3634200230ac023a003a01613a016242081203302d37188008420e08011204382d3135188080808020",
		"2b7a390c6c08b84abe73393518862ff0600ffedeebc5138f8b5ff7fb01e7247a")
}

func TestGoldenSystemSection(t *testing.T) {
	secureBoot := false
	inv := &NodeInventory{System: &SystemSection{
		Vendor:      "Fake",
		ProductUuid: "abc",
		BootMode:    BootMode_BOOT_MODE_UEFI,
		SecureBoot:  &secureBoot,
		Tpm:         &Tpm{Version: "2.0"},
	}}
	wantSection(t, inv, "system",
		"0a0446616b652203616263580160006a050a03322e30",
		"fe4e9ec951dbb525b4e20c1732f6577336e09335071566b7202268349555699d")
}

func TestGoldenGpusSection(t *testing.T) {
	numaNode := uint32(0)
	pendingEnabled := false
	inv := &NodeInventory{Gpus: &GpusSection{
		DriverVersion: "550.90.07",
		Gpus: []*Gpu{
			{Index: 1, Uuid: "GPU-b"},
			{
				Index:                      0,
				Uuid:                       "GPU-a",
				Name:                       "NVIDIA H100 80GB HBM3",
				VramBytes:                  85520809984,
				NumaNode:                   &numaNode,
				PowerLimitMw:               700_000,
				PersistenceMode:            true,
				CudaComputeCapabilityMajor: 9,
				Mig:                        &GpuMig{Capable: true, Current: MigMode_MIG_MODE_DISABLED},
				Nvlinks: []*NvlinkLink{
					{Link: 1, State: LinkState_LINK_STATE_DOWN},
					{Link: 0, State: LinkState_LINK_STATE_UP, Peer: "nvswitch:0", Version: 4},
				},
				Topology: []*GpuPeerLink{{PeerUuid: "GPU-b", Link: GpuLinkType_GPU_LINK_TYPE_NV, Nvlinks: 18}},
				Ecc:      &GpuEcc{Enabled: true, PendingEnabled: &pendingEnabled, VolatileCounts: &EccCounts{}},
			},
		},
	}}
	wantSection(t, inv, "gpus",
		"0a093535302e39302e3037226712054750552d6122154e5649444941204831303020383047422048424d33308080c0cbbe02500058e0dc2a60017009820104080110018a011010011a0a6e767377697463683a3020048a01040801100292010b0a054750552d6210011812a20106080110001a002209080112054750552d62",
		"afa767f5887836179635738b252fbbde12d39d28ef4bc6b797cf3a8703065eec")
}

func wantSection(t *testing.T, inv *NodeInventory, name, wantHex, wantSha string) {
	t.Helper()
	sections, err := EncodeSections(inv)
	if err != nil {
		t.Fatal(err)
	}
	if len(sections) != 1 || sections[0].Name != name {
		t.Fatalf("sections = %+v; want only %s", sections, name)
	}
	if got := hex.EncodeToString(sections[0].Content); got != wantHex {
		t.Fatalf("%s content =\n%s\nwant\n%s", name, got, wantHex)
	}
	if got := hex.EncodeToString(sections[0].Sha256); got != wantSha {
		t.Fatalf("%s sha256 = %s, want %s", name, got, wantSha)
	}
}

func TestWireEncoding(t *testing.T) {
	zero := uint64(0)
	cases := []struct {
		name  string
		write func(w *protoWriter)
		want  string
	}{
		{"one-byte varint", func(w *protoWriter) { w.u64(1, 127) }, "087f"},
		{"two-byte varint", func(w *protoWriter) { w.u64(1, 128) }, "088001"},
		{"default omitted", func(w *protoWriter) { w.u64(1, 0); w.str(2, ""); w.boolean(3, false); w.enum(4, 0) }, ""},
		{"negative enum", func(w *protoWriter) { w.enum(2, -1) }, "10ffffffffffffffffff01"},
		{"two-byte tag", func(w *protoWriter) { w.u32(16, 1) }, "800101"},
		{"optional zero is present", func(w *protoWriter) { w.optU64(3, &zero) }, "1800"},
		{"optional nil is absent", func(w *protoWriter) { w.optU32(3, nil); w.optBool(4, nil) }, ""},
		{"repeated empty string", func(w *protoWriter) { w.strs(4, []string{""}) }, "2200"},
		{"empty message", func(w *protoWriter) { w.message(5, func(*protoWriter) {}) }, "2a00"},
	}
	for _, tc := range cases {
		var w protoWriter
		tc.write(&w)
		if got := hex.EncodeToString(w.buf); got != tc.want {
			t.Errorf("%s: %s, want %s", tc.name, got, tc.want)
		}
	}
}

func TestCanonicalize(t *testing.T) {
	inv := &NodeInventory{
		Cpu:    &CpuSection{Flags: []string{"vmx", "avx2"}, NumaNodes: []*NumaNode{{Id: 1}, {Id: 0}}},
		Memory: &MemorySection{Hugepages: []*HugepagePool{{PageSizeBytes: 1 << 30}, {PageSizeBytes: 2 << 20}}, Dimms: []*Dimm{{Slot: "B1"}, {Slot: "A1"}}},
		Disks:  &DisksSection{Disks: []*Disk{{Name: "nvme1n1"}, {Name: "nvme0n1"}}},
		Nics:   &NicsSection{Nics: []*Nic{{Mac: "02:00:00:00:00:02"}, {Mac: "02:00:00:00:00:01"}}},
		Gpus: &GpusSection{Gpus: []*Gpu{
			{
				Index:    1,
				Mig:      &GpuMig{Profiles: []*MigProfile{{Id: 9}, {Id: 0}}, Instances: []*MigInstance{{GiId: 1, CiId: 0}, {GiId: 0, CiId: 2}, {GiId: 0, CiId: 1}}},
				Nvlinks:  []*NvlinkLink{{Link: 2}, {Link: 1}},
				Topology: []*GpuPeerLink{{PeerUuid: "GPU-c"}, {PeerUuid: "GPU-a"}},
			},
			{Index: 0},
			nil,
		}},
		Os: &OsSection{Runtimes: []string{"libvirt", "containerd"}},
	}
	Canonicalize(inv)
	check := func(what string, got, want any) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s = %v, want %v", what, got, want)
		}
	}
	check("flags", inv.Cpu.Flags, []string{"avx2", "vmx"})
	check("numa", []uint32{inv.Cpu.NumaNodes[0].Id, inv.Cpu.NumaNodes[1].Id}, []uint32{0, 1})
	check("hugepages", inv.Memory.Hugepages[0].PageSizeBytes, uint64(2<<20))
	check("dimms", inv.Memory.Dimms[0].Slot, "A1")
	check("disks", inv.Disks.Disks[0].Name, "nvme0n1")
	check("nics", inv.Nics.Nics[0].Mac, "02:00:00:00:00:01")
	check("nil gpu first", inv.Gpus.Gpus[0] == nil, true)
	check("gpus", []uint32{inv.Gpus.Gpus[1].Index, inv.Gpus.Gpus[2].Index}, []uint32{0, 1})
	gpu := inv.Gpus.Gpus[2]
	check("mig profiles", []uint32{gpu.Mig.Profiles[0].Id, gpu.Mig.Profiles[1].Id}, []uint32{0, 9})
	var instances [][2]uint32
	for _, i := range gpu.Mig.Instances {
		instances = append(instances, [2]uint32{i.GiId, i.CiId})
	}
	check("mig instances", instances, [][2]uint32{{0, 1}, {0, 2}, {1, 0}})
	check("nvlinks", []uint32{gpu.Nvlinks[0].Link, gpu.Nvlinks[1].Link}, []uint32{1, 2})
	check("topology", gpu.Topology[0].PeerUuid, "GPU-a")
	check("runtimes", inv.Os.Runtimes, []string{"containerd", "libvirt"})

	// A nil element encodes as an empty message instead of panicking.
	if _, err := EncodeSections(inv); err != nil {
		t.Fatal(err)
	}
}

func sample() *NodeInventory {
	return &NodeInventory{
		SchemaVersion: 1,
		Cpu:           &CpuSection{Model: "x", Flags: []string{"b", "a"}},
		Disks:         &DisksSection{Disks: []*Disk{{Name: "nvme0n1", SizeBytes: 1 << 40}, {Name: "nvme1n1", SizeBytes: 1 << 40}}},
		Gpus:          &GpusSection{DriverVersion: "550.90.07", Gpus: []*Gpu{{Index: 0, Uuid: "GPU-a"}, {Index: 1, Uuid: "GPU-b"}}},
		Bmc:           &BmcSection{},
	}
}

func TestSectionHashes(t *testing.T) {
	base, err := SectionHashes(sample())
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, name := range SectionNames() {
		if _, ok := base[name]; ok {
			names = append(names, name)
		}
	}
	if !reflect.DeepEqual(names, []string{"cpu", "disks", "gpus", "bmc"}) {
		t.Fatalf("hashed sections = %v; want the four present ones", names)
	}
	if hex.EncodeToString(base["bmc"]) != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatalf("an empty section must hash its empty encoding, got %x", base["bmc"])
	}

	// Collection order and the collection time never change a hash.
	shuffled := sample()
	shuffled.Cpu.Flags = []string{"a", "b"}
	shuffled.Disks.Disks[0], shuffled.Disks.Disks[1] = shuffled.Disks.Disks[1], shuffled.Disks.Disks[0]
	shuffled.Gpus.Gpus[0], shuffled.Gpus.Gpus[1] = shuffled.Gpus.Gpus[1], shuffled.Gpus.Gpus[0]
	shuffled.CollectedAt = shuffled.CollectedAt.AddDate(0, 0, 1)
	if got, _ := SectionHashes(shuffled); !reflect.DeepEqual(got, base) {
		t.Fatal("reordering or the collection time changed a section hash")
	}

	// A real change moves exactly its own section.
	changed := sample()
	changed.Gpus.DriverVersion = "560.35.03"
	got, _ := SectionHashes(changed)
	for name, sum := range base {
		if moved := !bytes.Equal(got[name], sum); moved != (name == "gpus") {
			t.Errorf("section %s changed = %v", name, moved)
		}
	}

	if _, err := SectionHashes(nil); err == nil {
		t.Fatal("SectionHashes(nil) succeeded")
	}
}
