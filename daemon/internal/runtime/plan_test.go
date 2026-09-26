package runtime

import (
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// The plan is the domain XML libvirt would get: placement, balloon and volumes as Ensure renders them.
func TestRenderLibvirt(t *testing.T) {
	volumes := &Volumes{Dir: t.TempDir()}
	if _, err := volumes.Ensure(&agentv1.HostVolume{VolumeId: "vol_data", SizeBytes: 1 << 30, Serial: "bcv-data1"}); err != nil {
		t.Fatal(err)
	}
	spec := &agentv1.InstanceSpec{InstanceId: "inst_p", AllocationId: "alloc_p", Vcpu: 2, MemoryBytes: 4 << 30,
		Placement: &agentv1.InstancePlacement{Cpus: "8-9", Mems: "1", HugepageSizeBytes: Hugepage1Gi},
		Volumes:   []*agentv1.InstanceVolume{{VolumeId: "vol_data"}}}
	raw, err := RenderLibvirt(spec, "/var/lib/bcd/instances/inst_p", volumes, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`<vcpupin vcpu="0" cpuset="8">`, `<vcpupin vcpu="1" cpuset="9">`, `mode="strict" nodeset="1"`,
		`<page size="1048576" unit="KiB">`, `<serial>bcv-data1</serial>`, `<memballoon model="none">`, `id="inst_p"`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("plan lacks %s:\n%s", want, raw)
		}
	}
	spec.Placement = &agentv1.InstancePlacement{Balloon: true}
	spec.Volumes = nil
	if raw, err = RenderLibvirt(spec, "/d", volumes, nil); err != nil || !strings.Contains(string(raw), `<memballoon model="virtio">`) {
		t.Fatalf("balloon plan: %v\n%s", err, raw)
	}
	// What libvirt would refuse, the plan refuses: a GPU without a PCI address.
	spec.GpuDeviceIds = []string{"GPU-x"}
	if _, err := RenderLibvirt(spec, "/d", volumes, func(string) (string, bool) { return "", false }); err == nil {
		t.Fatal("a GPU without an address was planned")
	}
}
