package fakehw

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// ApplyRoot overlays onto inv what bcd's host units changed on a fakehw machine, whose files live
// under root (fakehw-root): the hugepages they reserved. It reads the machine-wide pools
// (sys/kernel/mm/hugepages/hugepages-<kB>kB/nr_hugepages) and each NUMA node's
// (sys/devices/system/node/node<N>/hugepages/...). A node without its own file gets an even share
// of the machine-wide pool, as the kernel spreads it; node 0 takes the remainder.
func ApplyRoot(inv *inventory.NodeInventory, root string) *inventory.NodeInventory {
	if inv == nil || root == "" || inv.Memory == nil {
		return inv
	}
	read := func(rel string) (uint64, bool) {
		b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return 0, false
		}
		n, err := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
		return n, err == nil
	}
	file := func(size uint64) string { return "hugepages-" + strconv.FormatUint(size/1024, 10) + "kB/nr_hugepages" }
	var nodes []*inventory.NumaNode
	if inv.Cpu != nil {
		nodes = inv.Cpu.NumaNodes
	}
	for _, pool := range inv.Memory.Hugepages {
		total, ok := read("sys/kernel/mm/hugepages/" + file(pool.PageSizeBytes))
		if !ok {
			continue
		}
		pool.Total = total
		if len(nodes) == 0 {
			continue
		}
		share, rest := total/uint64(len(nodes)), total%uint64(len(nodes))
		for i, node := range nodes {
			n, ok := read("sys/devices/system/node/node" + strconv.FormatUint(uint64(node.Id), 10) + "/hugepages/" + file(pool.PageSizeBytes))
			if !ok {
				n = share
				if i == 0 {
					n += rest
				}
			}
			setNodePool(node, pool.PageSizeBytes, n)
		}
	}
	return inv
}

// setNodePool sets a NUMA node's pool of size to total, keeping its pools sorted by page size.
func setNodePool(node *inventory.NumaNode, size, total uint64) {
	for _, p := range node.Hugepages {
		if p.PageSizeBytes == size {
			p.Total = total
			return
		}
	}
	node.Hugepages = append(node.Hugepages, &inventory.HugepagePool{PageSizeBytes: size, Total: total})
	for i := len(node.Hugepages) - 1; i > 0 && node.Hugepages[i].PageSizeBytes < node.Hugepages[i-1].PageSizeBytes; i-- {
		node.Hugepages[i], node.Hugepages[i-1] = node.Hugepages[i-1], node.Hugepages[i]
	}
}
