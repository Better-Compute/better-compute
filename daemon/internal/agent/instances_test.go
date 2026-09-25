package agent

import (
	"context"
	"path/filepath"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

func vm(id string, state agentv1.InstanceDesiredState) *agentv1.InstanceSpec {
	return &agentv1.InstanceSpec{
		InstanceId: id, DesiredState: state, Runtime: "libvirt-kvm", AllocationId: "alloc_" + id, Vcpu: 2, MemoryBytes: 4 << 30,
		DiskBytes: 20 << 30, Image: &agentv1.ImageRef{Ref: "ubuntu", Url: "https://img/ubuntu.qcow2", Sha256: []byte{1, 2}, Format: "qcow2"},
		Nics: []*agentv1.InstanceNic{{Network: "br0", Mac: "52:54:00:00:00:01", Addresses: []string{"10.0.0.5/24"}}},
	}
}

func instanceStates(st *agentv1.StatusReport) map[string]agentv1.InstanceObservedState {
	out := map[string]agentv1.InstanceObservedState{}
	for _, i := range st.GetInstances() {
		out[i.GetInstanceId()] = i.GetState()
	}
	return out
}

func TestInstancesConverger(t *testing.T) {
	var fake *runtime.Fake
	h := newHarness(t, func(o *Options) {
		fake = &runtime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}
		o.Runtimes = []runtime.Runtime{fake}
	})
	s, hello := h.open()
	found := false
	for _, d := range hello.GetDrivers() {
		found = found || (d.GetId() == "libvirt-kvm" && d.GetKinds()[0] == "runtime")
	}
	if !found {
		t.Fatalf("Hello does not advertise the runtime: %v", hello.GetDrivers())
	}
	_ = fake.Leak("foreign-vm", runtime.StateRunning)

	web := vm("inst_web", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	web.UserDataRef = "secret://t/ud"
	warm := vm("inst_warm", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_PAUSED)
	odd := vm("inst_odd", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	odd.Runtime = "firecracker"
	s.push(desired(1, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web, warm, odd}}}))
	if req := answerSecret(t, s, "#cloud-config\n"); req.GetAllocationId() != "alloc_inst_web" {
		t.Fatalf("user data fetched for %v", req)
	}
	status := s.next(t, "status with instances", func(f *agentv1.AgentFrame) bool {
		return f.GetStatus() != nil && len(f.GetStatus().GetInstances()) >= 4
	}).GetStatus()
	got := instanceStates(status)
	if !status.GetInstancesComplete() || got["inst_web"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING ||
		got["inst_warm"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_PAUSED ||
		got["inst_odd"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR ||
		got["foreign-vm"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING {
		t.Fatalf("instances = %v", status.GetInstances())
	}
	domains, _ := fake.List(context.Background())
	for _, d := range domains {
		if d.ID == "inst_web" && (d.UserData != "#cloud-config\n" || d.Boots != 1) {
			t.Fatalf("web = %+v", d)
		}
	}

	// Dropped from the spec: removed. The foreign domain stays, untouched.
	s.push(desired(2, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web}}}))
	status = s.next(t, "status after removal", func(f *agentv1.AgentFrame) bool {
		return f.GetStatus().GetAppliedGeneration() == 2
	}).GetStatus()
	got = instanceStates(status)
	if _, still := got["inst_warm"]; still || got["foreign-vm"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING {
		t.Fatalf("after removal = %v", status.GetInstances())
	}

	// A host reboot stops the VMs; the converger starts the ones that should run.
	fake.BootID = "boot-2"
	s.push(desired(3, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web}}}))
	status = s.next(t, "status after reboot", func(f *agentv1.AgentFrame) bool {
		return f.GetStatus().GetAppliedGeneration() == 3
	}).GetStatus()
	if instanceStates(status)["inst_web"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING {
		t.Fatalf("after reboot = %v", status.GetInstances())
	}
	domains, _ = fake.List(context.Background())
	for _, d := range domains {
		if d.ID == "inst_web" && d.Boots != 2 {
			t.Fatalf("web booted %d times", d.Boots)
		}
	}
}
