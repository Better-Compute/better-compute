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
		"--query-gpu=uuid,memory.total,memory.used,memory.reserved,memory.free,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit,clocks.sm,clocks.mem,pstate,mig.mode.current --format=csv,noheader,nounits": "samples.csv",
		"--query-compute-apps=gpu_uuid --format=csv,noheader": "apps.csv",
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
// compositor on it (a graphics process: no workload), and the R616 "Requested functionality has been
// deprecated" placeholders.
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
		sample.UtilizationGPU != 5 || sample.Processes != 0 || len(sample.Mig) != 0 {
		t.Fatalf("sample: %+v", sample)
	}
	info, err := realHost(t, "rtx5090-wsl").Probe(context.Background())
	if err != nil || info.DriverVersion != "616.56" || info.DeviceCount != 1 {
		t.Fatalf("probe: %+v %v", info, err)
	}
}

// Samples: one CSV query and the compute apps, no -q -x.
func TestSamplesRealRTX5090WSL(t *testing.T) {
	smi := realHost(t, "rtx5090-wsl")
	var calls []string
	run := smi.Run
	smi.Run = func(ctx context.Context, args ...string) ([]byte, error) {
		calls = append(calls, strings.Join(args, " "))
		return run(ctx, args...)
	}
	snap, err := smi.Samples(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || snap.Section != nil || len(snap.Samples) != 1 {
		t.Fatalf("calls %v, snapshot %+v", calls, snap)
	}
	s := snap.Samples[0]
	want := Sample{UUID: "GPU-50905090-0000-4000-8000-509050905090", MemoryTotal: 32607 << 20, MemoryUsed: 2189 << 20,
		MemoryReserved: 420 << 20, MemoryFree: 29999 << 20, UtilizationGPU: 0, UtilizationMemory: 1, TemperatureC: 38,
		PowerDrawMw: 99_670, PowerLimitMw: 600_000, SMClockMHz: 2640, MemClockMHz: 14001, PState: "P3"}
	if !reflect.DeepEqual(s, want) {
		t.Fatalf("sample:\n got %+v\nwant %+v", s, want)
	}
}

// A GPU in MIG mode, or a driver refusing a field, gets the full Snapshot instead.
func TestSamplesFallBack(t *testing.T) {
	for name, answer := range map[string]func() ([]byte, error){
		"mig":        func() ([]byte, error) { return []byte("GPU-a, 1, 1, 0, 0, 0, 0, 30, 50.0, 700.0, 1, 1, P0, Enabled\n"), nil },
		"old driver": func() ([]byte, error) { return nil, errors.New(`Field "memory.reserved" is not a valid field to query.`) },
		"columns":    func() ([]byte, error) { return []byte("GPU-a, 1\n"), nil },
	} {
		smi, calls := replay(t, nil)
		inner := smi.Run
		smi.Run = func(ctx context.Context, args ...string) ([]byte, error) {
			if strings.HasPrefix(args[0], "--query-gpu=uuid,memory.total") {
				*calls = append(*calls, strings.Join(args, " "))
				return answer()
			}
			return inner(ctx, args...)
		}
		snap, err := smi.Samples(context.Background())
		if err != nil || snap.Section == nil || len(snap.Samples) != 2 {
			t.Fatalf("%s: %+v %v", name, snap, err)
		}
	}
	if _, err := (SMI{Run: func(context.Context, ...string) ([]byte, error) { return nil, ErrNoDriver }}).Samples(context.Background()); err != ErrNoDriver {
		t.Fatalf("no driver: %v", err)
	}
}