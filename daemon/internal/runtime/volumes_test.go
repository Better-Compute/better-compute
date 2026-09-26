package runtime

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"os"
	"slices"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

func TestVolumesAreSparseGrowNeverShrinkAndAreDiscarded(t *testing.T) {
	v := &Volumes{Dir: t.TempDir() + "/volumes"}
	hv := &agentv1.HostVolume{VolumeId: "vol_mem", SizeBytes: 1 << 30, Serial: "bcv-mem1"}
	if grew, err := v.Ensure(hv); err != nil || grew {
		t.Fatalf("created: grew %v, %v", grew, err)
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
	if grew, err := v.Ensure(hv); err != nil || !grew {
		t.Fatalf("grown: grew %v, %v", grew, err)
	}
	if grew, err := v.Ensure(hv); err != nil || grew {
		t.Fatalf("unchanged: grew %v, %v", grew, err)
	}
	if got, _ := v.Get("vol_mem"); got.SizeBytes != 2<<30 {
		t.Fatalf("grown to %d", got.SizeBytes)
	}
	if head, _ := os.ReadFile(got.Path); !strings.HasPrefix(string(head), "memory") {
		t.Fatal("the grow lost the volume's data")
	}
	hv.SizeBytes = 1 << 30
	if _, err := v.Ensure(hv); err == nil || !strings.Contains(err.Error(), "never shrinks") {
		t.Fatalf("shrink: %v", err)
	}
	for name, bad := range map[string]*agentv1.HostVolume{
		"id":     {VolumeId: "../etc", SizeBytes: 512, Serial: "x"},
		"serial": {VolumeId: "vol_b", SizeBytes: 512, Serial: "UPPER"},
		"long":   {VolumeId: "vol_b", SizeBytes: 512, Serial: strings.Repeat("a", 21)},
		"size":   {VolumeId: "vol_b", SizeBytes: 1000, Serial: "b"},
	} {
		if _, err := v.Ensure(bad); err == nil {
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

// Sparse volumes are still promised: a volume or a growth the filesystem could not hold, once every
// volume is written, is refused.
func TestVolumesNeverPromiseMoreThanTheFilesystemHolds(t *testing.T) {
	// 100 GiB, 12 GiB free: the reserve is 5 GiB, so 7 GiB can be promised.
	v := &Volumes{Dir: t.TempDir(), statfs: func(string) (uint64, uint64, error) { return 100 << 30, 12 << 30, nil }}
	if _, err := v.Ensure(&agentv1.HostVolume{VolumeId: "vol_a", SizeBytes: 4 << 30, Serial: "a"}); err != nil {
		t.Fatal(err)
	}
	// vol_a is unwritten: its 4 GiB are promised, 3 GiB are left.
	err := func() error {
		_, err := v.Ensure(&agentv1.HostVolume{VolumeId: "vol_b", SizeBytes: 4 << 30, Serial: "b"})
		return err
	}()
	if err == nil || !strings.Contains(err.Error(), "3072 MiB can still be promised") {
		t.Fatalf("a 4 GiB volume beside it: %v", err)
	}
	if _, err := v.Ensure(&agentv1.HostVolume{VolumeId: "vol_b", SizeBytes: 3 << 30, Serial: "b"}); err != nil {
		t.Fatalf("3 GiB refused: %v", err)
	}
	// Nothing left: a growth is refused too, and the volume keeps its size.
	if _, err := v.Ensure(&agentv1.HostVolume{VolumeId: "vol_a", SizeBytes: 5 << 30, Serial: "a"}); err == nil {
		t.Fatal("a growth beyond the filesystem was accepted")
	}
	if got, _ := v.Get("vol_a"); got.SizeBytes != 4<<30 {
		t.Fatalf("vol_a is %d bytes", got.SizeBytes)
	}
	s, err := v.Space()
	if err != nil || s.Committed != 7<<30 || s.Reserve != 5<<30 || s.Promisable() != 0 {
		t.Fatalf("space = %+v, %v", s, err)
	}
	// Unchanged sizes need nothing more.
	if _, err := v.Ensure(&agentv1.HostVolume{VolumeId: "vol_a", SizeBytes: 4 << 30, Serial: "a"}); err != nil {
		t.Fatalf("an unchanged volume: %v", err)
	}
}

// A running guest is told its volume grew, by the disk it was started with; a stopped one is not.
func TestGrownVolumesAreToldToRunningGuests(t *testing.T) {
	ctx := t.Context()
	vol := AttachedVolume{Volume: Volume{ID: "vol_a", Path: "/var/lib/bcd/volumes/vol_a.raw", SizeBytes: 4 << 30}}

	virt := &fakeVirt{domains: map[string]*fakeDomain{"inst_v": {state: "running", xml: []byte(`<domain><name>inst_v</name><devices>
<disk type="file" device="disk"><source file="/x/disk.qcow2"/><target dev="vda" bus="virtio"/></disk>
<disk type="file" device="disk"><source file="/var/lib/bcd/volumes/vol_a.raw"/><target dev="vdb" bus="virtio"/></disk>
</devices></domain>`)}}}
	var calls []string
	l := &Libvirt{Dir: t.TempDir(), Exec: func(ctx context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		return virt.exec(ctx, name, args...)
	}}
	if err := l.GrowVolume(ctx, "inst_v", vol); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(calls, "virsh -c qemu:///system blockresize inst_v vdb 4294967296B") {
		t.Fatalf("virsh calls = %v", calls)
	}
	virt.domains["inst_v"].state = "shut off"
	calls = nil
	if err := l.GrowVolume(ctx, "inst_v", vol); err != nil || slices.ContainsFunc(calls, func(c string) bool { return strings.Contains(c, "blockresize") }) {
		t.Fatalf("a stopped domain: %v %v", calls, err)
	}

	var resized []any
	c := &CloudHypervisor{Dir: t.TempDir(), API: func(_ context.Context, _, _, path string, body any, _ []*os.File) ([]byte, int, error) {
		switch path {
		case "/api/v1/vm.info":
			return []byte(`{"state":"Running"}`), 200, nil
		case "/api/v1/vm.resize-disk":
			resized = append(resized, body)
		}
		return nil, 200, nil
	}}
	r := &chRecord{ID: "inst_c", Managed: chManaged, StartedVolumes: []AttachedVolume{{Volume: Volume{Path: "/v/other.raw"}}, vol}}
	if err := os.MkdirAll(c.instanceDir(r.ID), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := c.save(r); err != nil {
		t.Fatal(err)
	}
	if err := c.GrowVolume(ctx, "inst_c", vol); err != nil {
		t.Fatal(err)
	}
	if raw, _ := json.Marshal(resized); string(raw) != `[{"desired_size":4294967296,"id":"vol1"}]` {
		t.Fatalf("resized = %s", raw)
	}
	// Listed with what it has open.
	if domains, _ := c.List(ctx); len(domains) != 1 || len(domains[0].Volumes) != 2 || domains[0].Volumes[1].Path != vol.Path {
		t.Fatalf("listed = %+v", domains)
	}
	// Attached since the VM started: nothing to tell it until its next start.
	other := vol
	other.Path = "/v/new.raw"
	if err := c.GrowVolume(ctx, "inst_c", other); err != nil || len(resized) != 1 {
		t.Fatalf("a volume the VM was not started with: %v %v", resized, err)
	}
}

func TestInstancesAttachVolumesInOrderBySerial(t *testing.T) {
	v := &Volumes{Dir: t.TempDir()}
	for _, hv := range []*agentv1.HostVolume{
		{VolumeId: "vol_a", SizeBytes: 1 << 20, Serial: "bcv-a"},
		{VolumeId: "vol_b", SizeBytes: 1 << 20, Serial: "bcv-b"},
	} {
		if _, err := v.Ensure(hv); err != nil {
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
	// A running domain is listed with the volumes its live definition has open.
	d.Metadata.Instance.ID = "inst_v"
	live, _ := xml.Marshal(d)
	virt := &fakeVirt{domains: map[string]*fakeDomain{"inst_v": {xml: live, state: "running"}}}
	l.Exec = virt.exec
	listed, err := l.List(t.Context())
	if err != nil || len(listed) != 1 || len(listed[0].Volumes) != 2 || listed[0].Volumes[0].ID != "vol_b" || listed[0].Volumes[0].ReadOnly ||
		listed[0].Volumes[1].ID != "vol_a" || !listed[0].Volumes[1].ReadOnly {
		t.Fatalf("listed = %+v, %v", listed, err)
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
