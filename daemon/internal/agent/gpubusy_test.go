package agent

import (
	"path/filepath"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
	"google.golang.org/protobuf/proto"
)

// A VM never starts on a GPU a hold has (passthrough takes it off its host driver), a MIG instance
// or slot of it included.
func TestAVMIsRefusedAGPUAHoldHas(t *testing.T) {
	var fake *runtime.Fake
	h := newHarness(t, func(o *Options) {
		fake = &runtime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}
		o.Runtimes = []runtime.Runtime{fake}
	})
	s, _ := h.open()
	gpus := fakehw.Inventory(1).Gpus.Gpus
	vmOn := vm("inst_gpu", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	vmOn.GpuDeviceIds = []string{gpus[1].Uuid}
	s.push(desired(1, &agentv1.NodeSpec{
		Devices: &agentv1.DevicesSection{Assignments: []*agentv1.DeviceAssignment{{AllocationId: "alloc_slot", Binding: agentv1.Binding_BINDING_HOLD,
			Devices: []*agentv1.AssignedDevice{dev(gpus[1].Uuid+"/s0", "gpu.slot")}}}},
		Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{vmOn}},
	}))
	st := s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus().GetObservedGeneration() == 1 }).GetStatus()
	if len(st.GetInstances()) != 1 || !strings.Contains(st.GetInstances()[0].GetMessage(), "has a live hold") {
		t.Fatalf("instances = %v", st.GetInstances())
	}
	if domains, _ := fake.List(t.Context()); len(domains) != 0 {
		t.Fatalf("the VM was defined: %v", domains)
	}
}

// gpu.reset and diag.dcgm (from level 2) refuse a GPU whose MIG instance or slot is held, or that a
// VM has passed through, not only a GPU held whole.
func TestResetAndDcgmRefuseGPUsInUseByPartsOrVMs(t *testing.T) {
	h := newHarness(t, nil)
	s, _ := h.open()
	gpus := fakehw.Inventory(1).Gpus.Gpus
	s.push(desired(1, &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{Assignments: []*agentv1.DeviceAssignment{{
		AllocationId: "alloc_slot", Binding: agentv1.Binding_BINDING_HOLD,
		Devices: []*agentv1.AssignedDevice{dev(gpus[1].Uuid+"/s0", "gpu.slot")},
	}}}}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil })
	h.agent.instances.specsMu.Lock()
	h.agent.instances.specs = []*agentv1.InstanceSpec{{InstanceId: "inst_vm", GpuDeviceIds: []string{gpus[2].Uuid},
		DesiredState: agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING}}
	h.agent.instances.specsMu.Unlock()

	refused := func(id, kind string, payload proto.Message, want string) {
		t.Helper()
		b := body(id, kind, payload)
		s.push(command(b))
		u := s.update(t, id, commonv1.CommandState_COMMAND_STATE_FAILED)
		if u.GetError().GetCode() != "gpu-busy" || !strings.Contains(u.GetError().GetMessage(), want) {
			t.Fatalf("%s = %v", id, u.GetError())
		}
	}
	refused("r_slot", "gpu.reset", &agentv1.GpuResetRequest{GpuUuids: []string{gpus[1].Uuid}}, gpus[1].Uuid+" has a live assignment")
	refused("r_vm", "gpu.reset", &agentv1.GpuResetRequest{GpuUuids: []string{gpus[2].Uuid}}, "passed through to inst_vm")
	refused("d_vm", "diag.dcgm", &agentv1.DiagDcgmRequest{Level: 3, GpuUuids: []string{gpus[2].Uuid}}, "inst_vm")
	// No uuids means every GPU, the busy ones among them.
	refused("d_all", "diag.dcgm", &agentv1.DiagDcgmRequest{Level: 2}, gpus[1].Uuid)
	if len(h.host.resets) != 0 {
		t.Fatalf("resets = %v", h.host.resets)
	}

	// Level 1 only checks deployment and runs beside workloads; a free GPU runs any level.
	s.push(command(body("d_quick", "diag.dcgm", &agentv1.DiagDcgmRequest{Level: 1})))
	s.update(t, "d_quick", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	s.push(command(body("d_free", "diag.dcgm", &agentv1.DiagDcgmRequest{Level: 3, GpuUuids: []string{gpus[3].Uuid}})))
	s.update(t, "d_free", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
}
