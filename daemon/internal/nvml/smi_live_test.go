package nvml

import (
	"context"
	"os"
	"strings"
	"testing"
)

// TestSnapshotLiveHost reads this host's real GPUs through nvidia-smi. It runs only with
// BCD_REAL_GPU=1 on a host with the NVIDIA driver (e.g. `BCD_REAL_GPU=1 node scripts/daemon-test.mjs
// --run TestSnapshotLiveHost ./internal/nvml/` in WSL with a GPU), and checks what every supported
// GPU must yield: the facts placement and health depend on, read without a parse gap.
func TestSnapshotLiveHost(t *testing.T) {
	if os.Getenv("BCD_REAL_GPU") != "1" {
		t.Skip("set BCD_REAL_GPU=1 on a host with NVIDIA GPUs")
	}
	ctx := context.Background()
	info, err := SMI{}.Probe(ctx)
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	snap, err := SMI{}.Snapshot(ctx)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	s := snap.Section
	t.Logf("driver %s, CUDA %s, %d GPU(s)", s.DriverVersion, s.CudaDriverVersion, len(s.Gpus))
	if len(s.Gpus) == 0 || int(info.DeviceCount) != len(s.Gpus) || info.DriverVersion != s.DriverVersion {
		t.Fatalf("probe %+v disagrees with snapshot (%d GPUs, driver %q)", info, len(s.Gpus), s.DriverVersion)
	}
	if s.CudaDriverVersion == "" {
		t.Errorf("no CUDA driver version")
	}
	for i, g := range s.Gpus {
		t.Logf("GPU %d: %s (%s) %s cc %d.%d, %d MiB, %d mW limit, serial %q, mig %v", i, g.Name, g.Architecture,
			g.PciBusId, g.CudaComputeCapabilityMajor, g.CudaComputeCapabilityMinor, g.VramBytes>>20, g.PowerLimitMw,
			g.Serial, g.Mig)
		switch {
		case !strings.HasPrefix(g.Uuid, "GPU-"):
			t.Errorf("GPU %d: uuid %q", i, g.Uuid)
		case g.Name == "" || g.Architecture == "":
			t.Errorf("GPU %d: name %q architecture %q", i, g.Name, g.Architecture)
		case g.VramBytes == 0 || g.CudaComputeCapabilityMajor == 0:
			t.Errorf("GPU %d: vram %d, compute capability %d.%d", i, g.VramBytes, g.CudaComputeCapabilityMajor,
				g.CudaComputeCapabilityMinor)
		case g.PciBusId == "":
			t.Errorf("GPU %d: no PCI bus id", i)
		}
	}
	for _, sample := range snap.Samples {
		t.Logf("sample %s: %d/%d MiB, %d%%, %d C, %d mW, %s, %d process(es)", sample.UUID, sample.MemoryUsed>>20,
			sample.MemoryTotal>>20, sample.UtilizationGPU, sample.TemperatureC, sample.PowerDrawMw, sample.PState,
			sample.Processes)
		if sample.MemoryTotal == 0 || sample.PState == "" {
			t.Errorf("sample %s: %+v", sample.UUID, sample)
		}
	}
}
