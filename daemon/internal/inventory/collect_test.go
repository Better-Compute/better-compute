package inventory

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// fakeRoot builds a small procfs/sysfs tree: two sockets of two cores (HT), one NUMA node, an NVMe
// disk, a loop device, one physical NIC and one virtual, and two NVIDIA GPUs.
func fakeRoot(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("symlinks in the fake sysfs need a POSIX filesystem")
	}
	root := t.TempDir()
	write := func(p, content string) {
		t.Helper()
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	link := func(p, target string) {
		t.Helper()
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, full); err != nil {
			t.Fatal(err)
		}
	}
	mkdir := func(p string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(p)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for k, v := range map[string]string{
		"sys_vendor": "Supermicro", "product_name": "SYS-821GE-TNHR", "product_serial": "S123",
		"product_uuid": "4C4C4544-0000-1000-8000-ABCDEF012345", "board_vendor": "Supermicro",
		"board_name": "X13DEG-OAD", "board_serial": "B456", "chassis_serial": "C789",
		"bios_vendor": "American Megatrends", "bios_version": "2.1",
	} {
		write("/sys/class/dmi/id/"+k, v+"\n")
	}
	mkdir("/sys/firmware/efi")
	write("/sys/firmware/efi/efivars/SecureBoot-"+efiGlobal, "\x06\x00\x00\x00\x01")
	write("/sys/class/tpm/tpm0/tpm_version_major", "2\n")

	cpuinfo := ""
	for i, ids := range [][2]string{{"0", "0"}, {"0", "1"}, {"1", "0"}, {"1", "1"}, {"0", "0"}, {"0", "1"}, {"1", "0"}, {"1", "1"}} {
		cpuinfo += "processor\t: " + string(rune('0'+i)) + "\nvendor_id\t: GenuineIntel\nmodel name\t: Intel(R) Xeon(R) Platinum 8480+\n" +
			"physical id\t: " + ids[0] + "\ncore id\t\t: " + ids[1] + "\nflags\t\t: fpu avx512f amx_tile\n\n"
	}
	write("/proc/cpuinfo", cpuinfo)
	write("/sys/devices/system/node/node0/cpulist", "0-7\n")
	write("/sys/devices/system/node/node0/meminfo", "Node 0 MemTotal:       1048576 kB\nNode 0 MemFree: 1 kB\n")
	write("/proc/meminfo", "MemTotal:        2097152 kB\nMemFree: 10 kB\n")
	write("/sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages", "16\n")
	write("/sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages", "0\n")
	write("/sys/devices/system/edac/mc/mc0/ce_count", "3\n")
	write("/sys/devices/system/edac/mc/mc0/ue_count", "0\n")

	mkdir("/sys/devices/pci0000:00/0000:00:01.0/nvme/nvme0/nvme0n1")
	link("/sys/block/nvme0n1", "../devices/pci0000:00/0000:00:01.0/nvme/nvme0/nvme0n1")
	write("/sys/devices/pci0000:00/0000:00:01.0/nvme/nvme0/nvme0n1/size", "7814037168\n")
	write("/sys/devices/pci0000:00/0000:00:01.0/nvme/nvme0/nvme0n1/wwid", "eui.0025388b91c3a1b2\n")
	write("/sys/devices/pci0000:00/0000:00:01.0/nvme/nvme0/nvme0n1/queue/rotational", "0\n")
	write("/sys/devices/pci0000:00/0000:00:01.0/nvme/nvme0/nvme0n1/removable", "0\n")
	write("/sys/devices/pci0000:00/0000:00:01.0/nvme/nvme0/nvme0n1/device/model", "SAMSUNG MZQL23T8HCLS\n")
	write("/sys/devices/pci0000:00/0000:00:01.0/nvme/nvme0/nvme0n1/device/serial", "S64HNE0T\n")
	mkdir("/sys/devices/virtual/block/loop0")
	link("/sys/block/loop0", "../devices/virtual/block/loop0")

	mkdir("/sys/devices/pci0000:00/0000:17:00.0/net/eth0")
	link("/sys/class/net/eth0", "../../devices/pci0000:00/0000:17:00.0/net/eth0")
	link("/sys/devices/pci0000:00/0000:17:00.0/net/eth0/device", "../../../0000:17:00.0")
	mkdir("/sys/bus/pci/drivers/mlx5_core")
	link("/sys/devices/pci0000:00/0000:17:00.0/driver", "../../../bus/pci/drivers/mlx5_core")
	for k, v := range map[string]string{"address": "B8:3F:D2:00:00:01", "speed": "100000", "operstate": "up", "mtu": "9000", "type": "1"} {
		write("/sys/devices/pci0000:00/0000:17:00.0/net/eth0/"+k, v+"\n")
	}
	write("/sys/devices/pci0000:00/0000:17:00.0/numa_node", "0\n")
	write("/sys/devices/pci0000:00/0000:17:00.0/sriov_totalvfs", "8\n")
	mkdir("/sys/devices/pci0000:00/0000:17:00.0/infiniband/mlx5_0")
	mkdir("/sys/devices/virtual/net/docker0")
	link("/sys/class/net/docker0", "../../devices/virtual/net/docker0")

	write("/proc/driver/nvidia/version", "NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.65.06  Sun Jul 27 2025\n")
	for bus, uuid := range map[string]string{"0000:18:00.0": "GPU-bbbb", "0000:2a:00.0": "GPU-aaaa"} {
		write("/proc/driver/nvidia/gpus/"+bus+"/information",
			"Model: \t\t NVIDIA H100 80GB HBM3\nIRQ:   \t\t 10\nGPU UUID: \t "+uuid+"\nVideo BIOS: \t 96.00.99.00.01\nBus Location: \t "+bus+"\n")
		write("/sys/bus/pci/devices/"+bus+"/numa_node", "1\n")
	}

	write("/etc/os-release", "NAME=\"Ubuntu\"\nID=ubuntu\nVERSION_ID=\"24.04\"\n")
	write("/proc/sys/kernel/osrelease", "6.8.0-45-generic\n")
	write("/proc/sys/kernel/hostname", "gpu-01\n")
	write("/sys/fs/cgroup/cgroup.controllers", "cpu memory\n")
	write("/dev/kvm", "")
	mkdir("/sys/class/iommu/dmar0")
	write("/usr/bin/containerd", "")
	return root
}

func TestCollectorReadsProcAndSys(t *testing.T) {
	inv, err := Collector{Root: fakeRoot(t)}.Collect()
	if err != nil {
		t.Fatal(err)
	}
	s := inv.System
	if s == nil || s.Vendor != "Supermicro" || s.ProductUuid != "4c4c4544-0000-1000-8000-abcdef012345" || s.BootMode != BootMode_BOOT_MODE_UEFI ||
		s.SecureBoot == nil || !*s.SecureBoot || s.Tpm == nil || s.Tpm.Version != "2.0" {
		t.Fatalf("system = %+v", s)
	}
	c := inv.Cpu
	if c == nil || c.Sockets != 2 || c.Cores != 4 || c.Threads != 8 || c.Vendor != "GenuineIntel" || len(c.Flags) != 3 ||
		len(c.NumaNodes) != 1 || c.NumaNodes[0].Cpus != "0-7" || c.NumaNodes[0].MemoryBytes != 1<<30 {
		t.Fatalf("cpu = %+v", c)
	}
	m := inv.Memory
	if m == nil || m.TotalBytes != 2<<30 || len(m.Hugepages) != 2 || m.Hugepages[0].PageSizeBytes != 2<<20 || m.Hugepages[0].Total != 16 ||
		m.Edac == nil || m.Edac.Correctable != 3 {
		t.Fatalf("memory = %+v", m)
	}
	if d := inv.Disks; d == nil || len(d.Disks) != 1 || d.Disks[0].Name != "nvme0n1" || d.Disks[0].Transport != DiskTransport_DISK_TRANSPORT_NVME ||
		d.Disks[0].SizeBytes != 7814037168*512 || d.Disks[0].Wwn != "eui.0025388b91c3a1b2" || d.Disks[0].Serial != "S64HNE0T" {
		t.Fatalf("disks = %+v", d)
	}
	n := inv.Nics
	if n == nil || len(n.Nics) != 1 {
		t.Fatalf("nics = %+v", n)
	}
	if nic := n.Nics[0]; nic.Mac != "b8:3f:d2:00:00:01" || nic.Driver != "mlx5_core" || nic.PciAddress != "0000:17:00.0" ||
		nic.SpeedMbps != 100000 || nic.Rdma != RdmaType_RDMA_TYPE_ROCE || nic.Link != LinkState_LINK_STATE_UP || nic.SriovTotalVfs != 8 ||
		nic.NumaNode == nil || *nic.NumaNode != 0 || nic.Mtu != 9000 {
		t.Fatalf("nic = %+v", nic)
	}
	g := inv.Gpus
	if g == nil || g.DriverVersion != "580.65.06" || len(g.Gpus) != 2 {
		t.Fatalf("gpus = %+v", g)
	}
	if first := g.Gpus[0]; first.Uuid != "GPU-bbbb" || first.Index != 0 || first.PciBusId != "00000000:18:00.0" ||
		first.Architecture != "hopper" || first.NumaNode == nil || *first.NumaNode != 1 {
		t.Fatalf("gpu 0 = %+v", first)
	}
	o := inv.Os
	if o == nil || o.Distro != "ubuntu" || o.DistroVersion != "24.04" || o.Kernel != "6.8.0-45-generic" || o.Cgroup != CgroupVersion_CGROUP_VERSION_V2 ||
		!o.Kvm || !o.Iommu || len(o.Runtimes) != 1 || o.Runtimes[0] != "containerd" || o.Hostname != "gpu-01" {
		t.Fatalf("os = %+v", o)
	}
	// The result encodes and hashes like any inventory.
	if hashes, err := SectionHashes(inv); err != nil || len(hashes) != 7 {
		t.Fatalf("hashes = %d, %v", len(hashes), err)
	}
}

func TestCollectorOnAnEmptyRoot(t *testing.T) {
	inv, err := Collector{Root: t.TempDir(), Hostname: func() string { return "h" }}.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if inv.System != nil || inv.Cpu != nil || inv.Memory != nil || inv.Disks != nil || inv.Nics != nil || inv.Gpus != nil {
		t.Fatalf("sections without sources: %+v", inv)
	}
	if inv.Os == nil || inv.Os.Hostname != "h" {
		t.Fatalf("os = %+v", inv.Os)
	}
}
