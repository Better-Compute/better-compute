// Package fakehw is a deterministic fake of an HGX H100 node: 8× H100 SXM5 80GB on NVSwitch
// (NVLink all-to-all), 2 NUMA nodes, NVMe disks and 2 NICs. It feeds the simulator and the tests
// (PLAN.md §6 `sim`, §15), and a real bcd built with -tags fakehw.
//
// The same seed always yields the same inventory, so section hashes are stable across runs;
// different seeds yield different serials, UUIDs and MACs, as N simulated nodes need. Nothing reads
// the host.
//
// TODO(v0.1): if go-nvml ships pkg/nvml/mock with its dgxa100 mock (to verify, PLAN.md §6), wrap
// it here so the NVML code path runs against fake devices too.
package fakehw

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// Board shape.
const (
	GPUCount      = 8
	NVLinksPerGPU = 18
	NVSwitches    = 4
	NUMANodes     = 2
	OSDisks       = 2
	DataDisks     = 8
)

// GPUName is the NVML name every fake GPU reports.
const GPUName = "NVIDIA H100 80GB HBM3"

const (
	vramBytes     = 81559 << 20
	memoryPerNUMA = 1 << 40
	dimmBytes     = 64 << 30
	osDiskBytes   = 1_920_383_410_176
	dataDiskBytes = 3_840_755_982_336
)

// gpuBusIDs are the PCI addresses of the eight SXM5 modules on an HGX H100 baseboard.
var gpuBusIDs = [GPUCount]string{
	"00000000:18:00.0", "00000000:2a:00.0", "00000000:3a:00.0", "00000000:5d:00.0",
	"00000000:9a:00.0", "00000000:ab:00.0", "00000000:ba:00.0", "00000000:db:00.0",
}

// nvswitchBusIDs are the PCI addresses of the baseboard's four NVSwitches.
var nvswitchBusIDs = [NVSwitches]string{"00000000:05:00.0", "00000000:06:00.0", "00000000:07:00.0", "00000000:08:00.0"}

// Inventory returns the fake node for seed, canonicalized. Every call builds a new value.
func Inventory(seed uint64) *inventory.NodeInventory {
	g := generator{seed: seed}
	inv := &inventory.NodeInventory{
		SchemaVersion: 1,
		System:        g.system(),
		Cpu:           cpu(),
		Memory:        memory(),
		Disks:         g.disks(),
		Nics:          g.nics(),
		Gpus:          g.gpus(),
		Bmc:           &inventory.BmcSection{Mac: g.mac("bmc"), Vendor: "fakehw", FirmwareVersion: "1.0.0", Redfish: true, Ipmi: true},
		Os:            osSection(),
	}
	inventory.Canonicalize(inv)
	return inv
}

// generator derives stable per-node identifiers from the seed.
type generator struct {
	seed uint64
}

func (g generator) digest(parts ...string) [sha256.Size]byte {
	return sha256.Sum256([]byte(fmt.Sprintf("bcd-fakehw/%d/%s", g.seed, strings.Join(parts, "/"))))
}

func (g generator) uuid(parts ...string) string {
	d := g.digest(parts...)
	h := hex.EncodeToString(d[:16])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func (g generator) serial(prefix string, parts ...string) string {
	d := g.digest(parts...)
	return prefix + strings.ToUpper(hex.EncodeToString(d[:5]))
}

// mac returns a locally administered unicast address (02:…), so fake MACs never collide with a
// vendor's.
func (g generator) mac(parts ...string) string {
	d := g.digest(parts...)
	return fmt.Sprintf("02:bc:%02x:%02x:%02x:%02x", d[0], d[1], d[2], d[3])
}

func (g generator) system() *inventory.SystemSection {
	secureBoot := false
	return &inventory.SystemSection{
		Vendor:        "Fake Systems",
		Product:       "HGX H100 8-GPU (fakehw)",
		Serial:        g.serial("FK", "system"),
		ProductUuid:   g.uuid("system"),
		BoardVendor:   "Fake Systems",
		BoardProduct:  "HGX H100 baseboard",
		BoardSerial:   g.serial("FB", "board"),
		ChassisSerial: g.serial("FC", "chassis"),
		BiosVendor:    "fakehw",
		BiosVersion:   "1.0.0",
		BootMode:      inventory.BootMode_BOOT_MODE_UEFI,
		SecureBoot:    &secureBoot,
		Tpm:           &inventory.Tpm{Version: "2.0", Manufacturer: "fakehw"},
	}
}

func cpu() *inventory.CpuSection {
	return &inventory.CpuSection{
		Vendor:       "GenuineIntel",
		Model:        "Intel(R) Xeon(R) Platinum 8480+",
		Architecture: "x86_64",
		Sockets:      2,
		Cores:        112,
		Threads:      224,
		Flags:        []string{"amx_bf16", "amx_int8", "amx_tile", "avx2", "avx512_bf16", "avx512_fp16", "avx512f", "vmx"},
		NumaNodes: []*inventory.NumaNode{
			{Id: 0, Cpus: "0-55,112-167", MemoryBytes: memoryPerNUMA},
			{Id: 1, Cpus: "56-111,168-223", MemoryBytes: memoryPerNUMA},
		},
	}
}

func memory() *inventory.MemorySection {
	dimms := make([]*inventory.Dimm, 32)
	for i := range dimms {
		dimms[i] = &inventory.Dimm{Slot: fmt.Sprintf("DIMM%02d", i), SizeBytes: dimmBytes, SpeedMts: 4800, Type: "DDR5", Ecc: true}
	}
	return &inventory.MemorySection{
		TotalBytes: NUMANodes * memoryPerNUMA,
		Hugepages:  []*inventory.HugepagePool{{PageSizeBytes: 2 << 20}, {PageSizeBytes: 1 << 30}},
		Dimms:      dimms,
		Edac:       &inventory.EdacCounters{},
	}
}

func (g generator) disks() *inventory.DisksSection {
	disks := make([]*inventory.Disk, 0, OSDisks+DataDisks)
	for i := 0; i < OSDisks+DataDisks; i++ {
		model, size := "SAMSUNG MZQL23T8HCLS-00A07", uint64(dataDiskBytes)
		if i < OSDisks {
			model, size = "SAMSUNG MZ1L21T9HCLS-00A07", osDiskBytes
		}
		id := strconv.Itoa(i)
		d := g.digest("disk", id)
		disks = append(disks, &inventory.Disk{
			Name:      "nvme" + id + "n1",
			Model:     model,
			Serial:    g.serial("S6", "disk-serial", id),
			Wwn:       "eui." + hex.EncodeToString(d[:8]),
			SizeBytes: size,
			Transport: inventory.DiskTransport_DISK_TRANSPORT_NVME,
			Smart:     &inventory.SmartStatus{Healthy: true},
		})
	}
	return &inventory.DisksSection{Disks: disks}
}

func (g generator) nics() *inventory.NicsSection {
	numa0, numa1 := uint32(0), uint32(1)
	return &inventory.NicsSection{Nics: []*inventory.Nic{
		{
			Name:       "ens1f0np0",
			Mac:        g.mac("nic", "0"),
			Driver:     "mlx5_core",
			Firmware:   "28.39.1002",
			SpeedMbps:  100_000,
			PciAddress: "0000:0c:00.0",
			NumaNode:   &numa0,
			Rdma:       inventory.RdmaType_RDMA_TYPE_NONE,
			Link:       inventory.LinkState_LINK_STATE_UP,
			Mtu:        1500,
		},
		{
			Name:          "ens2np0",
			Mac:           g.mac("nic", "1"),
			Driver:        "mlx5_core",
			Firmware:      "28.39.1002",
			SpeedMbps:     400_000,
			PciAddress:    "0000:8c:00.0",
			NumaNode:      &numa1,
			SriovTotalVfs: 16,
			Rdma:          inventory.RdmaType_RDMA_TYPE_ROCE,
			Link:          inventory.LinkState_LINK_STATE_UP,
			Mtu:           9000,
		},
	}}
}

func (g generator) gpus() *inventory.GpusSection {
	uuids := make([]string, GPUCount)
	for i := range uuids {
		uuids[i] = "GPU-" + g.uuid("gpu", strconv.Itoa(i))
	}
	gpus := make([]*inventory.Gpu, GPUCount)
	for i := range gpus {
		// NVSwitch connects every pair of GPUs: each sees the other seven as NV18 peers.
		var topology []*inventory.GpuPeerLink
		for j, peer := range uuids {
			if j != i {
				topology = append(topology, &inventory.GpuPeerLink{PeerUuid: peer, Link: inventory.GpuLinkType_GPU_LINK_TYPE_NV, Nvlinks: NVLinksPerGPU})
			}
		}
		links := make([]*inventory.NvlinkLink, NVLinksPerGPU)
		for l := range links {
			links[l] = &inventory.NvlinkLink{Link: uint32(l), State: inventory.LinkState_LINK_STATE_UP, Peer: "nvswitch:" + nvswitchBusIDs[l%NVSwitches], Version: 4}
		}
		numa := uint32(i / (GPUCount / NUMANodes))
		gpus[i] = &inventory.Gpu{
			Index:                      uint32(i),
			Uuid:                       uuids[i],
			PciBusId:                   gpuBusIDs[i],
			Name:                       GPUName,
			Architecture:               "hopper",
			VramBytes:                  vramBytes,
			Serial:                     g.serial("165", "gpu-serial", strconv.Itoa(i)),
			VbiosVersion:               "96.00.74.00.0B",
			BoardPartNumber:            "692-2G520-0200-000",
			NumaNode:                   &numa,
			PowerLimitMw:               700_000,
			PersistenceMode:            true,
			ComputeMode:                "default",
			CudaComputeCapabilityMajor: 9,
			CudaComputeCapabilityMinor: 0,
			Mig:                        &inventory.GpuMig{Capable: true, Current: inventory.MigMode_MIG_MODE_DISABLED, Profiles: migProfiles()},
			Nvlinks:                    links,
			Topology:                   topology,
			Ecc:                        &inventory.GpuEcc{Enabled: true, VolatileCounts: &inventory.EccCounts{}, AggregateCounts: &inventory.EccCounts{}},
			RowRemap:                   &inventory.GpuRowRemap{},
		}
	}
	return &inventory.GpusSection{DriverVersion: "550.90.07", CudaDriverVersion: "12.4", NvmlVersion: "12.550.90.07", Gpus: gpus}
}

// migProfiles are the GPU instance profiles of an H100 80GB.
func migProfiles() []*inventory.MigProfile {
	return []*inventory.MigProfile{
		{Id: 0, Name: "7g.80gb", MaxInstances: 1, MemoryBytes: 80 << 30},
		{Id: 5, Name: "4g.40gb", MaxInstances: 1, MemoryBytes: 40 << 30},
		{Id: 9, Name: "3g.40gb", MaxInstances: 2, MemoryBytes: 40 << 30},
		{Id: 14, Name: "2g.20gb", MaxInstances: 3, MemoryBytes: 20 << 30},
		{Id: 15, Name: "1g.20gb", MaxInstances: 4, MemoryBytes: 20 << 30},
		{Id: 19, Name: "1g.10gb", MaxInstances: 7, MemoryBytes: 10 << 30},
	}
}

func osSection() *inventory.OsSection {
	return &inventory.OsSection{
		Distro:        "ubuntu",
		DistroVersion: "24.04",
		Kernel:        "6.8.0-45-generic",
		Cgroup:        inventory.CgroupVersion_CGROUP_VERSION_V2,
		Kvm:           true,
		Iommu:         true,
		Runtimes:      []string{"containerd"},
		Hostname:      "fakehw",
	}
}
