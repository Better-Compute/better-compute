package nvml

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

const listOut = `GPU 0: NVIDIA H100 80GB HBM3 (UUID: GPU-11111111-1111-1111-1111-111111111111)
GPU 1: NVIDIA A100-SXM4-40GB (UUID: GPU-22222222-2222-2222-2222-222222222222)
  MIG 3g.20gb     Device  0: (UUID: MIG-aaaaaaaa-0000-0000-0000-000000000001)
  MIG 2g.10gb     Device  1: (UUID: MIG-aaaaaaaa-0000-0000-0000-000000000002)
`

const computeCapOut = `GPU-11111111-1111-1111-1111-111111111111, 9.0
GPU-22222222-2222-2222-2222-222222222222, 8.0
`

const topoOut = "\t\x1b[4mGPU0\tGPU1\tNIC0\tCPU Affinity\tNUMA Affinity\tGPU NUMA ID\x1b[0m\n" +
	"GPU0\t X \tNV12\tSYS\t0-55\t0\t\tN/A\n" +
	"GPU1\tNV12\t X \tSYS\t56-111\t1\t\tN/A\n" +
	"NIC0\tSYS\tSYS\t X \t\t\t\t\n" +
	"\nLegend:\n\n  X    = Self\n  SYS  = Connection traversing PCIe\n  NV#  = Connection traversing a bonded set of # NVLinks\n"

const nvlinkOut = `GPU 0: NVIDIA H100 80GB HBM3 (UUID: GPU-11111111-1111-1111-1111-111111111111)
	 Link 0: 26.562 GB/s
	 Link 1: <inactive>
GPU 1: NVIDIA A100-SXM4-40GB (UUID: GPU-22222222-2222-2222-2222-222222222222)
	 Link 0: 25 GB/s
`

const nvlinkRemoteOut = `GPU 0: NVIDIA H100 80GB HBM3 (UUID: GPU-11111111-1111-1111-1111-111111111111)
	 Link 0: Remote Device 00000000:2A:00.0: Link 3
	 Link 1: Remote Device 00000000:C5:00.0: Link 29
GPU 1: NVIDIA A100-SXM4-40GB (UUID: GPU-22222222-2222-2222-2222-222222222222)
	 Link 0: Remote Device 00000000:18:00.0: Link 0
`

const lgipOut = `+-----------------------------------------------------------------------------+
| GPU instance profiles:                                                      |
| GPU   Name             ID    Instances   Memory     P2P    SM    DEC   ENC  |
|                              Free/Total   GiB              CE    JPEG  OFA  |
|=============================================================================|
|   1  MIG 1g.5gb        19     5/7        4.75       No     14     0     0   |
|                                                             1     0     0   |
+-----------------------------------------------------------------------------+
|   1  MIG 2g.10gb       14     2/3        9.75       No     28     1     0   |
|                                                             2     0     0   |
+-----------------------------------------------------------------------------+
|   1  MIG 3g.20gb        9     1/2        19.62      No     42     2     0   |
|                                                             3     0     0   |
+-----------------------------------------------------------------------------+
`

// replay answers nvidia-smi from captured output; calls records every invocation.
func replay(t *testing.T, fail map[string]bool) (SMI, *[]string) {
	t.Helper()
	q, err := os.ReadFile("testdata/q.xml")
	if err != nil {
		t.Fatal(err)
	}
	outputs := map[string]string{
		"-q -x": string(q),
		"-L":    listOut,
		"--query-gpu=uuid,compute_cap --format=csv,noheader": computeCapOut,
		"--query-gpu=driver_version --format=csv,noheader":   "580.65.06\n580.65.06\n",
		"topo -m":   topoOut,
		"nvlink -s": nvlinkOut,
		"nvlink -R": nvlinkRemoteOut,
		"mig -lgip": lgipOut,
	}
	var calls []string
	return SMI{Run: func(_ context.Context, args ...string) ([]byte, error) {
		key := strings.Join(args, " ")
		calls = append(calls, key)
		if fail[key] {
			return nil, errors.New("exit status 6")
		}
		out, ok := outputs[key]
		if !ok {
			t.Errorf("unexpected nvidia-smi %s", key)
			return nil, errors.New("unexpected")
		}
		return []byte(out), nil
	}}, &calls
}

func TestSnapshotReadsEveryQuery(t *testing.T) {
	smi, _ := replay(t, nil)
	snap, err := smi.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	s := snap.Section
	if s.DriverVersion != "580.65.06" || s.CudaDriverVersion != "13.0" || len(s.Gpus) != 2 {
		t.Fatalf("section = %+v", s)
	}
	h100, a100 := s.Gpus[0], s.Gpus[1]
	pendingOff := false
	want := &inventory.Gpu{
		Index:                      0,
		Uuid:                       "GPU-11111111-1111-1111-1111-111111111111",
		PciBusId:                   "00000000:18:00.0",
		Name:                       "NVIDIA H100 80GB HBM3",
		Architecture:               "hopper",
		VramBytes:                  81559 << 20,
		Serial:                     "1654922000001",
		VbiosVersion:               "96.00.74.00.01",
		BoardPartNumber:            "692-2G520-0200-000",
		PowerLimitMw:               700000,
		PersistenceMode:            true,
		ComputeMode:                "default",
		CudaComputeCapabilityMajor: 9,
		CudaComputeCapabilityMinor: 0,
		// MIG capable, off, switching on at the next reset.
		Mig: &inventory.GpuMig{Capable: true, Current: inventory.MigMode_MIG_MODE_DISABLED, Pending: inventory.MigMode_MIG_MODE_ENABLED},
		// Link 0 reaches the A100 on 2A:00.0; link 1 an NVSwitch.
		Nvlinks: []*inventory.NvlinkLink{
			{Link: 0, State: inventory.LinkState_LINK_STATE_UP, Peer: "GPU-22222222-2222-2222-2222-222222222222"},
			{Link: 1, State: inventory.LinkState_LINK_STATE_DOWN, Peer: "nvswitch:00000000:C5:00.0"},
		},
		Topology: []*inventory.GpuPeerLink{{PeerUuid: a100.Uuid, Link: inventory.GpuLinkType_GPU_LINK_TYPE_NV, Nvlinks: 12}},
		Fabric:   &inventory.GpuFabric{ClusterUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", CliqueId: 32766},
		Ecc: &inventory.GpuEcc{
			Enabled:         true,
			VolatileCounts:  &inventory.EccCounts{Correctable: 5, Uncorrectable: 1},
			AggregateCounts: &inventory.EccCounts{Correctable: 30, Uncorrectable: 1},
		},
		RowRemap: &inventory.GpuRowRemap{Uncorrectable: 1, Pending: true},
	}
	if !reflect.DeepEqual(h100, want) {
		t.Fatalf("H100 =\n%+v\nwant\n%+v", h100, want)
	}
	// The older layouts: power_readings, single/double-bit ECC, no row remapping, N/A fields.
	if a100.PowerLimitMw != 400000 || a100.Serial != "" || a100.BoardPartNumber != "" || a100.ComputeMode != "exclusive-process" || a100.RowRemap != nil || a100.Fabric != nil {
		t.Fatalf("A100 = %+v", a100)
	}
	if e := a100.Ecc; e == nil || !e.Enabled || e.PendingEnabled == nil || *e.PendingEnabled != pendingOff ||
		*e.VolatileCounts != (inventory.EccCounts{Correctable: 4}) || *e.AggregateCounts != (inventory.EccCounts{Correctable: 9}) {
		t.Fatalf("A100 ECC = %+v", a100.Ecc)
	}
	mig := a100.Mig
	if mig == nil || mig.Current != inventory.MigMode_MIG_MODE_ENABLED || mig.Pending != inventory.MigMode_MIG_MODE_UNSPECIFIED {
		t.Fatalf("A100 MIG = %+v", mig)
	}
	wantInstances := []*inventory.MigInstance{
		{GiId: 1, CiId: 0, Profile: "3g.20gb", Uuid: "MIG-aaaaaaaa-0000-0000-0000-000000000001"},
		{GiId: 2, CiId: 0, Profile: "2g.10gb", Uuid: "MIG-aaaaaaaa-0000-0000-0000-000000000002"},
	}
	if !reflect.DeepEqual(mig.Instances, wantInstances) {
		t.Fatalf("instances = %+v", mig.Instances)
	}
	if len(mig.Profiles) != 3 || *mig.Profiles[0] != (inventory.MigProfile{Id: 9, Name: "3g.20gb", MaxInstances: 2, MemoryBytes: 20090 << 20}) ||
		mig.Profiles[2].Name != "1g.5gb" || mig.Profiles[2].MaxInstances != 7 {
		t.Fatalf("profiles = %+v %+v %+v", mig.Profiles[0], mig.Profiles[1], mig.Profiles[2])
	}

	if len(snap.Samples) != 2 {
		t.Fatalf("samples = %+v", snap.Samples)
	}
	got := snap.Samples[0]
	if got.UUID != h100.Uuid || got.MemoryTotal != 81559<<20 || got.MemoryUsed != 1024<<20 || got.MemoryReserved != 346<<20 ||
		got.MemoryFree != 80189<<20 || got.UtilizationGPU != 87 || got.UtilizationMemory != 40 || got.TemperatureC != 54 ||
		got.PowerDrawMw != 512400 || got.PowerLimitMw != 700000 || got.SMClockMHz != 1980 || got.MemClockMHz != 2619 ||
		got.PState != "P0" || got.Processes != 1 {
		t.Fatalf("H100 sample = %+v", got)
	}
	a := snap.Samples[1]
	if a.PowerDrawMw != 61500 || a.UtilizationGPU != 0 || a.Processes != 0 || len(a.Mig) != 2 ||
		a.Mig[0] != (MigSample{ID: "MIG-aaaaaaaa-0000-0000-0000-000000000001", MemoryTotal: 19968 << 20, MemoryUsed: 13 << 20}) {
		t.Fatalf("A100 sample = %+v", a)
	}
}

func TestSnapshotSurvivesOptionalFailures(t *testing.T) {
	smi, calls := replay(t, map[string]bool{"-L": true, "topo -m": true, "nvlink -s": true, "mig -lgip": true,
		"--query-gpu=uuid,compute_cap --format=csv,noheader": true})
	snap, err := smi.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	a100 := snap.Section.Gpus[1]
	if a100.Mig.Instances[0].Uuid != "" || a100.Mig.Instances[0].GiId != 1 || snap.Section.Gpus[0].Topology != nil || a100.CudaComputeCapabilityMajor != 0 {
		t.Fatalf("A100 = %+v", a100)
	}
	if snap.Samples[1].Mig[0].ID != "gi1/ci0" {
		t.Fatalf("MIG sample id = %q", snap.Samples[1].Mig[0].ID)
	}
	if len(*calls) != 6 {
		t.Fatalf("calls = %v", *calls)
	}

	failing, _ := replay(t, map[string]bool{"-q -x": true})
	if _, err := failing.Snapshot(context.Background()); err == nil {
		t.Fatal("a failing -q -x must fail the snapshot")
	}
}

func TestProbeCountsGPUs(t *testing.T) {
	smi, _ := replay(t, nil)
	info, err := smi.Probe(context.Background())
	if err != nil || info != (Info{DriverVersion: "580.65.06", DeviceCount: 2}) {
		t.Fatalf("Probe = %+v, %v", info, err)
	}
	missing := SMI{Run: func(context.Context, ...string) ([]byte, error) { return nil, ErrNoDriver }}
	if _, err := missing.Probe(context.Background()); !errors.Is(err, ErrNoDriver) {
		t.Fatalf("Probe without nvidia-smi = %v", err)
	}
}

func TestEnrichKeepsSysfsFacts(t *testing.T) {
	smi, _ := replay(t, nil)
	snap, err := smi.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	numa := uint32(1)
	base := &inventory.GpusSection{DriverVersion: "580.65.06", Gpus: []*inventory.Gpu{
		{Index: 0, Uuid: "GPU-22222222-2222-2222-2222-222222222222", PciBusId: "00000000:2A:00.0", NumaNode: &numa, Architecture: "ampere"},
	}}
	merged := Enrich(base, snap)
	if len(merged.Gpus) != 2 || merged.CudaDriverVersion != "13.0" {
		t.Fatalf("merged = %+v", merged)
	}
	a100 := merged.Gpus[0]
	if a100.Index != 0 || a100.NumaNode != &numa || a100.VramBytes != 40960<<20 || a100.Architecture != "ampere" {
		t.Fatalf("A100 = %+v", a100)
	}
	if merged.Gpus[1].Index != 1 || merged.Gpus[1].Uuid != "GPU-11111111-1111-1111-1111-111111111111" {
		t.Fatalf("added GPU = %+v", merged.Gpus[1])
	}
	if Enrich(base, nil) != base || Enrich(nil, snap) != snap.Section {
		t.Fatal("Enrich with nothing to merge")
	}
}
