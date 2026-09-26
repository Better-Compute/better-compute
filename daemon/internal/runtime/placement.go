package runtime

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// Hugepage sizes a guest's memory may be backed with (PLAN.md §3.8).
const (
	Hugepage2Mi uint64 = 2 << 20
	Hugepage1Gi uint64 = 1 << 30
)

// Placement is an instance's InstancePlacement, checked (PLAN.md §3.8): where its vCPUs run, which
// NUMA nodes its memory comes from, and how that memory is backed. The control plane chooses it; the
// runtime applies it exactly or refuses the spec.
type Placement struct {
	// CPUs are the host CPUs of the vCPUs, sorted. With exactly vcpu of them, vCPU i is pinned to
	// CPUs[i]; otherwise the vCPUs float within the set.
	CPUs []int
	// CPUList is CPUs in cpulist form ("8-15,72-79"), as the spec gave it.
	CPUList string
	// MemNodes are the NUMA nodes guest memory is bound to, sorted; Mems is their cpulist form.
	MemNodes []int
	Mems     string
	// HugepageSize backs guest memory with hugepages of this size (Hugepage2Mi or Hugepage1Gi); 0: normal pages.
	HugepageSize uint64
	// Balloon gives the guest a virtio balloon; never with hugepages (the host could not reclaim them).
	Balloon bool
}

// Pinned reports whether each vCPU has a CPU of its own (vCPU i on CPUs[i]).
func (p *Placement) Pinned(vcpu uint32) bool {
	return p != nil && len(p.CPUs) > 0 && uint32(len(p.CPUs)) == vcpu
}

// PlacementOf checks spec's placement: nil when it has none.
func PlacementOf(spec *agentv1.InstanceSpec) (*Placement, error) {
	raw := spec.GetPlacement()
	if raw == nil || (raw.GetCpus() == "" && raw.GetMems() == "" && raw.GetHugepageSizeBytes() == 0 && !raw.GetBalloon()) {
		return nil, nil
	}
	p := &Placement{CPUList: raw.GetCpus(), Mems: raw.GetMems(), HugepageSize: raw.GetHugepageSizeBytes()}
	var err error
	if p.CPUList != "" {
		if p.CPUs, err = ParseCPUList(p.CPUList); err != nil {
			return nil, fmt.Errorf("placement.cpus: %w", err)
		}
		if uint32(len(p.CPUs)) < spec.GetVcpu() {
			// Fewer host CPUs than vCPUs would oversubscribe the set the control plane booked.
			return nil, fmt.Errorf("placement.cpus %q has %d CPUs for %d vCPUs", p.CPUList, len(p.CPUs), spec.GetVcpu())
		}
	}
	if p.Mems != "" {
		if p.MemNodes, err = ParseCPUList(p.Mems); err != nil {
			return nil, fmt.Errorf("placement.mems: %w", err)
		}
	}
	switch p.HugepageSize {
	case 0, Hugepage2Mi, Hugepage1Gi:
	default:
		return nil, fmt.Errorf("placement.hugepage_size_bytes %d is neither 2 MiB nor 1 GiB", p.HugepageSize)
	}
	if p.HugepageSize != 0 && spec.GetMemoryBytes()%p.HugepageSize != 0 {
		return nil, fmt.Errorf("memory %d bytes is not a whole number of %d-byte hugepages", spec.GetMemoryBytes(), p.HugepageSize)
	}
	// A balloon would let the host reclaim guest memory; hugepages cannot be reclaimed that way.
	p.Balloon = raw.GetBalloon() && p.HugepageSize == 0
	return p, nil
}

// ParseCPUList parses the kernel's cpulist form ("0-3,8,10-11"), as cpuset.cpus and sysfs use it,
// into sorted, distinct numbers.
func ParseCPUList(list string) ([]int, error) {
	seen := map[int]bool{}
	for _, part := range strings.Split(strings.TrimSpace(list), ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil, fmt.Errorf("empty element in %q", list)
		}
		lo, hi, isRange := strings.Cut(part, "-")
		first, err := strconv.Atoi(lo)
		if err != nil || first < 0 {
			return nil, fmt.Errorf("bad element %q in %q", part, list)
		}
		last := first
		if isRange {
			if last, err = strconv.Atoi(hi); err != nil || last < first {
				return nil, fmt.Errorf("bad range %q in %q", part, list)
			}
		}
		if last-first > 4096 {
			return nil, fmt.Errorf("range %q in %q is too large", part, list)
		}
		for n := first; n <= last; n++ {
			seen[n] = true
		}
	}
	out := make([]int, 0, len(seen))
	for n := range seen {
		out = append(out, n)
	}
	sort.Ints(out)
	return out, nil
}

// FormatCPUList writes sorted numbers in cpulist form ("0-3,8").
func FormatCPUList(numbers []int) string {
	var parts []string
	for i := 0; i < len(numbers); {
		j := i
		for j+1 < len(numbers) && numbers[j+1] == numbers[j]+1 {
			j++
		}
		if j == i {
			parts = append(parts, strconv.Itoa(numbers[i]))
		} else {
			parts = append(parts, fmt.Sprintf("%d-%d", numbers[i], numbers[j]))
		}
		i = j + 1
	}
	return strings.Join(parts, ",")
}
