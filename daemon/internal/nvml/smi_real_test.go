package nvml

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// Captured from real hosts: every nvidia-smi query Snapshot makes, as the driver answered it, with
// identifiers anonymized. Some queries also fail the way the driver did, since nvidia-smi exits
// non-zero for "not supported here" (topo on WSL: 3, mig -lgip without MIG: 6).

// realHost replays testdata/<dir>.
func realHost(t *testing.T, dir string) SMI {
	t.Helper()
	files := map[string]string{
		"-q -x": "q.xml",
		"-L":    "L.txt",
		"--query-gpu=uuid,compute_cap --format=csv,noheader": "cc.txt",
		"--query-gpu=driver_version --format=csv,noheader":   "probe.txt",
		"topo -m":   "topo.txt",
		"nvlink -s": "nvlink-s.txt",
		"nvlink -R": "nvlink-R.txt",
		"mig -lgip": "mig-lgip.txt",
	}
	exits := map[string]int{"topo.txt": 3, "mig-lgip.txt": 6}
	return SMI{Run: func(_ context.Context, args ...string) ([]byte, error) {
		name, ok := files[strings.Join(args, " ")]
		if !ok {
			t.Fatalf("unexpected nvidia-smi %q", args)
		}
		out, err := os.ReadFile(filepath.Join("testdata", dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if code := exits[name]; code != 0 && dir == "rtx5090-wsl" {
			return out, errors.New("exit status " + string(rune('0'+code)))
		}
		return out, nil
	}}
}

// An RTX 5090 (Blackwell, GeForce, driver 616.56 / CUDA 13.4) under WSL 2: a paravirtual GPU behind
// /dev/dxg, WDDM driver model, no ECC, no MIG, no NVLink, topo unsupported, serial "0", a Wayland
// compositor on it, and the R616 "Requested functionality has been deprecated" placeholders.
func TestSnapshotRealRTX5090WSL(t *testing.T) {
	snap, err := realHost(t, "rtx5090-wsl").Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	s := snap.Section
	if s.DriverVersion != "616.56" || s.CudaDriverVersion != "13.4" {
		t.Fatalf("versions: %q %q", s.DriverVersion, s.CudaDriverVersion)
	}
	if len(s.Gpus) != 1 {
		t.Fatalf("gpus: %d", len(s.Gpus))
	}
	g := s.Gpus[0]
	want := &inventory.Gpu{
		Uuid:                       "GPU-50905090-0000-4000-8000-509050905090",
		PciBusId:                   "00000000:F1:00.0",
		Name:                       "NVIDIA GeForce RTX 5090",
		Architecture:               "blackwell",
		VramBytes:                  32607 << 20,
		VbiosVersion:               "98.02.2e.80.39",
		PowerLimitMw:               600_000,
		PersistenceMode:            true,
		ComputeMode:                "default",
		CudaComputeCapabilityMajor: 12,
		CudaComputeCapabilityMinor: 0,
	}
	if !reflect.DeepEqual(g, want) {
		t.Fatalf("gpu:\n got %v\nwant %v", g, want)
	}
	if len(snap.Samples) != 1 {
		t.Fatalf("samples: %d", len(snap.Samples))
	}
	sample := snap.Samples[0]
	if sample.MemoryTotal != 32607<<20 || sample.MemoryUsed != 2168<<20 || sample.MemoryReserved != 420<<20 ||
		sample.PowerDrawMw != 82_570 || sample.PowerLimitMw != 600_000 || sample.TemperatureC != 41 ||
		sample.PState != "P3" || sample.SMClockMHz != 1215 || sample.MemClockMHz != 7001 ||
		sample.UtilizationGPU != 5 || sample.Processes != 1 || len(sample.Mig) != 0 {
		t.Fatalf("sample: %+v", sample)
	}
	info, err := realHost(t, "rtx5090-wsl").Probe(context.Background())
	if err != nil || info.DriverVersion != "616.56" || info.DeviceCount != 1 {
		t.Fatalf("probe: %+v %v", info, err)
	}
}
