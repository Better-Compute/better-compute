package fakehw

import (
	"bytes"
	"reflect"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

func hashes(t *testing.T, inv *inventory.NodeInventory) map[string][]byte {
	t.Helper()
	h, err := inventory.SectionHashes(inv)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestInventoryIsDeterministic(t *testing.T) {
	a, b := Inventory(7), Inventory(7)
	if !reflect.DeepEqual(a, b) {
		t.Fatal("the same seed produced different inventories")
	}
	h := hashes(t, a)
	if len(h) != len(inventory.SectionNames()) {
		t.Fatalf("hashed %d sections, want all %d", len(h), len(inventory.SectionNames()))
	}
	if !reflect.DeepEqual(h, hashes(t, b)) {
		t.Fatal("the same seed produced different hashes")
	}
}

func TestInventoryIsCanonical(t *testing.T) {
	inv := Inventory(7)
	inventory.Canonicalize(inv)
	if !reflect.DeepEqual(inv, Inventory(7)) {
		t.Fatal("Inventory must return its node already in canonical order")
	}
	if nics := inv.Nics.Nics; nics[0].Mac > nics[1].Mac {
		t.Fatalf("NICs are not sorted by MAC: %s, %s", nics[0].Mac, nics[1].Mac)
	}
}

func TestSeedsDifferOnlyInSeededSections(t *testing.T) {
	one, two := hashes(t, Inventory(1)), hashes(t, Inventory(2))
	for _, section := range []string{"system", "disks", "nics", "gpus", "bmc"} {
		if bytes.Equal(one[section], two[section]) {
			t.Errorf("section %s is the same for seeds 1 and 2", section)
		}
	}
	for _, section := range []string{"cpu", "memory", "os"} {
		if !bytes.Equal(one[section], two[section]) {
			t.Errorf("section %s differs between seeds, but nothing in it is seeded", section)
		}
	}
}

func TestHGXShape(t *testing.T) {
	inv := Inventory(0)
	gpus := inv.Gpus.Gpus
	if len(gpus) != GPUCount {
		t.Fatalf("%d GPUs, want %d", len(gpus), GPUCount)
	}
	uuids := map[string]bool{}
	for _, g := range gpus {
		uuids[g.Uuid] = true
	}
	if len(uuids) != GPUCount {
		t.Fatal("GPU UUIDs are not unique")
	}
	perNUMA := map[uint32]int{}
	for _, g := range gpus {
		if g.Name != GPUName || g.VramBytes != 81559<<20 || g.Mig == nil || !g.Mig.Capable || g.NumaNode == nil {
			t.Fatalf("GPU %d = %+v", g.Index, g)
		}
		perNUMA[*g.NumaNode]++
		// All-to-all NVLink through NVSwitch: every other GPU is an NV peer.
		if len(g.Topology) != GPUCount-1 {
			t.Fatalf("GPU %d has %d peers, want %d", g.Index, len(g.Topology), GPUCount-1)
		}
		for _, p := range g.Topology {
			if p.PeerUuid == g.Uuid || !uuids[p.PeerUuid] || p.Link != inventory.GpuLinkType_GPU_LINK_TYPE_NV || p.Nvlinks != NVLinksPerGPU {
				t.Fatalf("GPU %d: peer %+v", g.Index, p)
			}
		}
		if len(g.Nvlinks) != NVLinksPerGPU {
			t.Fatalf("GPU %d has %d NVLinks, want %d", g.Index, len(g.Nvlinks), NVLinksPerGPU)
		}
		for _, l := range g.Nvlinks {
			if l.State != inventory.LinkState_LINK_STATE_UP {
				t.Fatalf("GPU %d link %d is %d", g.Index, l.Link, l.State)
			}
		}
	}
	if !reflect.DeepEqual(perNUMA, map[uint32]int{0: 4, 1: 4}) {
		t.Fatalf("GPUs per NUMA node = %v, want 4 and 4", perNUMA)
	}

	cpu := inv.Cpu
	if cpu.Sockets != 2 || len(cpu.NumaNodes) != NUMANodes {
		t.Fatalf("cpu = %+v", cpu)
	}
	var dimmBytesTotal, numaBytesTotal uint64
	for _, d := range inv.Memory.Dimms {
		dimmBytesTotal += d.SizeBytes
	}
	for _, n := range cpu.NumaNodes {
		numaBytesTotal += n.MemoryBytes
	}
	if dimmBytesTotal != inv.Memory.TotalBytes || numaBytesTotal != inv.Memory.TotalBytes {
		t.Fatalf("memory does not add up: DIMMs %d, NUMA %d, total %d", dimmBytesTotal, numaBytesTotal, inv.Memory.TotalBytes)
	}

	disks := inv.Disks.Disks
	if len(disks) != OSDisks+DataDisks {
		t.Fatalf("%d disks, want %d", len(disks), OSDisks+DataDisks)
	}
	for _, d := range disks {
		if d.Transport != inventory.DiskTransport_DISK_TRANSPORT_NVME || d.Wwn == "" || d.SizeBytes == 0 {
			t.Fatalf("disk %+v", d)
		}
	}
	nics := inv.Nics.Nics
	if len(nics) != 2 || nics[0].Mac == nics[1].Mac {
		t.Fatalf("nics = %+v", nics)
	}
}

func TestCountersAndStateChangeHashes(t *testing.T) {
	// inventory.proto hashes ECC and row-remap counters and link state too; only readings such as
	// temperatures stay out of inventory (they are telemetry, P8).
	base := hashes(t, Inventory(3))
	changes := map[string]func(*inventory.NodeInventory){
		"gpus":   func(inv *inventory.NodeInventory) { inv.Gpus.Gpus[2].Ecc.VolatileCounts.Correctable = 17 },
		"nics":   func(inv *inventory.NodeInventory) { inv.Nics.Nics[1].Link = inventory.LinkState_LINK_STATE_DOWN },
		"memory": func(inv *inventory.NodeInventory) { inv.Memory.Edac.Correctable = 9 },
		"disks":  func(inv *inventory.NodeInventory) { inv.Disks.Disks[0].Smart.Healthy = false },
	}
	for section, change := range changes {
		inv := Inventory(3)
		change(inv)
		got := hashes(t, inv)
		for name, sum := range base {
			if moved := !bytes.Equal(got[name], sum); moved != (name == section) {
				t.Errorf("changing %s: section %s changed = %v", section, name, moved)
			}
		}
	}
}
