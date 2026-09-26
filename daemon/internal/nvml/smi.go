package nvml

import (
	"bufio"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// ErrNoDriver reports a host without the NVIDIA driver's nvidia-smi: it has no NVIDIA GPUs to manage.
var ErrNoDriver = errors.New("nvml: nvidia-smi not found (no NVIDIA driver on this host)")

// SMI reads the GPUs through nvidia-smi, which ships with every NVIDIA driver: the cgo-free backend
// of this package. One `nvidia-smi -q -x` gives identity, memory, ECC, row remapping, MIG mode and
// instances, power, clocks and the fabric; `-L`, `--query-gpu`, `topo -m`, `nvlink -s` and
// `mig -lgip` add MIG UUIDs, compute capability, the topology matrix, NVLink states and the MIG
// profiles. Only the -q -x query is required; a failing optional query leaves its fields empty.
type SMI struct {
	// Run runs nvidia-smi with args (default: exec with a Timeout deadline). Tests replay captured
	// output.
	Run func(ctx context.Context, args ...string) ([]byte, error)
	// Timeout bounds each nvidia-smi run (default 30 s; a wedged GPU can hang it).
	Timeout time.Duration
}

// Snapshot is one reading of every GPU: the inventory section (stable facts and error counters)
// and the live samples (usage, which never goes into the inventory hash).
type Snapshot struct {
	Section *inventory.GpusSection
	Samples []Sample
}

// Sample is one GPU's live reading.
type Sample struct {
	UUID string
	// Framebuffer memory in bytes: total, used, reserved by the driver, free.
	MemoryTotal, MemoryUsed, MemoryReserved, MemoryFree uint64
	// Utilization in percent.
	UtilizationGPU, UtilizationMemory uint32
	TemperatureC                      uint32
	// Power draw and the enforced limit in milliwatts.
	PowerDrawMw, PowerLimitMw uint32
	SMClockMHz, MemClockMHz   uint32
	// Performance state, e.g. "P0".
	PState string
	// Processes running on the GPU (compute and graphics).
	Processes int
	// MIG devices' memory, by MIG UUID (or "gi<g>/ci<c>" when -L gave no UUID).
	Mig []MigSample
}

// MigSample is one MIG device's memory reading.
type MigSample struct {
	ID                      string
	MemoryTotal, MemoryUsed uint64
}

func (s SMI) run(ctx context.Context, args ...string) ([]byte, error) {
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if s.Run != nil {
		return s.Run(ctx, args...)
	}
	path, err := exec.LookPath("nvidia-smi")
	if err != nil {
		return nil, ErrNoDriver
	}
	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return out, fmt.Errorf("nvidia-smi %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

// Probe reports the driver version and the GPU count (a quick query, for bcd doctor).
func (s SMI) Probe(ctx context.Context) (Info, error) {
	out, err := s.run(ctx, "--query-gpu=driver_version", "--format=csv,noheader")
	if err != nil {
		return Info{}, err
	}
	info := Info{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line == "" {
			continue
		}
		info.DeviceCount++
		info.DriverVersion = line
	}
	return info, nil
}

// Snapshot queries every GPU.
func (s SMI) Snapshot(ctx context.Context) (*Snapshot, error) {
	out, err := s.run(ctx, "-q", "-x")
	if err != nil {
		return nil, err
	}
	log, err := parseQuery(out)
	if err != nil {
		return nil, err
	}
	snap := log.snapshot()
	// Optional queries: each fills what it can.
	if out, err := s.run(ctx, "-L"); err == nil {
		applyList(snap, parseList(out))
	}
	if out, err := s.run(ctx, "--query-gpu=uuid,compute_cap", "--format=csv,noheader"); err == nil {
		applyComputeCap(snap.Section, out)
	}
	if len(snap.Section.Gpus) > 1 {
		if out, err := s.run(ctx, "topo", "-m"); err == nil {
			applyTopology(snap.Section, parseTopology(out))
		}
	}
	if out, err := s.run(ctx, "nvlink", "-s"); err == nil {
		applyNvlinks(snap.Section, parseNvlinks(out))
		if remote, err := s.run(ctx, "nvlink", "-R"); err == nil {
			applyNvlinkPeers(snap.Section, parseNvlinkPeers(remote))
		}
	}
	for _, g := range snap.Section.Gpus {
		if g.Mig != nil && g.Mig.Current == inventory.MigMode_MIG_MODE_ENABLED {
			if out, err := s.run(ctx, "mig", "-lgip"); err == nil {
				applyMigProfiles(snap.Section, parseMigProfiles(out))
			}
			break
		}
	}
	inventory.Canonicalize(&inventory.NodeInventory{Gpus: snap.Section})
	return snap, nil
}

// Enrich merges a snapshot into a collected GPU section (sysfs: bus order, NUMA node) by UUID; GPUs
// only nvidia-smi sees are added. It returns the merged section (base when snap is nil).
func Enrich(base *inventory.GpusSection, snap *Snapshot) *inventory.GpusSection {
	if snap == nil || snap.Section == nil {
		return base
	}
	if base == nil {
		return snap.Section
	}
	byUUID := map[string]*inventory.Gpu{}
	for _, g := range base.Gpus {
		byUUID[g.Uuid] = g
	}
	if v := snap.Section.DriverVersion; v != "" {
		base.DriverVersion = v
	}
	if v := snap.Section.CudaDriverVersion; v != "" {
		base.CudaDriverVersion = v
	}
	if v := snap.Section.NvmlVersion; v != "" {
		base.NvmlVersion = v
	}
	for _, g := range snap.Section.Gpus {
		have := byUUID[g.Uuid]
		if have == nil {
			g.Index = uint32(len(base.Gpus))
			base.Gpus = append(base.Gpus, g)
			continue
		}
		index, numa, arch := have.Index, have.NumaNode, have.Architecture
		*have = *g
		have.Index = index
		if have.NumaNode == nil {
			have.NumaNode = numa
		}
		if have.Architecture == "" {
			have.Architecture = arch
		}
	}
	return base
}

// ---- nvidia-smi -q -x ----------------------------------------------------------------------------

type smiLog struct {
	DriverVersion string   `xml:"driver_version"`
	CudaVersion   string   `xml:"cuda_version"`
	GPUs          []smiGPU `xml:"gpu"`
}

type smiGPU struct {
	ID                  string `xml:"id,attr"`
	ProductName         string `xml:"product_name"`
	ProductArchitecture string `xml:"product_architecture"`
	PersistenceMode     string `xml:"persistence_mode"`
	MigMode             struct {
		Current string `xml:"current_mig"`
		Pending string `xml:"pending_mig"`
	} `xml:"mig_mode"`
	MigDevices struct {
		Devices []struct {
			Index             uint32    `xml:"index"`
			GpuInstanceID     uint32    `xml:"gpu_instance_id"`
			ComputeInstanceID uint32    `xml:"compute_instance_id"`
			FbMemoryUsage     smiMemory `xml:"fb_memory_usage"`
		} `xml:"mig_device"`
	} `xml:"mig_devices"`
	Serial          string `xml:"serial"`
	UUID            string `xml:"uuid"`
	VbiosVersion    string `xml:"vbios_version"`
	BoardPartNumber string `xml:"board_part_number"`
	Fabric          struct {
		CliqueID    string `xml:"cliqueId"`
		ClusterUUID string `xml:"clusterUuid"`
	} `xml:"fabric"`
	Pci struct {
		BusID string `xml:"pci_bus_id"`
	} `xml:"pci"`
	PerformanceState string    `xml:"performance_state"`
	FbMemoryUsage    smiMemory `xml:"fb_memory_usage"`
	ComputeMode      string    `xml:"compute_mode"`
	Utilization      struct {
		GPU    string `xml:"gpu_util"`
		Memory string `xml:"memory_util"`
	} `xml:"utilization"`
	EccMode struct {
		Current string `xml:"current_ecc"`
		Pending string `xml:"pending_ecc"`
	} `xml:"ecc_mode"`
	EccErrors struct {
		Volatile  smiEcc `xml:"volatile"`
		Aggregate smiEcc `xml:"aggregate"`
	} `xml:"ecc_errors"`
	RemappedRows struct {
		Correctable   string `xml:"remapped_row_corr"`
		Uncorrectable string `xml:"remapped_row_unc"`
		Pending       string `xml:"remapped_row_pending"`
		Failure       string `xml:"remapped_row_failure"`
	} `xml:"remapped_rows"`
	Temperature struct {
		GPU string `xml:"gpu_temp"`
	} `xml:"temperature"`
	// R535+ calls it gpu_power_readings; older drivers power_readings.
	GpuPowerReadings smiPower `xml:"gpu_power_readings"`
	PowerReadings    smiPower `xml:"power_readings"`
	Clocks           struct {
		SM     string `xml:"sm_clock"`
		Memory string `xml:"mem_clock"`
	} `xml:"clocks"`
	Processes struct {
		Infos []struct{} `xml:"process_info"`
	} `xml:"processes"`
}

type smiMemory struct {
	Total    string `xml:"total"`
	Reserved string `xml:"reserved"`
	Used     string `xml:"used"`
	Free     string `xml:"free"`
}

// smiEcc reads both layouts: R525+ (sram_*/dram_*) and older (single_bit/double_bit totals).
type smiEcc struct {
	SramCorrectable         string `xml:"sram_correctable"`
	SramUncorrectable       string `xml:"sram_uncorrectable"`
	SramUncorrectableParity string `xml:"sram_uncorrectable_parity"`
	SramUncorrectableSecded string `xml:"sram_uncorrectable_secded"`
	DramCorrectable         string `xml:"dram_correctable"`
	DramUncorrectable       string `xml:"dram_uncorrectable"`
	SingleBit               struct {
		Total string `xml:"total"`
	} `xml:"single_bit"`
	DoubleBit struct {
		Total string `xml:"total"`
	} `xml:"double_bit"`
}

type smiPower struct {
	PowerDraw         string `xml:"power_draw"`
	AveragePowerDraw  string `xml:"average_power_draw"`
	InstantPowerDraw  string `xml:"instant_power_draw"`
	CurrentPowerLimit string `xml:"current_power_limit"`
	PowerLimit        string `xml:"power_limit"`
	EnforcedLimit     string `xml:"enforced_power_limit"`
}

func parseQuery(out []byte) (*smiLog, error) {
	log := &smiLog{}
	dec := xml.NewDecoder(bytes.NewReader(out))
	// nvidia-smi declares a DTD (nvsmi_device_v12.dtd); nothing here needs it.
	dec.Strict = false
	if err := dec.Decode(log); err != nil {
		return nil, fmt.Errorf("nvidia-smi -q -x: %w", err)
	}
	return log, nil
}

// na reports nvidia-smi's "no value" spellings.
func na(v string) bool {
	switch strings.TrimSpace(v) {
	case "", "N/A", "[N/A]", "Not Supported", "[Not Supported]", "Unknown Error", "None":
		return true
	}
	return false
}

// number reads the leading number of "81559 MiB", "700.00 W", "30 C", "0 %".
func number(v string) (float64, bool) {
	if na(v) {
		return 0, false
	}
	fields := strings.Fields(v)
	if len(fields) == 0 {
		return 0, false
	}
	f, err := strconv.ParseFloat(fields[0], 64)
	return f, err == nil
}

func count(v string) uint64 {
	f, _ := number(v)
	if f < 0 {
		return 0
	}
	return uint64(f)
}

// mib reads a MiB figure as bytes.
func mib(v string) uint64 { return count(v) << 20 }

// milliwatts reads "700.00 W".
func milliwatts(v string) uint32 {
	f, _ := number(v)
	return uint32(f*1000 + 0.5)
}

func first(values ...string) string {
	for _, v := range values {
		if !na(v) {
			return v
		}
	}
	return ""
}

func (p smiPower) draw() string  { return first(p.InstantPowerDraw, p.PowerDraw, p.AveragePowerDraw) }
func (p smiPower) limit() string { return first(p.CurrentPowerLimit, p.EnforcedLimit, p.PowerLimit) }

func (e smiEcc) counts() *inventory.EccCounts {
	c := &inventory.EccCounts{}
	switch {
	case !na(e.SramCorrectable) || !na(e.DramCorrectable) || !na(e.SramUncorrectable) || !na(e.SramUncorrectableParity):
		c.Correctable = count(e.SramCorrectable) + count(e.DramCorrectable)
		c.Uncorrectable = count(e.SramUncorrectable) + count(e.SramUncorrectableParity) + count(e.SramUncorrectableSecded) + count(e.DramUncorrectable)
	case !na(e.SingleBit.Total) || !na(e.DoubleBit.Total):
		c.Correctable = count(e.SingleBit.Total)
		c.Uncorrectable = count(e.DoubleBit.Total)
	default:
		return nil
	}
	return c
}

func enabled(v string) bool { return strings.EqualFold(strings.TrimSpace(v), "Enabled") }

func yes(v string) bool { return strings.EqualFold(strings.TrimSpace(v), "Yes") }

func migMode(v string) inventory.MigMode {
	switch {
	case na(v):
		return inventory.MigMode_MIG_MODE_UNSPECIFIED
	case enabled(v):
		return inventory.MigMode_MIG_MODE_ENABLED
	}
	return inventory.MigMode_MIG_MODE_DISABLED
}

// computeMode maps "Default", "Exclusive_Process", "Prohibited" to the inventory's spelling.
func computeMode(v string) string {
	if na(v) {
		return ""
	}
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(v)), "_", "-")
}

func (l *smiLog) snapshot() *Snapshot {
	section := &inventory.GpusSection{DriverVersion: strings.TrimSpace(l.DriverVersion)}
	if !na(l.CudaVersion) {
		section.CudaDriverVersion = strings.TrimSpace(l.CudaVersion)
	}
	snap := &Snapshot{Section: section}
	for i, x := range l.GPUs {
		bus := x.Pci.BusID
		if bus == "" {
			bus = x.ID
		}
		g := &inventory.Gpu{
			Index:           uint32(i),
			Uuid:            strings.TrimSpace(x.UUID),
			PciBusId:        strings.ToUpper(strings.TrimSpace(bus)),
			Name:            strings.TrimSpace(x.ProductName),
			VramBytes:       mib(x.FbMemoryUsage.Total),
			PowerLimitMw:    milliwatts(first(x.GpuPowerReadings.limit(), x.PowerReadings.limit())),
			PersistenceMode: enabled(x.PersistenceMode),
			ComputeMode:     computeMode(x.ComputeMode),
		}
		if !na(x.ProductArchitecture) {
			g.Architecture = strings.ToLower(strings.TrimSpace(x.ProductArchitecture))
		}
		if !na(x.Serial) {
			g.Serial = strings.TrimSpace(x.Serial)
		}
		if !na(x.VbiosVersion) {
			g.VbiosVersion = strings.TrimSpace(x.VbiosVersion)
		}
		if !na(x.BoardPartNumber) {
			g.BoardPartNumber = strings.TrimSpace(x.BoardPartNumber)
		}
		if current := migMode(x.MigMode.Current); current != inventory.MigMode_MIG_MODE_UNSPECIFIED {
			mig := &inventory.GpuMig{Capable: true, Current: current}
			if pending := migMode(x.MigMode.Pending); pending != current {
				mig.Pending = pending
			}
			for _, d := range x.MigDevices.Devices {
				mig.Instances = append(mig.Instances, &inventory.MigInstance{GiId: d.GpuInstanceID, CiId: d.ComputeInstanceID})
			}
			g.Mig = mig
		}
		if !na(x.Fabric.ClusterUUID) && strings.Trim(x.Fabric.ClusterUUID, "0-") != "" {
			clique, _ := strconv.ParseUint(strings.TrimSpace(x.Fabric.CliqueID), 10, 32)
			g.Fabric = &inventory.GpuFabric{ClusterUuid: strings.ToLower(strings.TrimSpace(x.Fabric.ClusterUUID)), CliqueId: uint32(clique)}
		}
		if !na(x.EccMode.Current) {
			ecc := &inventory.GpuEcc{
				Enabled:         enabled(x.EccMode.Current),
				VolatileCounts:  x.EccErrors.Volatile.counts(),
				AggregateCounts: x.EccErrors.Aggregate.counts(),
			}
			if !na(x.EccMode.Pending) {
				if pending := enabled(x.EccMode.Pending); pending != ecc.Enabled {
					ecc.PendingEnabled = &pending
				}
			}
			g.Ecc = ecc
		}
		if r := x.RemappedRows; !na(r.Correctable) || !na(r.Pending) {
			g.RowRemap = &inventory.GpuRowRemap{
				Correctable:   uint32(count(r.Correctable)),
				Uncorrectable: uint32(count(r.Uncorrectable)),
				Pending:       yes(r.Pending),
				Failure:       yes(r.Failure),
			}
		}
		section.Gpus = append(section.Gpus, g)

		util, _ := number(x.Utilization.GPU)
		memUtil, _ := number(x.Utilization.Memory)
		temp, _ := number(x.Temperature.GPU)
		sm, _ := number(x.Clocks.SM)
		memClock, _ := number(x.Clocks.Memory)
		sample := Sample{
			UUID:              g.Uuid,
			MemoryTotal:       mib(x.FbMemoryUsage.Total),
			MemoryUsed:        mib(x.FbMemoryUsage.Used),
			MemoryReserved:    mib(x.FbMemoryUsage.Reserved),
			MemoryFree:        mib(x.FbMemoryUsage.Free),
			UtilizationGPU:    uint32(util),
			UtilizationMemory: uint32(memUtil),
			TemperatureC:      uint32(temp),
			PowerDrawMw:       milliwatts(first(x.GpuPowerReadings.draw(), x.PowerReadings.draw())),
			PowerLimitMw:      g.PowerLimitMw,
			SMClockMHz:        uint32(sm),
			MemClockMHz:       uint32(memClock),
			Processes:         len(x.Processes.Infos),
		}
		if !na(x.PerformanceState) {
			sample.PState = strings.TrimSpace(x.PerformanceState)
		}
		for _, d := range x.MigDevices.Devices {
			sample.Mig = append(sample.Mig, MigSample{
				ID:          fmt.Sprintf("gi%d/ci%d", d.GpuInstanceID, d.ComputeInstanceID),
				MemoryTotal: mib(d.FbMemoryUsage.Total),
				MemoryUsed:  mib(d.FbMemoryUsage.Used),
			})
		}
		snap.Samples = append(snap.Samples, sample)
	}
	return snap
}

// ---- nvidia-smi -L -------------------------------------------------------------------------------

type listedGPU struct {
	index uint32
	uuid  string
	mig   []listedMig
}

type listedMig struct {
	profile string
	device  uint32
	uuid    string
}

var (
	listGPU = regexp.MustCompile(`^GPU (\d+): .*\(UUID: (GPU-[^)]+)\)`)
	listMIG = regexp.MustCompile(`^\s+MIG (\S+)\s+Device\s+(\d+): \(UUID: (MIG-[^)]+)\)`)
)

func parseList(out []byte) []listedGPU {
	var gpus []listedGPU
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if m := listGPU.FindStringSubmatch(line); m != nil {
			i, _ := strconv.ParseUint(m[1], 10, 32)
			gpus = append(gpus, listedGPU{index: uint32(i), uuid: m[2]})
			continue
		}
		if m := listMIG.FindStringSubmatch(line); m != nil && len(gpus) > 0 {
			d, _ := strconv.ParseUint(m[2], 10, 32)
			last := &gpus[len(gpus)-1]
			last.mig = append(last.mig, listedMig{profile: m[1], device: uint32(d), uuid: m[3]})
		}
	}
	return gpus
}

// applyList names each MIG instance: the -q -x mig_device index is the -L "Device N".
func applyList(snap *Snapshot, listed []listedGPU) {
	byUUID := map[string]listedGPU{}
	for _, l := range listed {
		byUUID[l.uuid] = l
	}
	for i, g := range snap.Section.Gpus {
		l, ok := byUUID[g.Uuid]
		if !ok || g.Mig == nil {
			continue
		}
		byDevice := map[uint32]listedMig{}
		for _, m := range l.mig {
			byDevice[m.device] = m
		}
		// The instances were appended in mig_device order; recover each one's device index.
		for j, inst := range g.Mig.Instances {
			m, ok := byDevice[uint32(j)]
			if !ok {
				continue
			}
			inst.Profile, inst.Uuid = m.profile, m.uuid
			if i < len(snap.Samples) && j < len(snap.Samples[i].Mig) {
				snap.Samples[i].Mig[j].ID = m.uuid
			}
		}
	}
}

// ---- --query-gpu=uuid,compute_cap ----------------------------------------------------------------

func applyComputeCap(section *inventory.GpusSection, out []byte) {
	byUUID := map[string]*inventory.Gpu{}
	for _, g := range section.Gpus {
		byUUID[g.Uuid] = g
	}
	for _, line := range strings.Split(string(out), "\n") {
		uuid, cc, ok := strings.Cut(line, ",")
		g := byUUID[strings.TrimSpace(uuid)]
		if !ok || g == nil {
			continue
		}
		major, minor, ok := strings.Cut(strings.TrimSpace(cc), ".")
		ma, err1 := strconv.ParseUint(major, 10, 32)
		mi, err2 := strconv.ParseUint(minor, 10, 32)
		if ok && err1 == nil && err2 == nil {
			g.CudaComputeCapabilityMajor, g.CudaComputeCapabilityMinor = uint32(ma), uint32(mi)
		}
	}
}

// ---- nvidia-smi topo -m --------------------------------------------------------------------------

var ansi = regexp.MustCompile(`\x1b\[[0-9;]*m`)

// parseTopology reads the GPU columns of the matrix: cell[i][j] is GPU i to GPU j ("X" on the
// diagonal).
func parseTopology(out []byte) map[uint32]map[uint32]string {
	lines := strings.Split(ansi.ReplaceAllString(string(out), ""), "\n")
	var columns []uint32
	matrix := map[uint32]map[uint32]string{}
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if columns == nil {
			for _, f := range fields {
				n, ok := strings.CutPrefix(f, "GPU")
				i, err := strconv.ParseUint(n, 10, 32)
				if !ok || err != nil {
					break
				}
				columns = append(columns, uint32(i))
			}
			continue
		}
		name, ok := strings.CutPrefix(fields[0], "GPU")
		row, err := strconv.ParseUint(name, 10, 32)
		if !ok || err != nil {
			if strings.HasPrefix(fields[0], "Legend") {
				break
			}
			continue
		}
		cells := map[uint32]string{}
		for j, col := range columns {
			if 1+j < len(fields) {
				cells[col] = fields[1+j]
			}
		}
		matrix[uint32(row)] = cells
	}
	return matrix
}

func linkType(cell string) (inventory.GpuLinkType, uint32) {
	if n, ok := strings.CutPrefix(cell, "NV"); ok {
		links, err := strconv.ParseUint(n, 10, 32)
		if err == nil {
			return inventory.GpuLinkType_GPU_LINK_TYPE_NV, uint32(links)
		}
	}
	switch cell {
	case "PIX":
		return inventory.GpuLinkType_GPU_LINK_TYPE_PIX, 0
	case "PXB":
		return inventory.GpuLinkType_GPU_LINK_TYPE_PXB, 0
	case "PHB":
		return inventory.GpuLinkType_GPU_LINK_TYPE_PHB, 0
	case "NODE":
		return inventory.GpuLinkType_GPU_LINK_TYPE_NODE, 0
	case "SYS", "SOC":
		return inventory.GpuLinkType_GPU_LINK_TYPE_SYS, 0
	}
	return inventory.GpuLinkType_GPU_LINK_TYPE_UNSPECIFIED, 0
}

// applyTopology fills each GPU's topology row; nvidia-smi numbers GPUs as -q -x lists them.
func applyTopology(section *inventory.GpusSection, matrix map[uint32]map[uint32]string) {
	for i, g := range section.Gpus {
		row := matrix[uint32(i)]
		if row == nil {
			continue
		}
		g.Topology = nil
		for j, peer := range section.Gpus {
			if j == i {
				continue
			}
			link, n := linkType(row[uint32(j)])
			if link == inventory.GpuLinkType_GPU_LINK_TYPE_UNSPECIFIED {
				continue
			}
			g.Topology = append(g.Topology, &inventory.GpuPeerLink{PeerUuid: peer.Uuid, Link: link, Nvlinks: n})
		}
	}
}

// ---- nvidia-smi nvlink -s ------------------------------------------------------------------------

var (
	nvlinkGPU  = regexp.MustCompile(`^GPU \d+: .*\(UUID: (GPU-[^)]+)\)`)
	nvlinkLink = regexp.MustCompile(`^\s*Link (\d+): (.+)$`)
)

func parseNvlinks(out []byte) map[string][]*inventory.NvlinkLink {
	links := map[string][]*inventory.NvlinkLink{}
	current := ""
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if m := nvlinkGPU.FindStringSubmatch(line); m != nil {
			current = m[1]
			continue
		}
		m := nvlinkLink.FindStringSubmatch(line)
		if m == nil || current == "" {
			continue
		}
		n, _ := strconv.ParseUint(m[1], 10, 32)
		state := inventory.LinkState_LINK_STATE_UP
		if strings.Contains(m[2], "inactive") || strings.Contains(m[2], "down") {
			state = inventory.LinkState_LINK_STATE_DOWN
		}
		links[current] = append(links[current], &inventory.NvlinkLink{Link: uint32(n), State: state})
	}
	return links
}

// "	 Link 0: Remote Device 00000000:C5:00.0: Link 29"
var nvlinkRemote = regexp.MustCompile(`^\s*Link (\d+): Remote Device ([0-9A-Fa-f]+:[0-9A-Fa-f]+:[0-9A-Fa-f]+\.[0-9A-Fa-f]+)`)

// parseNvlinkPeers reads `nvidia-smi nvlink -R`: each GPU's links and the PCI bus id at their far end.
func parseNvlinkPeers(out []byte) map[string]map[uint32]string {
	peers := map[string]map[uint32]string{}
	current := ""
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if m := nvlinkGPU.FindStringSubmatch(line); m != nil {
			current = m[1]
			continue
		}
		m := nvlinkRemote.FindStringSubmatch(line)
		if m == nil || current == "" {
			continue
		}
		n, _ := strconv.ParseUint(m[1], 10, 32)
		if peers[current] == nil {
			peers[current] = map[uint32]string{}
		}
		peers[current][uint32(n)] = strings.ToUpper(m[2])
	}
	return peers
}

// applyNvlinkPeers names each link's peer: the GPU on that bus, else "nvswitch:<bus>" (a link to
// anything but a GPU of this node goes through an NVSwitch).
func applyNvlinkPeers(section *inventory.GpusSection, peers map[string]map[uint32]string) {
	byBus := map[string]string{}
	for _, g := range section.Gpus {
		byBus[pciBusID(g.PciBusId)] = g.Uuid
	}
	for _, g := range section.Gpus {
		for _, l := range g.Nvlinks {
			bus, ok := peers[g.Uuid][l.Link]
			if !ok {
				continue
			}
			if uuid := byBus[pciBusID(bus)]; uuid != "" {
				l.Peer = uuid
			} else {
				l.Peer = "nvswitch:" + pciBusID(bus)
			}
		}
	}
}

// pciBusID widens a bus id to NVML's 8-digit domain: 0000:C5:00.0 → 00000000:C5:00.0.
func pciBusID(bus string) string {
	domain, rest, ok := strings.Cut(strings.ToUpper(bus), ":")
	if !ok {
		return strings.ToUpper(bus)
	}
	for len(domain) < 8 {
		domain = "0" + domain
	}
	return domain + ":" + rest
}

func applyNvlinks(section *inventory.GpusSection, links map[string][]*inventory.NvlinkLink) {
	for _, g := range section.Gpus {
		if l, ok := links[g.Uuid]; ok {
			g.Nvlinks = l
		}
	}
}

// ---- nvidia-smi mig -lgip ------------------------------------------------------------------------

// "|   0  MIG 1g.10gb       19     7/7        9.50       No     14     0     0   |"
var migProfileRow = regexp.MustCompile(`^\|\s+(\d+)\s+MIG\s+(\S+)\s+(\d+)\s+\d+/(\d+)\s+([\d.]+)\s`)

func parseMigProfiles(out []byte) map[uint32][]*inventory.MigProfile {
	profiles := map[uint32][]*inventory.MigProfile{}
	for _, line := range strings.Split(string(out), "\n") {
		m := migProfileRow.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		gpu, _ := strconv.ParseUint(m[1], 10, 32)
		id, _ := strconv.ParseUint(m[3], 10, 32)
		total, _ := strconv.ParseUint(m[4], 10, 32)
		gib, _ := strconv.ParseFloat(m[5], 64)
		profiles[uint32(gpu)] = append(profiles[uint32(gpu)], &inventory.MigProfile{
			Id:           uint32(id),
			Name:         m[2],
			MaxInstances: uint32(total),
			MemoryBytes:  uint64(gib*float64(1<<30)+0.5) &^ (1<<20 - 1),
		})
	}
	for _, list := range profiles {
		sort.SliceStable(list, func(i, j int) bool { return list[i].Id < list[j].Id })
	}
	return profiles
}

func applyMigProfiles(section *inventory.GpusSection, profiles map[uint32][]*inventory.MigProfile) {
	for i, g := range section.Gpus {
		if list, ok := profiles[uint32(i)]; ok && g.Mig != nil {
			g.Mig.Profiles = list
		}
	}
}
