package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeVFIO struct{ bound, released []string }

func (f *fakeVFIO) Bind(addr string) error    { f.bound = append(f.bound, addr); return nil }
func (f *fakeVFIO) Release(addr string) error { f.released = append(f.released, addr); return nil }

// hostDrivers are the drivers the fake kernel binds when no override says otherwise.
var hostDrivers = map[string]string{"0000:3b:00.0": "nvidia", "0000:3b:00.1": "snd_hda_intel", "0000:3a:00.0": "pcieport"}

// fakeSysfs builds a PCI tree: a GPU and its audio function in IOMMU group 7 on their host drivers,
// plus a bridge in the same group. It returns a SysfsVFIO whose drivers_probe plays the kernel: the
// device moves to its override, or back to its host driver.
func fakeSysfs(t *testing.T) SysfsVFIO {
	t.Helper()
	root := t.TempDir()
	mk := func(p string) string {
		full := filepath.Join(root, p)
		if err := os.MkdirAll(full, 0o755); err != nil {
			t.Fatal(err)
		}
		return full
	}
	link := func(dev, driver string) {
		dir := filepath.Join(root, "/sys/bus/pci/devices/"+dev)
		_ = os.Remove(filepath.Join(dir, "driver"))
		if err := os.Symlink(mk("/sys/bus/pci/drivers/"+driver), filepath.Join(dir, "driver")); err != nil {
			t.Fatal(err)
		}
	}
	group := mk("/sys/kernel/iommu_groups/7/devices")
	for dev, driver := range hostDrivers {
		dir := mk("/sys/bus/pci/devices/" + dev)
		link(dev, driver)
		_ = os.Symlink(filepath.Join(root, "/sys/kernel/iommu_groups/7"), filepath.Join(dir, "iommu_group"))
		_ = os.WriteFile(filepath.Join(group, dev), nil, 0o644)
		class := "0x030000\n"
		if driver == "pcieport" {
			class = "0x060400\n"
		}
		_ = os.WriteFile(filepath.Join(dir, "class"), []byte(class), 0o644)
	}
	v := SysfsVFIO{Root: root}
	v.probed = func(dev string) {
		override, _ := os.ReadFile(filepath.Join(root, "/sys/bus/pci/devices/"+dev+"/driver_override"))
		driver := string(override)
		if driver == "" || driver == "\n" {
			driver = hostDrivers[dev]
		}
		link(dev, driver)
	}
	return v
}

func TestVFIOBindsTheWholeGroupButBridges(t *testing.T) {
	v := fakeSysfs(t)
	if err := v.Bind("0000:3b:00.0"); err != nil {
		t.Fatal(err)
	}
	for _, dev := range []string{"0000:3b:00.0", "0000:3b:00.1"} {
		if got := v.driver(dev); got != "vfio-pci" {
			t.Fatalf("%s on %s, want vfio-pci", dev, got)
		}
	}
	if got := v.driver("0000:3a:00.0"); got != "pcieport" {
		t.Fatalf("the bridge moved to %s", got)
	}
	// Already bound: a no-op.
	if err := v.Bind("0000:3b:00.0"); err != nil {
		t.Fatal(err)
	}
	// Released: back on the host drivers.
	if err := v.Release("0000:3b:00.0"); err != nil {
		t.Fatal(err)
	}
	for dev, want := range map[string]string{"0000:3b:00.0": "nvidia", "0000:3b:00.1": "snd_hda_intel"} {
		if got := v.driver(dev); got != want {
			t.Fatalf("%s back on %s, want %s", dev, got, want)
		}
	}
	if err := v.Bind("not-an-address"); err == nil {
		t.Fatal("a bad address was accepted")
	}
}

// A driver that never lets go (the GPU held open) fails the bind in bounded time.
func TestVFIOUnbindThatBlocksTimesOut(t *testing.T) {
	v := fakeSysfs(t)
	v.blocked, v.UnbindTimeout = make(chan struct{}), 50*time.Millisecond
	defer close(v.blocked)
	start := time.Now()
	err := v.Bind("0000:3b:00.0")
	if err == nil || !strings.Contains(err.Error(), "has not let go") || time.Since(start) > 5*time.Second {
		t.Fatalf("bind = %v after %s", err, time.Since(start))
	}
}

func TestVFIORefusesAGroupThatWillNotMove(t *testing.T) {
	v := fakeSysfs(t)
	// vfio-pci is not loaded: the probe leaves the GPU on its host driver.
	v.probed = func(string) {}
	if err := v.Bind("0000:3b:00.0"); err == nil {
		t.Fatal("a GPU still on nvidia counted as bound")
	}
}

func TestNoMemorySnapshotOfAnInstanceWithGPUs(t *testing.T) {
	c := &CloudHypervisor{Dir: t.TempDir()}
	r := &chRecord{ID: "inst_gpu", Managed: chManaged, GPUs: []string{"GPU-1"}}
	if err := os.MkdirAll(c.instanceDir(r.ID), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := c.save(r); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Snapshot(t.Context(), r.ID, true, "", nil); err != ErrMemorySnapshotWithGPUs {
		t.Fatalf("memory snapshot with a GPU: %v", err)
	}
}
