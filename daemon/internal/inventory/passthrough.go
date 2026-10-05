package inventory

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// GPUs passed through to VMs. A GPU a VM holds is bound to vfio-pci: the NVIDIA driver lets go of it,
// so neither /proc/driver/nvidia nor nvidia-smi lists it, and an inventory read from them would drop
// the very GPU the VM is using (and the control plane would retire its device mid-allocation). The
// PCI function is still there: the collector finds NVIDIA display/3D functions on vfio-pci and
// reports the GPU last seen at that address, which GPUMemory keeps while the NVIDIA driver has it.

const nvidiaVendor = "0x10de"

// GPUMemory remembers each GPU by its PCI address while the NVIDIA driver owns it, in a small JSON
// file under bcd's data directory.
type GPUMemory struct {
	Path string

	mu   sync.Mutex
	seen map[string]seenGPU
}

// seenGPU is what stays true of a GPU while a VM holds it: its identity and fixed properties (not
// MIG, NVLink or topology state, which the VM's driver owns meanwhile).
type seenGPU struct {
	Uuid            string `json:"uuid"`
	Name            string `json:"name,omitempty"`
	Architecture    string `json:"architecture,omitempty"`
	VramBytes       uint64 `json:"vramBytes,omitempty"`
	Serial          string `json:"serial,omitempty"`
	VbiosVersion    string `json:"vbiosVersion,omitempty"`
	BoardPartNumber string `json:"boardPartNumber,omitempty"`
	CCMajor         uint32 `json:"ccMajor,omitempty"`
	CCMinor         uint32 `json:"ccMinor,omitempty"`
}

func (s seenGPU) gpu() *Gpu {
	return &Gpu{Uuid: s.Uuid, Name: s.Name, Architecture: s.Architecture, VramBytes: s.VramBytes, Serial: s.Serial,
		VbiosVersion: s.VbiosVersion, BoardPartNumber: s.BoardPartNumber,
		CudaComputeCapabilityMajor: s.CCMajor, CudaComputeCapabilityMinor: s.CCMinor}
}

// Remember records the GPUs of a collection (by PCI bus id), keeping earlier ones the collection did
// not list (they may be passed through right now). Call it on the enriched inventory (after NVML),
// which knows the VRAM, serial and compute capability.
func (m *GPUMemory) Remember(section *GpusSection) error {
	if m == nil || m.Path == "" || section == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.load()
	changed := false
	for _, g := range section.Gpus {
		if g.Uuid == "" || g.PciBusId == "" {
			continue
		}
		key := normalizeBus(g.PciBusId)
		want := seenGPU{Uuid: g.Uuid, Name: g.Name, Architecture: g.Architecture, VramBytes: g.VramBytes, Serial: g.Serial,
			VbiosVersion: g.VbiosVersion, BoardPartNumber: g.BoardPartNumber,
			CCMajor: g.CudaComputeCapabilityMajor, CCMinor: g.CudaComputeCapabilityMinor}
		if have, ok := m.seen[key]; !ok || have != want {
			m.seen[key] = want
			changed = true
		}
	}
	if !changed {
		return nil
	}
	b, err := json.MarshalIndent(m.seen, "", "  ")
	if err != nil {
		return err
	}
	tmp := m.Path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, m.Path)
}

// Lookup is the GPU last seen at a PCI address (nil: never seen). It is Collector.PassedThrough.
func (m *GPUMemory) Lookup(pciAddress string) *Gpu {
	if m == nil || m.Path == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.load()
	g, ok := m.seen[normalizeBus(pciAddress)]
	if !ok {
		return nil
	}
	return g.gpu()
}

func (m *GPUMemory) load() {
	if m.seen != nil {
		return
	}
	m.seen = map[string]seenGPU{}
	b, err := os.ReadFile(m.Path)
	if err != nil {
		return
	}
	_ = json.Unmarshal(b, &m.seen)
}

// normalizeBus keys an address as sysfs writes it: "0000:18:00.0" (NVML's "00000000:18:00.0" too).
func normalizeBus(bus string) string {
	bus = strings.ToLower(strings.TrimSpace(bus))
	domain, rest, ok := strings.Cut(bus, ":")
	if !ok {
		return bus
	}
	if n, err := strconv.ParseUint(domain, 16, 32); err == nil {
		domain = strconv.FormatUint(n, 16)
		for len(domain) < 4 {
			domain = "0" + domain
		}
	}
	return domain + ":" + rest
}

// passedThroughGPUs finds NVIDIA display or 3D controllers bound to vfio-pci and returns the GPUs
// last seen at their addresses (functions never seen with the NVIDIA driver are left out: without
// it there is no UUID to name them by).
func (c Collector) passedThroughGPUs(have map[string]bool) []*Gpu {
	if c.PassedThrough == nil {
		return nil
	}
	var out []*Gpu
	for _, addr := range c.list("/sys/bus/pci/devices") {
		base := "/sys/bus/pci/devices/" + addr
		if c.read(base+"/vendor") != nvidiaVendor {
			continue
		}
		// 0x0300xx VGA, 0x0302xx 3D controller (every data-center GPU).
		class := c.read(base + "/class")
		if !strings.HasPrefix(class, "0x0300") && !strings.HasPrefix(class, "0x0302") {
			continue
		}
		if c.link(base+"/driver") != "vfio-pci" || have[normalizeBus(addr)] {
			continue
		}
		g := c.PassedThrough(addr)
		if g == nil {
			continue
		}
		gpu := *g
		gpu.PciBusId = pciBusID(addr)
		if numa, err := strconv.Atoi(c.read(base + "/numa_node")); err == nil && numa >= 0 {
			v := uint32(numa)
			gpu.NumaNode = &v
		}
		out = append(out, &gpu)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PciBusId < out[j].PciBusId })
	return out
}

// GPUMemoryPath is the memory file under a data directory.
func GPUMemoryPath(dataDir string) string { return filepath.Join(dataDir, "gpus-seen.json") }
