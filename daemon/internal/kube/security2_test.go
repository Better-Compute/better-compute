package kube

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// Security review 2 #1: InUse fails closed on any node that is or was a worker, and false only on
// one that never was.
func TestInUseFailsClosedOnFormerWorkers(t *testing.T) {
	m, _, sys, _, _ := securityRig(t)
	ctx := context.Background()
	m.PodResources = filepath.Join(m.Dir, "absent.sock")
	for name, state := range map[string]string{
		"released": `{"server":"https://10.0.0.1:6443","nodeName":"n1","released":true}`,
		"gpu off":  `{"server":"https://10.0.0.1:6443","nodeName":"n1","gpu":false}`,
		"garbled":  `{`,
	} {
		sys.Set(StateFile, state)
		if !m.InUse(ctx, "a1") {
			t.Errorf("%s: a worker whose kubelet cannot be asked answered not in use", name)
		}
	}
	sys.Delete(StateFile)
	if m.InUse(ctx, "a1") {
		t.Fatal("a node that never was a worker holds nothing for Kubernetes")
	}
	// A kubelet configuration (installed outside bcd) makes it a worker too.
	sys.Set(kubeletConfigYAML, "kind: KubeletConfiguration\n")
	if !m.InUse(ctx, "a1") {
		t.Fatal("a node with a kubelet configuration answered not in use without asking it")
	}
	sys.Delete(kubeletConfigYAML)
	m.Hosted = true
	if !m.InUse(ctx, "a1") {
		t.Fatal("a hosted node answered not in use without asking its kubelet")
	}
}

// Security review 2 #1: the reaper keeps running once compute released the machine, and deletes
// every pod still holding a bcd.dev device, DaemonSet pods included (pod-resources does not say who
// owns a pod), gracefully first, then forced.
func TestReaperRunsAfterRelease(t *testing.T) {
	m, kubelet, sys, now, reaped := securityRig(t)
	ctx := context.Background()
	sys.Set(CDIDir+"/bcd-a1.json", holdFile("a1", BindingKubernetes, "GPU-1"))
	kubelet.mu.Lock()
	kubelet.podList = []PodResources{{Name: "ds-miner", Namespace: "kube-system", Containers: []ContainerResources{{Name: "main",
		Devices: []ContainerDevices{{ResourceName: ResourceGPU, DeviceIDs: []string{"GPU-1@a1"}}}}}}}
	kubelet.mu.Unlock()
	m.Sync(ctx)
	// Released: gpu off, the hold gone, the plugins stopped.
	sys.Set(StateFile, `{"server":"https://10.0.0.1:6443","nodeName":"n1","released":true}`)
	sys.Delete(CDIDir + "/bcd-a1.json")
	m.Sync(ctx)
	*now = now.Add(31 * time.Second)
	m.Sync(ctx)
	*now = now.Add(61 * time.Second)
	m.Sync(ctx)
	if !reflect.DeepEqual(*reaped, []reapCall{{"kube-system/ds-miner", false}, {"kube-system/ds-miner", true}}) {
		t.Fatalf("reaped after release = %v", *reaped)
	}
	if len(kubelet.registrations()) == 0 {
		t.Fatal("the plugin never registered")
	}
}

// Security review 2 #1: a pod process with a released whole GPU's device node open keeps it in use
// even when pod-resources lists nothing (a static pod, a lost checkpoint); host processes do not.
func TestInUseProcessBackstop(t *testing.T) {
	m, _, _, _, _ := securityRig(t)
	ctx := context.Background()
	proc := t.TempDir()
	m.ProcRoot = proc
	write := func(rel, content string) {
		p := filepath.Join(proc, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("driver/nvidia/gpus/0000:18:00.0/information", "Model: \t\t NVIDIA H100\nGPU UUID: \t GPU-1\nDevice Minor: \t 3\n")
	write("driver/nvidia/gpus/0000:2a:00.0/information", "GPU UUID: \t GPU-2\nDevice Minor: \t 4\n")
	write("4242/cgroup", "0::/kubepods.slice/kubepods-besteffort.slice/cri-containerd-x.scope\n")
	if err := os.MkdirAll(filepath.Join(proc, "4242", "fd"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/dev/nvidia3", filepath.Join(proc, "4242", "fd", "7")); err != nil {
		t.Fatal(err)
	}
	if !m.InUseDevices(ctx, "a1", []string{"GPU-1"}) {
		t.Fatal("a pod process with GPU-1 open did not keep it in use")
	}
	// Another GPU, or a MIG instance of it (its device node is shared), is not evidence.
	if m.InUseDevices(ctx, "a2", []string{"GPU-2"}) || m.InUseDevices(ctx, "a3", []string{"GPU-1/gi1/ci0"}) {
		t.Fatal("the backstop matched a GPU the process does not hold, or a MIG instance")
	}
	// A host process (nvidia-persistenced) is not a pod.
	write("4242/cgroup", "0::/system.slice/nvidia-persistenced.service\n")
	if m.InUseDevices(ctx, "a1", []string{"GPU-1"}) {
		t.Fatal("a host daemon holding the GPU counted as a pod")
	}
}
