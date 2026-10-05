package inventory

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
)

// Real machines (testdata/hosts/*.tar.gz, captured with `bcd hardware --capture <file>.tar.gz
// --redact`) and hand-built trees for server variants not captured yet. Each asserts what the
// control plane must get right about that machine.

func replay(t *testing.T, fixture string) *NodeInventory {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fixtures hold sysfs symlinks; replay needs a POSIX filesystem")
	}
	dir := t.TempDir()
	if err := ExtractFixture(filepath.Join("testdata", "hosts", fixture), dir); err != nil {
		t.Fatal(err)
	}
	inv, err := Collector{Root: dir, Hostname: func() string { return "replayed" }, Now: fixedNow}.Collect()
	if err != nil {
		t.Fatal(err)
	}
	return inv
}

// WSL2 on a Threadripper PRO 9995WX (captured 2026-10-04): Hyper-V synthetic devices throughout.
func TestHostWSL2Threadripper(t *testing.T) {
	inv := replay(t, "wsl2-threadripper-9995wx.tar.gz")
	if inv.System != nil {
		t.Fatalf("WSL has no SMBIOS: %+v", inv.System)
	}
	c := inv.Cpu
	if c.Vendor != "AuthenticAMD" || c.Sockets != 1 || c.Cores != 96 || c.Threads != 192 || len(c.NumaNodes) != 1 || c.NumaNodes[0].Cpus != "0-191" {
		t.Fatalf("cpu = %+v", c)
	}
	if inv.Memory == nil || inv.Memory.TotalBytes < 120<<30 {
		t.Fatalf("memory = %+v", inv.Memory)
	}
	if inv.Disks == nil || len(inv.Disks.Disks) != 4 {
		t.Fatalf("disks = %+v", inv.Disks)
	}
	for _, d := range inv.Disks.Disks {
		// storvsc virtual disks: a SCSI host but no SAS topology.
		if d.Transport != DiskTransport_DISK_TRANSPORT_UNSPECIFIED || d.Model != "Virtual Disk" || d.Wwn == "" {
			t.Fatalf("disk = %+v", d)
		}
	}
	if inv.Nics == nil || len(inv.Nics.Nics) != 1 {
		t.Fatalf("nics = %+v", inv.Nics)
	}
	if nic := inv.Nics.Nics[0]; nic.Driver != "hv_netvsc" || nic.PciAddress != "" || nic.Mac == "" || nic.SpeedMbps != 10000 {
		t.Fatalf("nic = %+v", nic)
	}
	if o := inv.Os; o.Cgroup != CgroupVersion_CGROUP_VERSION_V2 || !o.Kvm || o.Distro != "ubuntu" {
		t.Fatalf("os = %+v", o)
	}
	findings := map[string]string{}
	for _, f := range HostFindings(inv, false) {
		findings[f.Check] = f.Status
	}
	if findings["dmi"] != "warn" || findings["cgroup"] != "ok" || findings["kvm"] != "ok" || findings["nics"] != "ok" {
		t.Fatalf("findings = %v", findings)
	}
}

// tree builds a sysfs/procfs tree from files and symlinks.
type tree struct {
	t    *testing.T
	root string
}

func newTree(t *testing.T) *tree {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks in the fake sysfs need a POSIX filesystem")
	}
	return &tree{t: t, root: t.TempDir()}
}

func (tr *tree) file(p, content string) {
	tr.t.Helper()
	full := filepath.Join(tr.root, filepath.FromSlash(p))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		tr.t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		tr.t.Fatal(err)
	}
}

func (tr *tree) link(p, target string) {
	tr.t.Helper()
	full := filepath.Join(tr.root, filepath.FromSlash(p))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		tr.t.Fatal(err)
	}
	if err := os.Symlink(target, full); err != nil {
		tr.t.Fatal(err)
	}
}

func (tr *tree) dir(p string) {
	tr.t.Helper()
	if err := os.MkdirAll(filepath.Join(tr.root, filepath.FromSlash(p)), 0o755); err != nil {
		tr.t.Fatal(err)
	}
}

// An NVIDIA Grace (GH200) node: arm64 cpuinfo has no model name, physical id or core id.
func TestHostGraceArm64(t *testing.T) {
	tr := newTree(t)
	cpuinfo := ""
	for i := 0; i < 72; i++ {
		cpuinfo += "processor\t: " + strconv.Itoa(i) + "\nBogoMIPS\t: 2000.00\nFeatures\t: fp asimd sve2 bf16\n" +
			"CPU implementer\t: 0x41\nCPU architecture: 8\nCPU variant\t: 0x0\nCPU part\t: 0xd4f\nCPU revision\t: 0\n\n"
		tr.file("/sys/devices/system/cpu/cpu"+strconv.Itoa(i)+"/topology/physical_package_id", "0\n")
		tr.file("/sys/devices/system/cpu/cpu"+strconv.Itoa(i)+"/topology/core_id", strconv.Itoa(i)+"\n")
	}
	tr.file("/sys/devices/system/cpu/online", "0-71\n")
	tr.file("/proc/cpuinfo", cpuinfo)
	tr.file("/proc/meminfo", "MemTotal:       503316480 kB\n")
	inv, err := Collector{Root: tr.root, Hostname: func() string { return "gh200" }}.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if c := inv.Cpu; c.Vendor != "ARM" || c.Model != "Neoverse-V2" || c.Sockets != 1 || c.Cores != 72 || c.Threads != 72 {
		t.Fatalf("cpu = %+v", c)
	}
}

// A dual-socket x86 server with the parts that trip collectors: a SATA SSD whose serial is only in
// its VPD page, a SAS disk behind an expander, a VF of its NIC, and the BMC's USB host interface.
func TestHostX86ServerEdgeCases(t *testing.T) {
	tr := newTree(t)
	tr.file("/proc/cpuinfo", "processor\t: 0\nvendor_id\t: GenuineIntel\nmodel name\t: Intel Xeon\nphysical id\t: 0\ncore id\t: 0\n\n")
	tr.file("/proc/meminfo", "MemTotal:       1048576 kB\n")

	// SATA via libata: no device/serial, the serial in vpd_pg80.
	sata := "/sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sda"
	tr.dir(sata)
	tr.link("/sys/block/sda", "../devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sda")
	tr.link(sata+"/device", "../../../0:0:0:0")
	tr.file("/sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/model", "SAMSUNG MZ7L3480\n")
	vpd := append([]byte{0x00, 0x80, 0x00, 0x14}, []byte("      S664NE0R123456")...)
	tr.file("/sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/vpd_pg80", string(vpd))
	tr.file(sata+"/size", "937703088\n")

	// SAS behind an expander.
	sas := "/sys/devices/pci0000:80/0000:80:01.0/host2/port-2:0/expander-2:0/port-2:0:3/end_device-2:0:3/target2:0:3/2:0:3:0/block/sdb"
	tr.dir(sas)
	tr.link("/sys/block/sdb", "../devices/pci0000:80/0000:80:01.0/host2/port-2:0/expander-2:0/port-2:0:3/end_device-2:0:3/target2:0:3/2:0:3:0/block/sdb")
	tr.link(sas+"/device", "../../../2:0:3:0")
	tr.file("/sys/devices/pci0000:80/0000:80:01.0/host2/port-2:0/expander-2:0/port-2:0:3/end_device-2:0:3/target2:0:3/2:0:3:0/vpd_pg80", string(append([]byte{0x00, 0x80, 0x00, 0x08}, []byte("ZA1B2C3D")...)))

	// The physical function and one of its VFs.
	pf := "/sys/devices/pci0000:00/0000:3b:00.0"
	tr.dir(pf + "/net/ens1f0")
	tr.link("/sys/class/net/ens1f0", "../../devices/pci0000:00/0000:3b:00.0/net/ens1f0")
	tr.link(pf+"/net/ens1f0/device", "../../../0000:3b:00.0")
	tr.file(pf+"/net/ens1f0/address", "b8:3f:d2:aa:00:01\n")
	tr.link(pf+"/driver", "../../../bus/pci/drivers/ice")
	vf := "/sys/devices/pci0000:00/0000:3b:01.0"
	tr.dir(vf + "/net/ens1f0v0")
	tr.link("/sys/class/net/ens1f0v0", "../../devices/pci0000:00/0000:3b:01.0/net/ens1f0v0")
	tr.link(vf+"/net/ens1f0v0/device", "../../../0000:3b:01.0")
	tr.link(vf+"/physfn", "../0000:3b:00.0")
	tr.file(vf+"/net/ens1f0v0/address", "02:00:00:00:00:99\n")

	// The BMC's Redfish host interface over USB.
	usb := "/sys/devices/pci0000:00/0000:00:14.0/usb1/1-3/1-3:1.0"
	tr.dir(usb + "/net/enp0s20f0u3")
	tr.link("/sys/class/net/enp0s20f0u3", "../../devices/pci0000:00/0000:00:14.0/usb1/1-3/1-3:1.0/net/enp0s20f0u3")
	tr.link(usb+"/net/enp0s20f0u3/device", "../../../1-3:1.0")
	tr.link(usb+"/driver", "../../../../../../bus/usb/drivers/cdc_ether")
	tr.file(usb+"/net/enp0s20f0u3/address", "16:4e:aa:bb:cc:dd\n")

	inv, err := Collector{Root: tr.root, Hostname: func() string { return "x86" }}.Collect()
	if err != nil {
		t.Fatal(err)
	}
	disks := map[string]*Disk{}
	for _, d := range inv.Disks.Disks {
		disks[d.Name] = d
	}
	if d := disks["sda"]; d == nil || d.Transport != DiskTransport_DISK_TRANSPORT_SATA || d.Serial != "S664NE0R123456" || d.Model != "SAMSUNG MZ7L3480" {
		t.Fatalf("sata = %+v", d)
	}
	if d := disks["sdb"]; d == nil || d.Transport != DiskTransport_DISK_TRANSPORT_SAS || d.Serial != "ZA1B2C3D" {
		t.Fatalf("sas = %+v", d)
	}
	if n := inv.Nics; n == nil || len(n.Nics) != 1 || n.Nics[0].Name != "ens1f0" || n.Nics[0].Driver != "ice" || n.Nics[0].PciAddress != "0000:3b:00.0" {
		t.Fatalf("nics = %+v (only the PF: no VF, no BMC host interface)", n)
	}
}

// Unprivileged, the root-only DMI files read empty; the DMI hook (bcd helper) fills them, once.
func TestDMIHookFillsRootOnlyFiles(t *testing.T) {
	tr := newTree(t)
	tr.file("/sys/class/dmi/id/sys_vendor", "Dell Inc.\n")
	tr.file("/sys/class/dmi/id/product_name", "PowerEdge XE9680\n")
	calls := 0
	hook := func() map[string]string {
		calls++
		return map[string]string{"product_uuid": "4C4C4544-0051-3010-8044-B4C04F4E3433", "product_serial": "7Q4D3S3", "board_serial": " .7Q4D3S3.CNFCP0042Q00HV. "}
	}
	inv, err := Collector{Root: tr.root, Hostname: func() string { return "h" }, DMI: hook}.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if s := inv.System; s.ProductUuid != "4c4c4544-0051-3010-8044-b4c04f4e3433" || s.Serial != "7Q4D3S3" || s.BoardSerial != ".7Q4D3S3.CNFCP0042Q00HV." || s.Vendor != "Dell Inc." {
		t.Fatalf("system = %+v", s)
	}
	if calls != 1 {
		t.Fatalf("the hook ran %d times", calls)
	}
	// No SMBIOS at all (WSL, containers): nothing to ask root for.
	empty := newTree(t)
	empty.file("/proc/meminfo", "MemTotal: 1024 kB\n")
	if _, err := (Collector{Root: empty.root, Hostname: func() string { return "h" }, DMI: hook}).Collect(); err != nil || calls != 1 {
		t.Fatalf("asked without DMI: calls=%d err=%v", calls, err)
	}
}

// A fixture archive refuses entries that would leave its tree.
func TestExtractFixtureStaysInside(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symlinks")
	}
	src := t.TempDir()
	if err := os.MkdirAll(filepath.Join(src, "sys"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/shadow", filepath.Join(src, "sys", "evil")); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "x.tar.gz")
	if err := WriteFixture(src, archive); err != nil {
		t.Fatal(err)
	}
	if err := ExtractFixture(archive, t.TempDir()); err == nil {
		t.Fatal("an absolute link target was extracted")
	}
}
