package agent

import (
	"encoding/json"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

func holdInventory() *inventory.NodeInventory {
	return &inventory.NodeInventory{Gpus: &inventory.GpusSection{Gpus: []*inventory.Gpu{
		{Uuid: "GPU-a", Mig: &inventory.GpuMig{Instances: []*inventory.MigInstance{
			{GiId: 1, CiId: 0, Uuid: "MIG-a10"},
			{GiId: 2, CiId: 0, Uuid: "MIG-a20"},
		}}},
		{Uuid: "GPU-b"},
	}}}
}

func dev(id, class string) *agentv1.AssignedDevice {
	return &agentv1.AssignedDevice{Id: id, DeviceClass: class}
}

func TestResolveAtomNamesParentsAndWhatTheDriverSees(t *testing.T) {
	inv := holdInventory()
	for _, c := range []struct {
		dev             *agentv1.AssignedDevice
		parent, visible string
		reason          string
	}{
		{dev: dev("GPU-b", ""), parent: "GPU-b", visible: "GPU-b"},
		{dev: dev("GPU-a/gi2/ci0", "gpu.mig"), parent: "GPU-a", visible: "MIG-a20"},
		{dev: dev("GPU-b/s3", "gpu.slot"), parent: "GPU-b", visible: "GPU-b"},
		// The booked layout is not the GPU's yet (mig-layout applies it first).
		{dev: dev("GPU-a/gi5/ci0", "gpu.mig"), reason: "device-missing"},
		{dev: dev("GPU-z", "gpu"), reason: "device-missing"},
		{dev: dev("GPU-a", "gpu.mig"), reason: "unsupported-device"},
		{dev: dev("nvme0", "disk"), reason: "unsupported-device"},
	} {
		a, reason, _ := resolveAtom(inv, c.dev)
		if reason != c.reason || a.parent != c.parent || a.visible != c.visible {
			t.Errorf("%s: got %+v reason %q", c.dev.GetId(), a, reason)
		}
	}
}

func TestHoldConflictsAcrossWholeGPUsPartsAndVMs(t *testing.T) {
	inv := holdInventory()
	atoms := func(devs ...*agentv1.AssignedDevice) []atom {
		var out []atom
		for _, d := range devs {
			a, reason, msg := resolveAtom(inv, d)
			if reason != "" {
				t.Fatalf("%s: %s", reason, msg)
			}
			out = append(out, a)
		}
		return out
	}
	claimed := map[string]string{"GPU-a/gi1/ci0": "alloc_1", "GPU-b": "alloc_2"}
	cases := map[string]struct {
		atoms []atom
		want  string
	}{
		"another MIG instance of the same GPU": {atoms(dev("GPU-a/gi2/ci0", "gpu.mig")), ""},
		"the same MIG instance":                {atoms(dev("GPU-a/gi1/ci0", "gpu.mig")), "assigned to alloc_1"},
		"a GPU part of which is held":          {atoms(dev("GPU-a", "gpu")), "has GPU-a/gi1/ci0 assigned to alloc_1"},
		"a slot of a GPU held whole":           {atoms(dev("GPU-b/s0", "gpu.slot")), "GPU-b is assigned to alloc_2"},
		"a device listed twice":                {atoms(dev("GPU-a/gi2/ci0", "gpu.mig"), dev("GPU-a/gi2/ci0", "gpu.mig")), "listed twice"},
	}
	for name, c := range cases {
		got := holdConflict("alloc_new", c.atoms, claimed, nil)
		if (c.want == "") != (got == "") || !strings.Contains(got, c.want) {
			t.Errorf("%s: %q, want %q", name, got, c.want)
		}
	}
	// A hold's own atoms never conflict with itself (a rewritten hold).
	if got := holdConflict("alloc_1", atoms(dev("GPU-a/gi1/ci0", "gpu.mig")), claimed, nil); got != "" {
		t.Errorf("own hold: %q", got)
	}
	// Never beside a VM's GPU, whole or part.
	passed := map[string]string{"GPU-a": "inst_1"}
	if got := holdConflict("alloc_new", atoms(dev("GPU-a/gi2/ci0", "gpu.mig")), map[string]string{}, passed); !strings.Contains(got, "passed through to instance inst_1") {
		t.Errorf("beside a VM: %q", got)
	}
}

func TestCDISpecOfPartsAndLimits(t *testing.T) {
	inv := holdInventory()
	as := &agentv1.DeviceAssignment{
		AllocationId: "alloc_9", ReservationId: "rsv_9",
		Devices: []*agentv1.AssignedDevice{dev("GPU-a/gi1/ci0", "gpu.mig"), dev("GPU-b/s0", "gpu.slot"), dev("GPU-b/s1", "gpu.slot")},
		Limits:  &agentv1.ResourceLimits{Cpus: "8-15", MemoryBytes: 64 << 30},
	}
	var atoms []atom
	for _, d := range as.GetDevices() {
		a, _, _ := resolveAtom(inv, d)
		atoms = append(atoms, a)
	}
	spec := newCDISpec(as, 7, atoms, true)
	raw, _ := json.Marshal(spec)
	out := string(raw)
	for _, want := range []string{
		`"name":"GPU-a_gi1_ci0"`, `"bcd.dev/device-id":"GPU-a/gi1/ci0"`, `"NVIDIA_VISIBLE_DEVICES=MIG-a10,GPU-b"`,
		`"bcd.dev/cgroup-parent":"bcd-alloc-alloc_9.slice"`, `"BCD_CGROUP_PARENT=bcd-alloc-alloc_9.slice"`,
		`"CUDA_MPS_PIPE_DIRECTORY=/run/nvidia-mps"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("CDI spec lacks %s: %s", want, out)
		}
	}
	// Every CDI name is valid (no "/"), and NVIDIA_VISIBLE_DEVICES appears once, for the whole hold.
	for _, d := range spec.Devices {
		if strings.Contains(d.Name, "/") || len(d.ContainerEdits.Env) > 0 {
			t.Errorf("CDI device %+v", d)
		}
	}
	if strings.Count(out, "NVIDIA_VISIBLE_DEVICES") != 1 || strings.Contains(out, "bcd.dev/binding") {
		t.Errorf("a hold's spec: %s", out)
	}
	// A Kubernetes binding is marked for the device plugin, which sets the visible devices per pod.
	as.Binding = agentv1.Binding_BINDING_KUBERNETES
	raw, _ = json.Marshal(newCDISpec(as, 7, atoms, true))
	if kubeOut := string(raw); !strings.Contains(kubeOut, `"bcd.dev/binding":"kubernetes"`) || strings.Contains(kubeOut, "NVIDIA_VISIBLE_DEVICES") {
		t.Errorf("a Kubernetes hold's spec: %s", kubeOut)
	}
	as.Binding = agentv1.Binding_BINDING_HOLD
	// Two slots of one GPU are one visible device.
	env := string(envFile(as, atoms, false))
	if !strings.Contains(env, "NVIDIA_VISIBLE_DEVICES=MIG-a10,GPU-b\n") || strings.Contains(env, "CUDA_MPS") {
		t.Errorf("env file:\n%s", env)
	}
}
