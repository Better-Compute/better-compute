package inventory

import (
	"bufio"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Collector reads the host inventory from procfs and sysfs (PLAN.md §10.1) without cgo: DMI for the
// system section, /proc/cpuinfo and the NUMA topology, meminfo, hugepages and EDAC counters, block
// devices, physical NICs, and NVIDIA GPUs through the kernel driver's /proc/driver/nvidia files
// (uuid, model, VBIOS, bus id; NVML adds the rest when built in). Anything unreadable is left out
// rather than failing the collection: a section is absent when its source is.
type Collector struct {
	// Root prefixes every path ("" is the real filesystem); tests point it at a fake tree.
	Root string
	// Hostname defaults to os.Hostname.
	Hostname func() string
	// Now stamps CollectedAt (default time.Now).
	Now func() time.Time
	// Trace, when set, is told every absolute path the collector looks at (read, stat, readlink,
	// listing), before it looks: Capture uses it to copy exactly those paths into a fixture tree. A
	// listed directory comes with a trailing slash.
	Trace func(abs string)
	// GPUs, when set, supplies the GPU section when /proc/driver/nvidia lists none: WSL's paravirtual
	// GPU (/dev/dxg) has no procfs entry and no PCI sysfs, so nvidia-smi is the only source there. Its
	// section is taken as it comes (bus ids may name a virtual bus).
	GPUs func() *GpusSection
	// DMI, when set, supplies DMI values (by sysfs file name: product_uuid, product_serial, ...) that
	// read empty: the UUID and serials are root-only, so an unprivileged bcd node asks bcd helper. It
	// is called at most once per collection, and only when a file read empty.
	DMI func() map[string]string
	// PassedThrough, when set, names the GPU last seen at a PCI address ("0000:18:00.0"), for NVIDIA
	// GPUs bound to vfio-pci (passed through to a VM, invisible to the NVIDIA driver): without it
	// they drop out of the inventory. GPUMemory.Lookup is the usual one.
	PassedThrough func(pciAddress string) *Gpu
}

// Collect gathers every section and canonicalizes the result.
func (c Collector) Collect() (*NodeInventory, error) {
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	inv := &NodeInventory{
		SchemaVersion: 1,
		CollectedAt:   now(),
		System:        c.system(),
		Cpu:           c.cpu(),
		Memory:        c.memory(),
		Disks:         c.disks(),
		Nics:          c.nics(),
		Gpus:          c.gpus(),
		Os:            c.os(),
	}
	if inv.Gpus == nil && c.GPUs != nil {
		inv.Gpus = c.GPUs()
	}
	Canonicalize(inv)
	return inv, nil
}

func (c Collector) p(abs string) string {
	if c.Trace != nil {
		c.Trace(abs)
	}
	if c.Root == "" {
		return abs
	}
	return filepath.Join(c.Root, filepath.FromSlash(abs))
}

func (c Collector) read(abs string) string {
	b, err := os.ReadFile(c.p(abs))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func (c Collector) exists(abs string) bool {
	_, err := os.Stat(c.p(abs))
	return err == nil
}

func (c Collector) uint(abs string) (uint64, bool) {
	v, err := strconv.ParseUint(c.read(abs), 10, 64)
	return v, err == nil
}

// link returns the base name of a symlink's target ("" when it is not a link).
func (c Collector) link(abs string) string {
	target, err := os.Readlink(c.p(abs))
	if err != nil {
		return ""
	}
	return path.Base(filepath.ToSlash(target))
}

// linkPath returns a symlink's target as a slash path ("" when it is not a link).
func (c Collector) linkPath(abs string) string {
	target, err := os.Readlink(c.p(abs))
	if err != nil {
		return ""
	}
	return filepath.ToSlash(target)
}

func (c Collector) list(abs string) []string {
	// The trailing slash tells Trace this is a listing (Capture copies the entries too).
	entries, err := os.ReadDir(c.p(abs + "/"))
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.Name())
	}
	sort.Strings(out)
	return out
}

// ---- system ------------------------------------------------------------------------------------

const efiGlobal = "8be4df61-93ca-11d2-aa0d-00e098032b8c"

func (c Collector) system() *SystemSection {
	var privileged map[string]string
	asked := false
	dmi := func(name string) string {
		if v := c.read("/sys/class/dmi/id/" + name); v != "" || c.DMI == nil {
			return v
		}
		// Only where DMI exists at all: a machine without SMBIOS has nothing root could read either.
		if !c.exists("/sys/class/dmi/id") {
			return ""
		}
		if !asked {
			asked = true
			privileged = c.DMI()
		}
		return strings.TrimSpace(privileged[name])
	}
	s := &SystemSection{
		Vendor:        dmi("sys_vendor"),
		Product:       dmi("product_name"),
		Serial:        dmi("product_serial"),
		ProductUuid:   strings.ToLower(dmi("product_uuid")),
		BoardVendor:   dmi("board_vendor"),
		BoardProduct:  dmi("board_name"),
		BoardSerial:   dmi("board_serial"),
		ChassisSerial: dmi("chassis_serial"),
		BiosVendor:    dmi("bios_vendor"),
		BiosVersion:   dmi("bios_version"),
		BootMode:      BootMode_BOOT_MODE_BIOS,
	}
	if c.exists("/sys/firmware/efi") {
		s.BootMode = BootMode_BOOT_MODE_UEFI
		// efivarfs: 4 attribute bytes, then the variable (1 = enabled).
		if b, err := os.ReadFile(c.p("/sys/firmware/efi/efivars/SecureBoot-" + efiGlobal)); err == nil && len(b) >= 5 {
			on := b[4] == 1
			s.SecureBoot = &on
		}
	}
	if c.exists("/sys/class/tpm/tpm0") {
		version := "1.2"
		if major := c.read("/sys/class/tpm/tpm0/tpm_version_major"); major == "2" {
			version = "2.0"
		}
		s.Tpm = &Tpm{Version: version}
	}
	if *s == (SystemSection{BootMode: s.BootMode}) {
		return nil
	}
	return s
}

// ---- cpu ---------------------------------------------------------------------------------------

func (c Collector) cpu() *CpuSection {
	f, err := os.Open(c.p("/proc/cpuinfo"))
	if err != nil {
		return nil
	}
	defer f.Close()
	s := &CpuSection{Architecture: machine(runtime.GOARCH)}
	flags := map[string]bool{}
	sockets := map[string]bool{}
	cores := map[string]bool{}
	var threads uint32
	physical, core := "0", ""
	armPart := ""
	flush := func() {
		if core != "" {
			cores[physical+"/"+core] = true
		}
		core = ""
		physical = "0"
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		key, value, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			if strings.TrimSpace(sc.Text()) == "" {
				flush()
			}
			continue
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		switch key {
		case "processor":
			threads++
		case "vendor_id":
			s.Vendor = value
		case "CPU implementer":
			if s.Vendor == "" {
				s.Vendor = armImplementer(value)
			}
		case "model name":
			s.Model = value
		case "CPU part":
			armPart = strings.ToLower(value)
		case "physical id":
			physical = value
			sockets[value] = true
		case "core id":
			core = value
		case "flags", "Features":
			for _, fl := range strings.Fields(value) {
				flags[fl] = true
			}
		}
	}
	flush()
	s.Threads = threads
	if len(sockets) == 0 {
		// arm64 (and some VMs) print no "physical id"/"core id": the kernel's topology says it.
		sockets, cores = c.sysfsTopology()
	}
	s.Sockets = uint32(max(len(sockets), 1))
	s.Cores = uint32(len(cores))
	if s.Cores == 0 {
		s.Cores = threads
	}
	if s.Model == "" && armPart != "" {
		s.Model = armCore(s.Vendor, armPart)
	}
	for fl := range flags {
		s.Flags = append(s.Flags, fl)
	}
	sort.Strings(s.Flags)
	for _, name := range c.list("/sys/devices/system/node") {
		id, ok := strings.CutPrefix(name, "node")
		n, err := strconv.ParseUint(id, 10, 32)
		if !ok || err != nil {
			continue
		}
		node := &NumaNode{Id: uint32(n), Cpus: c.read("/sys/devices/system/node/" + name + "/cpulist")}
		for _, line := range strings.Split(c.read("/sys/devices/system/node/"+name+"/meminfo"), "\n") {
			// "Node 0 MemTotal:       263842420 kB"
			if i := strings.Index(line, "MemTotal:"); i >= 0 {
				node.MemoryBytes = kib(line[i+len("MemTotal:"):])
			}
		}
		// NUMA-local hugepage pools (§3.8): what a pinned VM or hold on this node can back its memory with.
		node.Hugepages = c.hugepagePools("/sys/devices/system/node/" + name + "/hugepages")
		s.NumaNodes = append(s.NumaNodes, node)
	}
	// "1-3,65-67", or empty when nothing is isolated.
	s.IsolatedCpus = c.read("/sys/devices/system/cpu/isolated")
	return s
}

// hugepagePools reads the hugepages-<n>kB directories under dir (the host's /sys/kernel/mm/hugepages or a
// NUMA node's), sorted by page size. Only the configured total: free pages change with every VM and would
// move the inventory hash.
func (c Collector) hugepagePools(dir string) []*HugepagePool {
	var pools []*HugepagePool
	for _, name := range c.list(dir) {
		// hugepages-2048kB
		size, ok := strings.CutPrefix(name, "hugepages-")
		size, ok2 := strings.CutSuffix(size, "kB")
		n, err := strconv.ParseUint(size, 10, 64)
		if !ok || !ok2 || err != nil {
			continue
		}
		total, _ := c.uint(dir + "/" + name + "/nr_hugepages")
		pools = append(pools, &HugepagePool{PageSizeBytes: n * 1024, Total: total})
	}
	sort.Slice(pools, func(i, j int) bool { return pools[i].PageSizeBytes < pools[j].PageSizeBytes })
	return pools
}

func machine(goarch string) string {
	switch goarch {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "aarch64"
	}
	return goarch
}

// sysfsTopology reads every online CPU's package and core id from
// /sys/devices/system/cpu/cpu<N>/topology: sockets, and cores keyed "<package>/<core>".
func (c Collector) sysfsTopology() (sockets, cores map[string]bool) {
	sockets, cores = map[string]bool{}, map[string]bool{}
	for _, name := range c.list("/sys/devices/system/cpu") {
		n, ok := strings.CutPrefix(name, "cpu")
		if _, err := strconv.Atoi(n); !ok || err != nil {
			continue
		}
		dir := "/sys/devices/system/cpu/" + name + "/topology"
		pkg := c.read(dir + "/physical_package_id")
		core := c.read(dir + "/core_id")
		if pkg == "" || core == "" {
			continue // offline CPUs have no topology directory
		}
		sockets[pkg] = true
		cores[pkg+"/"+core] = true
	}
	return sockets, cores
}

// armCore names an Arm core from /proc/cpuinfo's "CPU part" (MIDR part number), for server parts
// whose cpuinfo has no model name. Unknown parts read as "<vendor> <part>".
func armCore(vendor, part string) string {
	known := map[string]string{
		"0xd0c": "Neoverse-N1", "0xd40": "Neoverse-V1", "0xd49": "Neoverse-N2", "0xd4f": "Neoverse-V2",
		"0xd8e": "Neoverse-N3", "0xd84": "Neoverse-V3", "0xd83": "Neoverse-V3AE", "0xac3": "AmpereOne", "0xac4": "AmpereOne",
	}
	if name, ok := known[part]; ok {
		return name
	}
	return strings.TrimSpace(vendor + " " + part)
}

func armImplementer(code string) string {
	switch strings.ToLower(code) {
	case "0x41":
		return "ARM"
	case "0x4e":
		return "NVIDIA"
	case "0xc0":
		return "Ampere"
	case "0x48":
		return "HiSilicon"
	}
	return code
}

// kib parses "<n> kB" into bytes.
func kib(s string) uint64 {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return 0
	}
	n, _ := strconv.ParseUint(fields[0], 10, 64)
	return n * 1024
}

// ---- memory ------------------------------------------------------------------------------------

func (c Collector) memory() *MemorySection {
	s := &MemorySection{}
	for _, line := range strings.Split(c.read("/proc/meminfo"), "\n") {
		if rest, ok := strings.CutPrefix(line, "MemTotal:"); ok {
			s.TotalBytes = kib(rest)
		}
	}
	if s.TotalBytes == 0 {
		return nil
	}
	s.Hugepages = c.hugepagePools("/sys/kernel/mm/hugepages")
	if mcs := c.list("/sys/devices/system/edac/mc"); len(mcs) > 0 {
		edac := &EdacCounters{}
		found := false
		for _, mc := range mcs {
			if !strings.HasPrefix(mc, "mc") {
				continue
			}
			if ce, ok := c.uint("/sys/devices/system/edac/mc/" + mc + "/ce_count"); ok {
				edac.Correctable += ce
				found = true
			}
			if ue, ok := c.uint("/sys/devices/system/edac/mc/" + mc + "/ue_count"); ok {
				edac.Uncorrectable += ue
				found = true
			}
		}
		if found {
			s.Edac = edac
		}
	}
	return s
}

// ---- disks -------------------------------------------------------------------------------------

func (c Collector) disks() *DisksSection {
	s := &DisksSection{}
	for _, name := range c.list("/sys/block") {
		base := "/sys/block/" + name
		// Physical disks only: a device link, and not a loop, RAM, zram or device-mapper node.
		if !c.exists(base+"/device") || strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") ||
			strings.HasPrefix(name, "zram") || strings.HasPrefix(name, "dm-") || strings.HasPrefix(name, "sr") {
			continue
		}
		sectors, _ := c.uint(base + "/size")
		d := &Disk{
			Name:       name,
			Model:      c.read(base + "/device/model"),
			Serial:     c.diskSerial(base),
			Wwn:        c.wwn(base),
			SizeBytes:  sectors * 512,
			Rotational: c.read(base+"/queue/rotational") == "1",
			Removable:  c.read(base+"/removable") == "1",
			Transport:  c.transport(name, base),
		}
		s.Disks = append(s.Disks, d)
	}
	if len(s.Disks) == 0 {
		return nil
	}
	return s
}

// diskSerial: NVMe controllers expose `serial`; SCSI, SAS and SATA disks (behind libata) do not, but
// the kernel caches their Unit Serial Number VPD page (0x80) as device/vpd_pg80: a 4-byte header
// (peripheral byte, page code 0x80, big-endian length), then the serial, space padded.
func (c Collector) diskSerial(base string) string {
	if s := c.read(base + "/device/serial"); s != "" {
		return s
	}
	b, err := os.ReadFile(c.p(base + "/device/vpd_pg80"))
	if err != nil || len(b) < 4 || b[1] != 0x80 {
		return ""
	}
	n := int(b[2])<<8 | int(b[3])
	if n > len(b)-4 {
		n = len(b) - 4
	}
	return strings.TrimSpace(strings.Trim(string(b[4:4+n]), "\x00"))
}

func (c Collector) wwn(base string) string {
	for _, f := range []string{"/wwid", "/device/wwid", "/device/wwn"} {
		if v := c.read(base + f); v != "" {
			return v
		}
	}
	return ""
}

func (c Collector) transport(name, base string) DiskTransport {
	switch {
	case strings.HasPrefix(name, "nvme"):
		return DiskTransport_DISK_TRANSPORT_NVME
	case strings.HasPrefix(name, "vd"):
		return DiskTransport_DISK_TRANSPORT_VIRTIO
	}
	target := c.linkPath(base)
	switch {
	case strings.Contains(target, "/usb"):
		return DiskTransport_DISK_TRANSPORT_USB
	case strings.Contains(target, "/ata"):
		return DiskTransport_DISK_TRANSPORT_SATA
	case strings.Contains(target, "/virtio"):
		return DiskTransport_DISK_TRANSPORT_VIRTIO
	case strings.Contains(target, "/end_device-") || strings.Contains(target, "/expander-") || strings.Contains(target, "/port-"):
		// A SAS topology (the SAS transport class names its nodes so). A bare SCSI host is not
		// enough: Hyper-V's storvsc, iSCSI and a RAID controller's virtual drives sit under one too.
		return DiskTransport_DISK_TRANSPORT_SAS
	}
	return DiskTransport_DISK_TRANSPORT_UNSPECIFIED
}

// ---- nics --------------------------------------------------------------------------------------

func (c Collector) nics() *NicsSection {
	s := &NicsSection{}
	for _, name := range c.list("/sys/class/net") {
		base := "/sys/class/net/" + name
		// Physical NICs only: backed by a device, not a virtual interface.
		if !c.exists(base+"/device") || strings.Contains(c.linkPath(base), "/virtual/") {
			continue
		}
		// SR-IOV virtual functions come and go with the VFs bcd hands to VMs: they are not the
		// machine's NICs (they would move the inventory hash on every VM start).
		if c.exists(base + "/device/physfn") {
			continue
		}
		driver := c.link(base + "/device/driver")
		// A BMC's Redfish host interface (iDRAC, iLO, XCC, Supermicro) is a USB CDC-Ethernet device on
		// the host: the BMC's, not the node's, and its MAC must not take part in the node's identity.
		if (driver == "cdc_ether" || driver == "rndis_host") && strings.Contains(c.linkPath(base), "/usb") {
			continue
		}
		pci := c.link(base + "/device")
		if !pciAddress.MatchString(pci) {
			pci = "" // a VMBus or platform device has no PCI address
		}
		n := &Nic{
			Name:       name,
			Mac:        strings.ToLower(c.read(base + "/address")),
			Driver:     driver,
			PciAddress: pci,
			Rdma:       RdmaType_RDMA_TYPE_NONE,
			Link:       LinkState_LINK_STATE_DOWN,
		}
		// A MAC assigned at runtime is not the permanent one; the bonding slave file keeps it.
		if perm := c.read(base + "/bonding_slave/perm_hwaddr"); perm != "" {
			n.Mac = strings.ToLower(perm)
		}
		if speed, err := strconv.Atoi(c.read(base + "/speed")); err == nil && speed > 0 {
			n.SpeedMbps = uint32(speed)
		}
		if numa, err := strconv.Atoi(c.read(base + "/device/numa_node")); err == nil && numa >= 0 {
			v := uint32(numa)
			n.NumaNode = &v
		}
		if vfs, ok := c.uint(base + "/device/sriov_totalvfs"); ok {
			n.SriovTotalVfs = uint32(vfs)
		}
		if c.exists(base + "/device/infiniband") {
			n.Rdma = RdmaType_RDMA_TYPE_ROCE
			if c.read(base+"/type") == "32" {
				n.Rdma = RdmaType_RDMA_TYPE_INFINIBAND
			}
		}
		if c.read(base+"/operstate") == "up" {
			n.Link = LinkState_LINK_STATE_UP
		}
		if mtu, ok := c.uint(base + "/mtu"); ok {
			n.Mtu = uint32(mtu)
		}
		s.Nics = append(s.Nics, n)
	}
	if len(s.Nics) == 0 {
		return nil
	}
	return s
}

var pciAddress = regexp.MustCompile(`^[0-9a-f]{4,8}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$`)

// ---- gpus --------------------------------------------------------------------------------------

func (c Collector) gpus() *GpusSection {
	buses := c.list("/proc/driver/nvidia/gpus")
	s := &GpusSection{}
	if len(buses) > 0 {
		s.DriverVersion = nvidiaDriverVersion(c.read("/proc/driver/nvidia/version"))
	}
	for _, bus := range buses {
		info := map[string]string{}
		for _, line := range strings.Split(c.read("/proc/driver/nvidia/gpus/"+bus+"/information"), "\n") {
			if k, v, ok := strings.Cut(line, ":"); ok {
				info[strings.TrimSpace(k)] = strings.TrimSpace(v)
			}
		}
		uuid := info["GPU UUID"]
		if uuid == "" {
			continue
		}
		g := &Gpu{
			Uuid:         uuid,
			Name:         info["Model"],
			VbiosVersion: info["Video BIOS"],
			PciBusId:     pciBusID(bus),
			Architecture: architecture(info["Model"]),
		}
		if numa, err := strconv.Atoi(c.read("/sys/bus/pci/devices/" + strings.ToLower(bus) + "/numa_node")); err == nil && numa >= 0 {
			v := uint32(numa)
			g.NumaNode = &v
		}
		s.Gpus = append(s.Gpus, g)
	}
	// Index in bus order, as nvidia-smi enumerates them by default (CUDA_DEVICE_ORDER=PCI_BUS_ID).
	sort.Slice(s.Gpus, func(i, j int) bool { return s.Gpus[i].PciBusId < s.Gpus[j].PciBusId })
	// GPUs passed through to VMs come after: nvidia-smi does not enumerate them, so the driver-bound
	// GPUs keep the indices nvidia-smi gives them.
	have := map[string]bool{}
	for _, g := range s.Gpus {
		have[normalizeBus(g.PciBusId)] = true
	}
	s.Gpus = append(s.Gpus, c.passedThroughGPUs(have)...)
	for i, g := range s.Gpus {
		g.Index = uint32(i)
	}
	if len(s.Gpus) == 0 {
		return nil
	}
	return s
}

// nvidiaDriverVersion reads "NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.65.06  ...".
func nvidiaDriverVersion(text string) string {
	for _, line := range strings.Split(text, "\n") {
		if i := strings.Index(line, "Kernel Module"); i >= 0 {
			if fields := strings.Fields(line[i+len("Kernel Module"):]); len(fields) > 0 {
				return fields[0]
			}
		}
	}
	return ""
}

// pciBusID widens "0000:18:00.0" to NVML's "00000000:18:00.0".
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

// architecture guesses the generation from the marketing name (NVML reports it exactly).
func architecture(model string) string {
	m := strings.ToUpper(model)
	switch {
	case strings.Contains(m, "B200"), strings.Contains(m, "B100"), strings.Contains(m, "GB200"), strings.Contains(m, "RTX PRO 6000"):
		return "blackwell"
	case strings.Contains(m, "H100"), strings.Contains(m, "H200"), strings.Contains(m, "H800"), strings.Contains(m, "GH200"):
		return "hopper"
	case strings.Contains(m, "L40"), strings.Contains(m, "L4"), strings.Contains(m, "RTX 40"), strings.Contains(m, "RTX 6000 ADA"):
		return "ada"
	case strings.Contains(m, "A100"), strings.Contains(m, "A800"), strings.Contains(m, "A10"), strings.Contains(m, "A30"), strings.Contains(m, "A40"):
		return "ampere"
	}
	return ""
}

// ---- os ----------------------------------------------------------------------------------------

func (c Collector) os() *OsSection {
	s := &OsSection{Kernel: c.read("/proc/sys/kernel/osrelease"), Cgroup: CgroupVersion_CGROUP_VERSION_V1}
	for _, line := range strings.Split(c.read("/etc/os-release"), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"'`)
		switch k {
		case "ID":
			s.Distro = v
		case "VERSION_ID":
			s.DistroVersion = v
		}
	}
	if c.exists("/sys/fs/cgroup/cgroup.controllers") {
		s.Cgroup = CgroupVersion_CGROUP_VERSION_V2
	}
	s.Kvm = c.exists("/dev/kvm")
	s.Iommu = len(c.list("/sys/class/iommu")) > 0
	runtimes := map[string][]string{
		"containerd": {"/run/containerd/containerd.sock", "/usr/bin/containerd"},
		"docker":     {"/run/docker.sock", "/usr/bin/dockerd"},
		"libvirt":    {"/run/libvirt/libvirt-sock", "/usr/sbin/libvirtd"},
		"podman":     {"/usr/bin/podman"},
	}
	for name, paths := range runtimes {
		for _, p := range paths {
			if c.exists(p) {
				s.Runtimes = append(s.Runtimes, name)
				break
			}
		}
	}
	sort.Strings(s.Runtimes)
	if c.Hostname != nil {
		s.Hostname = c.Hostname()
	} else if c.Root == "" {
		s.Hostname, _ = os.Hostname()
	} else {
		s.Hostname = c.read("/proc/sys/kernel/hostname")
	}
	return s
}
