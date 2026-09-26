package kube

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
)

// allocatableAnswer is the fake kubelet's GetAllocatableResources answer.
type allocatableAnswer struct{ devices []ContainerDevices }

func (a *allocatableAnswer) marshal() []byte {
	var b []byte
	for _, d := range a.devices {
		b = appendMessage(b, 1, appendStrings(appendString(nil, 1, d.ResourceName), 2, d.DeviceIDs))
	}
	return b
}
func (a *allocatableAnswer) unmarshal([]byte) error { return nil }

type reapCall struct {
	pod   string
	force bool
}

func securityRig(t *testing.T) (*Manager, *fakeKubelet, *hostconfig.FakeSystem, *time.Time, *[]reapCall) {
	t.Helper()
	dir, err := os.MkdirTemp("", "ks")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	kubelet := startKubelet(t, dir)
	sys := hostconfig.NewFakeSystem()
	sys.Set(StateFile, `{"server":"https://10.0.0.1:6443","nodeName":"n1","gpu":true}`)
	now := time.Unix(1_800_000_000, 0)
	var reaped []reapCall
	m := &Manager{
		Sys: sys, Dir: dir, PodResources: filepath.Join(dir, "pod-resources.sock"),
		RegistryDir: filepath.Join(dir, "reg"), DRAPluginDir: filepath.Join(dir, "dra"),
		DeletePod: func(_ context.Context, ns, name string, force bool) error {
			reaped = append(reaped, reapCall{ns + "/" + name, force})
			return nil
		},
		Now: func() time.Time { return now },
	}
	t.Cleanup(m.stopAll)
	return m, kubelet, sys, &now, &reaped
}

func conditionTypes(m *Manager) []string {
	var out []string
	for _, c := range m.Conditions() {
		out = append(out, c.Type)
	}
	return out
}

// The same GPU re-bound to another allocation is another device: a pod the kubelet gave it under the
// old allocation is reaped, first gracefully, then forced a minute later if it still holds it.
func TestReboundGPUIsReclaimed(t *testing.T) {
	m, kubelet, sys, now, reaped := securityRig(t)
	ctx := context.Background()
	sys.Set(CDIDir+"/bcd-a1.json", holdFile("a1", BindingKubernetes, "GPU-1"))
	kubelet.mu.Lock()
	kubelet.podList = []PodResources{{Name: "old", Namespace: "ml", Containers: []ContainerResources{{Name: "main",
		Devices: []ContainerDevices{{ResourceName: ResourceGPU, DeviceIDs: []string{"GPU-1@a1"}}}}}}}
	kubelet.mu.Unlock()
	m.Sync(ctx)
	if len(*reaped) != 0 {
		t.Fatalf("reaped while bound: %v", *reaped)
	}
	// Released and bound again at once to a2: same GPU, same CDI name, but not the pod's device.
	sys.Delete(CDIDir + "/bcd-a1.json")
	sys.Set(CDIDir+"/bcd-a2.json", holdFile("a2", BindingKubernetes, "GPU-1"))
	m.Sync(ctx)
	*now = now.Add(31 * time.Second)
	m.Sync(ctx)
	if !reflect.DeepEqual(*reaped, []reapCall{{"ml/old", false}}) {
		t.Fatalf("reaped = %v", *reaped)
	}
	*now = now.Add(30 * time.Second)
	m.Sync(ctx)
	if len(*reaped) != 1 {
		t.Fatalf("forced before a minute: %v", *reaped)
	}
	*now = now.Add(31 * time.Second)
	m.Sync(ctx)
	if !reflect.DeepEqual(*reaped, []reapCall{{"ml/old", false}, {"ml/old", true}}) {
		t.Fatalf("reaped = %v", *reaped)
	}
	// The pod is gone: Freed tells the devices converger.
	freed := 0
	m.Freed = func() { freed++ }
	kubelet.mu.Lock()
	kubelet.podList = nil
	kubelet.mu.Unlock()
	m.Sync(ctx)
	if freed != 1 {
		t.Fatalf("freed = %d", freed)
	}
}

// InUse: whether a pod still holds a device of an allocation (device plugin id or DRA claim), failing
// closed on a worker without pod-resources, and false on a node that is not a worker.
func TestInUse(t *testing.T) {
	m, kubelet, sys, _, _ := securityRig(t)
	ctx := context.Background()
	kubelet.mu.Lock()
	kubelet.podList = []PodResources{
		{Name: "a", Namespace: "ml", Containers: []ContainerResources{{Name: "main", Devices: []ContainerDevices{{ResourceName: ResourceGPU, DeviceIDs: []string{"GPU-1@a1"}}}}}},
		{Name: "b", Namespace: "ml", Containers: []ContainerResources{{Name: "main", Claimed: []ClaimedDevice{{Driver: DRADriverName, Pool: "n1", Device: draDeviceName("GPU-2", "a2")}}}}},
		{Name: "c", Namespace: "ml", Containers: []ContainerResources{{Name: "main", Claimed: []ClaimedDevice{{Driver: DRADriverName, Pool: "other-node", Device: draDeviceName("GPU-3", "a3")}}}}},
	}
	kubelet.mu.Unlock()
	for alloc, want := range map[string]bool{"a1": true, "a2": true, "a3": false, "a4": false} {
		if got := m.InUse(ctx, alloc); got != want {
			t.Errorf("InUse(%s) = %v", alloc, got)
		}
	}
	m.PodResources = filepath.Join(m.Dir, "absent.sock")
	if !m.InUse(ctx, "a4") {
		t.Fatal("a worker without pod-resources must answer in use")
	}
	sys.Delete(StateFile)
	if m.InUse(ctx, "a1") {
		t.Fatal("a node that is not a worker holds nothing for Kubernetes")
	}
}

// Another path to the GPUs withdraws bcd's offer and raises ForeignGpuExposure: a second device plugin
// (nvidia.com/gpu allocatable) or a toolkit that honours NVIDIA_VISIBLE_DEVICES from unprivileged pods.
func TestForeignGpuExposureWithdrawsTheOffer(t *testing.T) {
	m, kubelet, sys, _, _ := securityRig(t)
	ctx := context.Background()
	sys.Set(CDIDir+"/bcd-a1.json", holdFile("a1", BindingKubernetes, "GPU-1"))
	sys.Set(ToolkitConfigs[0], "[nvidia-container-cli]\n\n[nvidia-container-runtime]\naccept-nvidia-visible-devices-envvar-when-unprivileged = false\n")
	m.Sync(ctx)
	if len(kubelet.registrations()) != 1 || len(m.Conditions()) != 0 || m.Advertised()[ResourceGPU] != 1 {
		t.Fatalf("clean node: registrations %v conditions %v", kubelet.registrations(), m.Conditions())
	}

	// The GPU operator's device plugin is on.
	kubelet.mu.Lock()
	kubelet.allocatable = []ContainerDevices{{ResourceName: "nvidia.com/gpu", DeviceIDs: []string{"GPU-1"}}}
	kubelet.mu.Unlock()
	m.Sync(ctx)
	if got := conditionTypes(m); !reflect.DeepEqual(got, []string{ConditionForeignGpuExposure}) || len(m.plugins) != 0 || m.Advertised()[ResourceGPU] != 0 {
		t.Fatalf("with nvidia.com/gpu: conditions %v, plugins %d", got, len(m.plugins))
	}
	if _, err := os.Stat(filepath.Join(m.Dir, "bcd-gpu.sock")); !os.IsNotExist(err) {
		t.Fatalf("the plugin socket stayed: %v", err)
	}

	// Off again, but the toolkit takes NVIDIA_VISIBLE_DEVICES from any pod (the default when the key is absent).
	kubelet.mu.Lock()
	kubelet.allocatable = nil
	kubelet.mu.Unlock()
	sys.Set(ToolkitConfigs[1], "[nvidia-container-runtime]\nmode = \"cdi\"\n")
	m.Sync(ctx)
	if got := m.Conditions(); len(got) != 1 || got[0].Type != ConditionForeignGpuExposure || len(m.plugins) != 0 {
		t.Fatalf("toolkit default: %v", got)
	}
	sys.Set(ToolkitConfigs[1], "accept-nvidia-visible-devices-envvar-when-unprivileged = false\n")
	m.Sync(ctx)
	if len(m.Conditions()) != 0 || len(m.plugins) != 1 {
		t.Fatalf("closed again: conditions %v plugins %d", m.Conditions(), len(m.plugins))
	}
}

// Without the pod-resources socket released devices cannot be reclaimed: a condition while bcd holds
// devices for Kubernetes; and a node compute released from its cluster says so.
func TestManagerConditions(t *testing.T) {
	m, _, sys, _, _ := securityRig(t)
	ctx := context.Background()
	m.PodResources = filepath.Join(m.Dir, "absent.sock")
	m.Sync(ctx)
	if len(m.Conditions()) != 0 {
		t.Fatalf("no holds: %v", m.Conditions())
	}
	sys.Set(CDIDir+"/bcd-a1.json", holdFile("a1", BindingKubernetes, "GPU-1"))
	m.Sync(ctx)
	if got := conditionTypes(m); !reflect.DeepEqual(got, []string{ConditionPodResourcesUnavailable}) {
		t.Fatalf("conditions = %v", got)
	}
	sys.Set(StateFile, `{"server":"https://10.0.0.1:6443","nodeName":"n1","gpu":false,"released":true}`)
	m.Sync(ctx)
	if got := conditionTypes(m); !reflect.DeepEqual(got, []string{ConditionKubernetesReleased}) {
		t.Fatalf("released: %v", got)
	}
}
