package runtime

import (
	"encoding/json"
	"encoding/xml"
	"reflect"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

func placedSpec(vcpu uint32, memory uint64, p *agentv1.InstancePlacement) *agentv1.InstanceSpec {
	return &agentv1.InstanceSpec{InstanceId: "inst_placed", Vcpu: vcpu, MemoryBytes: memory, Placement: p}
}

func TestCPUListRoundTrip(t *testing.T) {
	got, err := ParseCPUList("8-11, 72,74-75,8")
	if err != nil {
		t.Fatal(err)
	}
	if want := []int{8, 9, 10, 11, 72, 74, 75}; !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed %v, want %v", got, want)
	}
	if s := FormatCPUList(got); s != "8-11,72,74-75" {
		t.Fatalf("formatted %q", s)
	}
	for _, bad := range []string{"", "3-1", "a", "1,,2", "-1", "0-99999"} {
		if _, err := ParseCPUList(bad); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestPlacementOfChecksWhatTheHostMustApply(t *testing.T) {
	if p, err := PlacementOf(placedSpec(4, 8<<30, nil)); p != nil || err != nil {
		t.Fatalf("no placement: %v %v", p, err)
	}
	p, err := PlacementOf(placedSpec(4, 8<<30, &agentv1.InstancePlacement{Cpus: "8-11", Mems: "1", HugepageSizeBytes: Hugepage2Mi, Balloon: true}))
	if err != nil {
		t.Fatal(err)
	}
	if !p.Pinned(4) || p.Balloon || !reflect.DeepEqual(p.MemNodes, []int{1}) {
		t.Fatalf("placement %+v: pinned, no balloon with hugepages, node 1", p)
	}
	for name, bad := range map[string]*agentv1.InstancePlacement{
		"fewer CPUs than vCPUs": {Cpus: "8-9"},
		"odd hugepage size":     {HugepageSizeBytes: 4096},
		"bad mems":              {Mems: "x"},
	} {
		if _, err := PlacementOf(placedSpec(4, 8<<30, bad)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// Memory must be whole hugepages.
	if _, err := PlacementOf(placedSpec(1, 3<<29, &agentv1.InstancePlacement{HugepageSizeBytes: Hugepage1Gi})); err == nil {
		t.Error("1.5 GiB on 1 GiB pages accepted")
	}
}

func TestLibvirtRendersPlacement(t *testing.T) {
	l := &Libvirt{}
	d, err := l.domainFor(placedSpec(2, 4<<30, &agentv1.InstancePlacement{Cpus: "8,9", Mems: "1", HugepageSizeBytes: Hugepage1Gi}), t.TempDir(), "", instanceMetaXML{ID: "inst_placed"})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := xml.Marshal(d)
	out := string(raw)
	for _, want := range []string{
		`<vcpu placement="static" cpuset="8-9">2</vcpu>`,
		`<vcpupin vcpu="0" cpuset="8"></vcpupin><vcpupin vcpu="1" cpuset="9"></vcpupin>`,
		`<numatune><memory mode="strict" nodeset="1"></memory></numatune>`,
		`<page size="1048576" unit="KiB"></page>`,
		`<locked></locked>`,
		`<memballoon model="none"></memballoon>`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("domain lacks %s:\n%s", want, out)
		}
	}
	// Floating within a larger set: cpuset only, no pins; a balloon when asked for.
	d, err = l.domainFor(placedSpec(2, 4<<30, &agentv1.InstancePlacement{Cpus: "8-15", Balloon: true}), t.TempDir(), "", instanceMetaXML{ID: "inst_placed"})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = xml.Marshal(d)
	if out := string(raw); strings.Contains(out, "vcpupin") || !strings.Contains(out, `cpuset="8-15"`) || !strings.Contains(out, `<memballoon model="virtio">`) {
		t.Errorf("floating placement rendered as:\n%s", out)
	}
	// A domain without placement gets no balloon libvirt would otherwise add, and lists back its vCPUs.
	d, _ = l.domainFor(placedSpec(3, 4<<30, nil), t.TempDir(), "", instanceMetaXML{ID: "inst_placed"})
	raw, _ = xml.Marshal(d)
	var back domainXML
	if err := xml.Unmarshal(raw, &back); err != nil || back.VCPU.Value != 3 || back.Devices.Memballoon.Model != "none" {
		t.Errorf("unplaced domain: %v %+v", err, back.VCPU)
	}
}

func TestCloudHypervisorAppliesPlacement(t *testing.T) {
	c := &CloudHypervisor{Dir: t.TempDir()}
	spec := placedSpec(2, 4<<30, &agentv1.InstancePlacement{Cpus: "8-9", Mems: "1", HugepageSizeBytes: Hugepage2Mi})
	cfg, err := c.vmConfig(spec, t.TempDir(), true)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(cfg)
	out := string(raw)
	for _, want := range []string{`"affinity":[{"host_cpus":[8],"vcpu":0},{"host_cpus":[9],"vcpu":1}]`, `"hugepage_size":2097152`, `"hugepages":true`} {
		if !strings.Contains(out, want) {
			t.Errorf("config lacks %s: %s", want, out)
		}
	}
	if strings.Contains(out, "balloon") {
		t.Errorf("a balloon with hugepages: %s", out)
	}
	placement, _ := PlacementOf(spec)
	r := &chRecord{ID: "inst_placed", UID: 70000, VCPU: 2, MemoryBytes: 4 << 30, Placement: placement}
	props := strings.Join(c.unitProperties(r), "\n")
	for _, want := range []string{"AllowedCPUs=8-9", "AllowedMemoryNodes=1"} {
		if !strings.Contains(props, want) {
			t.Errorf("unit lacks %s", want)
		}
	}
	// Hugepages are charged to the hugetlb pool: the memory cgroup bounds only the overhead.
	if got, want := chMemoryMax(r), uint64(4<<30)/32+256<<20; got != want {
		t.Errorf("MemoryMax %d, want %d", got, want)
	}
	// Restored from its memory snapshot: normal pages. Its later cold starts use hugepages again.
	r.RestoredFrom, r.FromSnapshot = "ab", true
	if got := chMemoryMax(r); got != 4<<30+uint64(4<<30)/32+256<<20 {
		t.Errorf("a VM restored from its memory runs on normal pages: MemoryMax %d", got)
	}
	r.FromSnapshot = false
	if got := chMemoryMax(r); got != uint64(4<<30)/32+256<<20 {
		t.Errorf("a restored instance's cold start: MemoryMax %d", got)
	}
	r.RestoredFrom = ""
	// A restore keeps bcd's pinning, never the snapshot's.
	saved := map[string]any{
		"cpus":   map[string]any{"boot_vcpus": json.Number("2"), "max_vcpus": json.Number("2"), "affinity": []any{"tenant's"}},
		"memory": map[string]any{"size": json.Number("4294967296")},
	}
	restored, err := restoredConfig(saved, cfg, spec)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := json.Marshal(restored["cpus"]); !strings.Contains(string(got), `"host_cpus":[8]`) {
		t.Errorf("restored cpus %s", got)
	}
}
