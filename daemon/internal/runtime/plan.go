package runtime

import (
	"encoding/xml"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// RenderLibvirt returns the libvirt domain XML bcd would define for spec, its disks in dir: vCPU
// pinning, NUMA binding, hugepage backing, the balloon, volumes by serial, GPUs by PCI address. A
// fakehw build writes it beside its fake domains, so tests assert the plan the fake cannot run.
func RenderLibvirt(spec *agentv1.InstanceSpec, dir string, volumes *Volumes, gpuAddress func(id string) (string, bool)) ([]byte, error) {
	l := &Libvirt{Volumes: volumes, GPUAddress: gpuAddress}
	d, err := l.domainFor(spec, dir, "", instanceMetaXML{ID: spec.GetInstanceId(), Allocation: spec.GetAllocationId()})
	if err != nil {
		return nil, err
	}
	return xml.MarshalIndent(d, "", "  ")
}
