package fakehw

import (
	"os"
	"path/filepath"
	"testing"
)

// The hugepages bcd's host unit reserves on a fakehw machine show in its inventory.
func TestApplyRootHugepages(t *testing.T) {
	root := t.TempDir()
	write := func(rel, v string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(v+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	inv := ApplyRoot(Inventory(1), root)
	if inv.Memory.Hugepages[1].Total != 0 || len(inv.Cpu.NumaNodes[0].Hugepages) != 0 {
		t.Fatal("pools without files changed")
	}
	write("sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages", "9")
	write("sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages", "64")
	write("sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages", "40")
	inv = ApplyRoot(Inventory(1), root)
	if inv.Memory.Hugepages[0].Total != 64 || inv.Memory.Hugepages[1].Total != 9 {
		t.Fatalf("machine pools = %v", inv.Memory.Hugepages)
	}
	n0, n1 := inv.Cpu.NumaNodes[0].Hugepages, inv.Cpu.NumaNodes[1].Hugepages
	// 1Gi: 9 spread as 5 + 4. 2Mi: node 1 has its own file (40); node 0 an even share (32).
	if len(n0) != 2 || n0[0].PageSizeBytes != 2<<20 || n0[0].Total != 32 || n0[1].Total != 5 || n1[0].Total != 40 || n1[1].Total != 4 {
		t.Fatalf("per-node pools = %v / %v", n0, n1)
	}
}
