package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// Host-side admission (PLAN.md §3.8): bcd refuses to start an instance whose memory the host cannot
// give it, whatever the control plane decided, so a drifted control plane never overcommits a node.
// It counts what is committed, not what is in use: a VM that has not touched its memory yet will.
//   - normal pages: MemTotal less the hugepage pool and a headroom for the host itself, against the
//     memory (plus VMM overhead) of every running or paused domain on normal pages;
//   - hugepages: free pages of that size on the placement's NUMA nodes (the whole host without one);
//     a hugepage-backed domain still needs its VMM overhead in normal memory.
// A start that does not fit waits (ResourcesExhausted) and is tried again at the next pass.

// hostMemoryHeadroom is what host admission leaves the host itself (bcd, the kernel, sshd, caches).
const hostMemoryHeadroom = 1 << 30

// ResourcesExhausted prefixes an instance's status message when host admission refused its start.
const ResourcesExhausted = "ResourcesExhausted"

// hostMemoryRoot prefixes /proc and /sys (tests point it at a fake tree).
var hostMemoryRoot = "/"

// vmmOverhead is the normal memory a VMM needs beside its guest's (page tables, device emulation),
// as the cloud-hypervisor unit's MemoryMax allows it.
func vmmOverhead(memory uint64) uint64 { return memory/32 + 256<<20 }

// hostMemory is one reading of the host's memory, plus what this pass has already admitted.
type hostMemory struct {
	// normalCapacity: MemTotal less the hugepage pool and the headroom.
	normalCapacity uint64
	// committed: normal memory of running and paused domains, and of starts admitted this pass.
	committed uint64
	// freeHugepages: free pages by page size and NUMA node; node -1 is the whole host.
	freeHugepages map[uint64]map[int]uint64
}

func readUint(path string) (uint64, bool) {
	raw, err := os.ReadFile(filepath.Join(hostMemoryRoot, path))
	if err != nil {
		return 0, false
	}
	n, err := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 64)
	return n, err == nil
}

// probeHostMemory reads /proc/meminfo and the hugepage pools, and counts the domains' commitments.
func probeHostMemory(domains map[string]runtime.Domain) (*hostMemory, error) {
	raw, err := os.ReadFile(filepath.Join(hostMemoryRoot, "proc/meminfo"))
	if err != nil {
		return nil, err
	}
	kb := map[string]uint64{}
	for _, line := range strings.Split(string(raw), "\n") {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		if n, err := strconv.ParseUint(fields[0], 10, 64); err == nil {
			kb[name] = n
		}
	}
	total, ok := kb["MemTotal"]
	if !ok {
		return nil, fmt.Errorf("no MemTotal in /proc/meminfo")
	}
	m := &hostMemory{freeHugepages: map[uint64]map[int]uint64{}}
	// Hugetlb (kB) is the whole hugepage pool, every size: it is not normal memory.
	pool := kb["Hugetlb"] * 1024
	if limit := total*1024 - pool; limit > hostMemoryHeadroom {
		m.normalCapacity = limit - hostMemoryHeadroom
	}
	for _, size := range []uint64{runtime.Hugepage2Mi, runtime.Hugepage1Gi} {
		dir := fmt.Sprintf("hugepages-%dkB", size/1024)
		byNode := map[int]uint64{}
		// Host-wide: free less reserved (mapped, not yet faulted in).
		free, _ := readUint("sys/kernel/mm/hugepages/" + dir + "/free_hugepages")
		resv, _ := readUint("sys/kernel/mm/hugepages/" + dir + "/resv_hugepages")
		if free > resv {
			byNode[-1] = free - resv
		} else {
			byNode[-1] = 0
		}
		nodes, _ := os.ReadDir(filepath.Join(hostMemoryRoot, "sys/devices/system/node"))
		for _, entry := range nodes {
			id, err := strconv.Atoi(strings.TrimPrefix(entry.Name(), "node"))
			if err != nil || !strings.HasPrefix(entry.Name(), "node") {
				continue
			}
			if n, ok := readUint("sys/devices/system/node/" + entry.Name() + "/hugepages/" + dir + "/free_hugepages"); ok {
				byNode[id] = n
			}
		}
		m.freeHugepages[size] = byNode
	}
	for _, d := range domains {
		if !d.Managed || (d.State != runtime.StateRunning && d.State != runtime.StatePaused) {
			continue
		}
		m.committed += vmmOverhead(d.MemoryBytes)
		if d.HugepageSize == 0 {
			m.committed += d.MemoryBytes
		}
	}
	return m, nil
}

// admit takes a start's memory out of the host's, or says why the host cannot give it.
func (m *hostMemory) admit(spec *agentv1.InstanceSpec) error {
	placement, err := runtime.PlacementOf(spec)
	if err != nil {
		return err
	}
	memory := spec.GetMemoryBytes()
	normal := vmmOverhead(memory)
	if placement == nil || placement.HugepageSize == 0 {
		normal += memory
	}
	if m.committed+normal > m.normalCapacity {
		return fmt.Errorf("%s: %d MiB of memory needed, %d MiB left on this host", ResourcesExhausted,
			normal>>20, (m.normalCapacity-min(m.committed, m.normalCapacity))>>20)
	}
	if placement != nil && placement.HugepageSize != 0 {
		size := placement.HugepageSize
		pages := memory / size
		nodes := placement.MemNodes
		if len(nodes) == 0 {
			nodes = []int{-1}
		}
		free := uint64(0)
		for _, node := range nodes {
			free += m.freeHugepages[size][node]
		}
		if free < pages {
			return fmt.Errorf("%s: %d hugepages of %d KiB needed on NUMA node(s) %s, %d free", ResourcesExhausted,
				pages, size/1024, placement.Mems, free)
		}
		// Taken from the nodes in order, as the kernel would fill a strict binding.
		for _, node := range nodes {
			take := min(pages, m.freeHugepages[size][node])
			m.freeHugepages[size][node] -= take
			pages -= take
			if node != -1 {
				m.freeHugepages[size][-1] -= min(take, m.freeHugepages[size][-1])
			}
		}
	}
	m.committed += normal
	return nil
}
