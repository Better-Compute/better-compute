package inventory

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPassedThroughGPUsStayInTheInventory(t *testing.T) {
	root := fakeRoot(t)
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
	toVFIO := func(addr, class string) {
		t.Helper()
		write("/sys/bus/pci/devices/"+addr+"/vendor", "0x10de\n")
		write("/sys/bus/pci/devices/"+addr+"/class", class+"\n")
		if err := os.MkdirAll(filepath.Join(root, "sys/bus/pci/drivers/vfio-pci"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("../../drivers/vfio-pci", filepath.Join(root, "sys/bus/pci/devices", addr, "driver")); err != nil {
			t.Fatal(err)
		}
		if err := os.RemoveAll(filepath.Join(root, "proc/driver/nvidia/gpus", addr)); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(t.TempDir(), "gpus-seen.json")

	// While the NVIDIA driver has both GPUs, the (NVML-enriched) inventory is remembered.
	inv, err := Collector{Root: root}.Collect()
	if err != nil || inv.Gpus == nil || len(inv.Gpus.Gpus) != 2 {
		t.Fatalf("collect = %+v, %v", inv, err)
	}
	for _, g := range inv.Gpus.Gpus {
		g.VramBytes = 80 << 30
		g.CudaComputeCapabilityMajor = 9
	}
	if err := (&GPUMemory{Path: file}).Remember(inv.Gpus); err != nil {
		t.Fatal(err)
	}

	// GPU 0000:18:00.0 goes to a VM, with its audio function; an NVIDIA GPU never seen under the
	// driver is on vfio-pci too.
	toVFIO("0000:18:00.0", "0x030200")
	toVFIO("0000:18:00.1", "0x040300")
	toVFIO("0000:3b:00.0", "0x030200")

	// Without the memory the GPU drops out, as it did before.
	if inv, _ := (Collector{Root: root}).Collect(); len(inv.Gpus.Gpus) != 1 {
		t.Fatalf("without memory: %+v", inv.Gpus.Gpus)
	}
	mem := &GPUMemory{Path: file} // a restarted node reads the file
	inv, err = Collector{Root: root, PassedThrough: mem.Lookup}.Collect()
	if err != nil || inv.Gpus == nil || len(inv.Gpus.Gpus) != 2 {
		t.Fatalf("with memory = %+v, %v", inv.Gpus, err)
	}
	// The passed-through GPU sorts after the driver's despite its lower address: nvidia-smi's indices
	// for the driver's GPUs hold.
	if g := inv.Gpus.Gpus[0]; g.Uuid != "GPU-aaaa" || g.Index != 0 {
		t.Fatalf("driver GPU = %+v", g)
	}
	g := inv.Gpus.Gpus[1]
	if g.Uuid != "GPU-bbbb" || g.Index != 1 || g.PciBusId != "00000000:18:00.0" || g.Name != "NVIDIA H100 80GB HBM3" ||
		g.Architecture != "hopper" || g.VramBytes != 80<<30 || g.CudaComputeCapabilityMajor != 9 || g.NumaNode == nil || *g.NumaNode != 1 {
		t.Fatalf("passed-through GPU = %+v", g)
	}
	if inv.Gpus.DriverVersion != "580.65.06" {
		t.Fatalf("driver version = %q", inv.Gpus.DriverVersion)
	}

	// Both passed through: bus order, no driver version.
	toVFIO("0000:2a:00.0", "0x030200")
	inv, _ = Collector{Root: root, PassedThrough: mem.Lookup}.Collect()
	if inv.Gpus == nil || len(inv.Gpus.Gpus) != 2 || inv.Gpus.Gpus[0].Uuid != "GPU-bbbb" || inv.Gpus.Gpus[1].Uuid != "GPU-aaaa" ||
		inv.Gpus.DriverVersion != "" {
		t.Fatalf("all passed through = %+v", inv.Gpus)
	}
}

func TestGPUMemory(t *testing.T) {
	file := filepath.Join(t.TempDir(), "gpus-seen.json")
	m := &GPUMemory{Path: file}
	if m.Lookup("0000:18:00.0") != nil {
		t.Fatal("empty memory found a GPU")
	}
	if err := m.Remember(&GpusSection{Gpus: []*Gpu{{Uuid: "GPU-1", PciBusId: "00000000:18:00.0", Name: "A"}, {Uuid: "", PciBusId: "00000000:19:00.0"}}}); err != nil {
		t.Fatal(err)
	}
	// A later collection without GPU-1 keeps it; a new GPU at its address replaces it.
	if err := m.Remember(&GpusSection{Gpus: []*Gpu{{Uuid: "GPU-2", PciBusId: "00000000:1A:00.0"}}}); err != nil {
		t.Fatal(err)
	}
	m = &GPUMemory{Path: file}
	if g := m.Lookup("0000:18:00.0"); g == nil || g.Uuid != "GPU-1" || g.Name != "A" {
		t.Fatalf("lookup = %+v", g)
	}
	if m.Lookup("0000:19:00.0") != nil || m.Lookup("0000:1a:00.0") == nil {
		t.Fatal("UUID-less GPU remembered, or GPU-2 forgotten")
	}
	if err := m.Remember(&GpusSection{Gpus: []*Gpu{{Uuid: "GPU-3", PciBusId: "0000:18:00.0"}}}); err != nil {
		t.Fatal(err)
	}
	if g := (&GPUMemory{Path: file}).Lookup("00000000:18:00.0"); g == nil || g.Uuid != "GPU-3" {
		t.Fatalf("replaced = %+v", g)
	}
	// A corrupt file is an empty memory, and the next Remember rewrites it.
	if err := os.WriteFile(file, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if (&GPUMemory{Path: file}).Lookup("0000:18:00.0") != nil {
		t.Fatal("corrupt memory found a GPU")
	}
	var nilMem *GPUMemory
	if nilMem.Lookup("x") != nil || nilMem.Remember(&GpusSection{}) != nil {
		t.Fatal("nil memory")
	}
}

func TestNormalizeBus(t *testing.T) {
	for in, want := range map[string]string{
		"00000000:18:00.0": "0000:18:00.0", "0000:2A:00.0": "0000:2a:00.0", "0001:18:00.0": "0001:18:00.0",
		"00010000:18:00.0": "10000:18:00.0", "nonsense": "nonsense",
	} {
		if got := normalizeBus(in); got != want {
			t.Errorf("normalizeBus(%q) = %q, want %q", in, got, want)
		}
	}
}
