package runtime

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

func TestVolumesAreSparseGrowNeverShrinkAndAreDiscarded(t *testing.T) {
	v := &Volumes{Dir: t.TempDir() + "/volumes"}
	hv := &agentv1.HostVolume{VolumeId: "vol_mem", SizeBytes: 1 << 30, Serial: "bcv-mem1"}
	if err := v.Ensure(hv); err != nil {
		t.Fatal(err)
	}
	got, err := v.Get("vol_mem")
	if err != nil || got.SizeBytes != 1<<30 || got.Serial != "bcv-mem1" {
		t.Fatalf("volume = %+v, %v", got, err)
	}
	if info, _ := os.Stat(got.Path); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode())
	}
	// The guest's data survives a grow.
	if err := os.WriteFile(got.Path, []byte("memory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(got.Path, 1<<30); err != nil {
		t.Fatal(err)
	}
	hv.SizeBytes = 2 << 30
	if err := v.Ensure(hv); err != nil {
		t.Fatal(err)
	}
	if got, _ := v.Get("vol_mem"); got.SizeBytes != 2<<30 {
		t.Fatalf("grown to %d", got.SizeBytes)
	}
	if head, _ := os.ReadFile(got.Path); !strings.HasPrefix(string(head), "memory") {
		t.Fatal("the grow lost the volume's data")
	}
	hv.SizeBytes = 1 << 30
	if err := v.Ensure(hv); err == nil || !strings.Contains(err.Error(), "never shrinks") {
		t.Fatalf("shrink: %v", err)
	}
	for name, bad := range map[string]*agentv1.HostVolume{
		"id":     {VolumeId: "../etc", SizeBytes: 512, Serial: "x"},
		"serial": {VolumeId: "vol_b", SizeBytes: 512, Serial: "UPPER"},
		"long":   {VolumeId: "vol_b", SizeBytes: 512, Serial: strings.Repeat("a", 21)},
		"size":   {VolumeId: "vol_b", SizeBytes: 1000, Serial: "b"},
	} {
		if err := v.Ensure(bad); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if ids, _ := v.List(); !slices.Equal(ids, []string{"vol_mem"}) {
		t.Fatalf("list = %v", ids)
	}
	if err := v.Destroy("vol_mem"); err != nil {
		t.Fatal(err)
	}
	if ids, _ := v.List(); len(ids) != 0 {
		t.Fatalf("after destroy: %v", ids)
	}
	if err := v.Destroy("vol_mem"); err != nil {
		t.Fatalf("destroying an absent volume: %v", err)
	}
}

func TestInstancesAttachVolumesInOrderBySerial(t *testing.T) {
	v := &Volumes{Dir: t.TempDir()}
	for _, hv := range []*agentv1.HostVolume{
		{VolumeId: "vol_a", SizeBytes: 1 << 20, Serial: "bcv-a"},
		{VolumeId: "vol_b", SizeBytes: 1 << 20, Serial: "bcv-b"},
	} {
		if err := v.Ensure(hv); err != nil {
			t.Fatal(err)
		}
	}
	spec := &agentv1.InstanceSpec{InstanceId: "inst_v", Vcpu: 2, MemoryBytes: 2 << 30,
		Volumes: []*agentv1.InstanceVolume{{VolumeId: "vol_b"}, {VolumeId: "vol_a", ReadOnly: true}}}

	l := &Libvirt{Dir: t.TempDir(), Volumes: v}
	d, err := l.domainFor(spec, t.TempDir(), "", instanceMetaXML{})
	if err != nil {
		t.Fatal(err)
	}
	var vols []diskXML
	for _, disk := range d.Devices.Disks {
		if disk.Serial != "" {
			vols = append(vols, disk)
		}
	}
	if len(vols) != 2 || vols[0].Target.Dev != "vdb" || vols[0].Serial != "bcv-b" || vols[0].ReadOnly != nil || vols[0].Driver.Type != "raw" ||
		vols[1].Target.Dev != "vdc" || vols[1].Serial != "bcv-a" || vols[1].ReadOnly == nil {
		t.Fatalf("libvirt volume disks = %+v", vols)
	}

	c := &CloudHypervisor{Dir: t.TempDir(), Volumes: v}
	cfg, err := c.vmConfig(spec, t.TempDir(), true)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(cfg["disks"])
	if !strings.Contains(string(raw), `"id":"vol0","image_type":"Raw","path":"`+v.path("vol_b")+`","readonly":false,"serial":"bcv-b"`) ||
		!strings.Contains(string(raw), `"id":"vol1","image_type":"Raw","path":"`+v.path("vol_a")+`","readonly":true,"serial":"bcv-a"`) {
		t.Fatalf("cloud-hypervisor disks = %s", raw)
	}
	vols2, _ := v.Attached(spec)
	props := strings.Join(c.unitProperties(&chRecord{ID: "inst_v", UID: 70001, VCPU: 2, MemoryBytes: 2 << 30, Volumes: vols2}), "\n")
	if !strings.Contains(props, "BindPaths="+v.path("vol_b")+"\n") || !strings.Contains(props, "BindReadOnlyPaths="+v.path("vol_a")) {
		t.Fatalf("unit properties:\n%s", props)
	}

	// A volume the host lacks, the same volume twice, or volumes without a store: refused.
	for name, bad := range map[string]*agentv1.InstanceSpec{
		"missing": {InstanceId: "inst_x", Volumes: []*agentv1.InstanceVolume{{VolumeId: "vol_gone"}}},
		"twice":   {InstanceId: "inst_x", Volumes: []*agentv1.InstanceVolume{{VolumeId: "vol_a"}, {VolumeId: "vol_a"}}},
	} {
		if _, err := v.Attached(bad); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if _, err := (*Volumes)(nil).Attached(spec); err == nil {
		t.Error("volumes accepted without a store")
	}
}
