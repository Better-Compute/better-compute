package kube

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
)

// fakeKubelet serves the Registration and PodResourcesLister services on unix sockets, and talks
// to the plugins as the kubelet does.
type fakeKubelet struct {
	t    *testing.T
	dir  string
	srv  *http.Server
	pods *http.Server

	mu         sync.Mutex
	registered []RegisterRequest
	podList    []PodResources
}

func startKubelet(t *testing.T, dir string) *fakeKubelet {
	k := &fakeKubelet{t: t, dir: dir}
	k.start()
	t.Cleanup(k.close)
	return k
}

func (k *fakeKubelet) start() {
	opts := connect.WithCodec(codec{})
	mux := http.NewServeMux()
	mux.Handle(procRegister, connect.NewUnaryHandler(procRegister, func(_ context.Context, req *connect.Request[RegisterRequest]) (*connect.Response[Empty], error) {
		k.mu.Lock()
		k.registered = append(k.registered, *req.Msg)
		k.mu.Unlock()
		return connect.NewResponse(&Empty{}), nil
	}, opts))
	k.srv = serveUnix(k.t, filepath.Join(k.dir, kubeletSocketName), mux)
	pods := http.NewServeMux()
	pods.Handle(procListPodResources, connect.NewUnaryHandler(procListPodResources, func(context.Context, *connect.Request[ListPodResourcesRequest]) (*connect.Response[ListPodResourcesResponse], error) {
		k.mu.Lock()
		defer k.mu.Unlock()
		return connect.NewResponse(&ListPodResourcesResponse{Pods: k.podList}), nil
	}, opts))
	k.pods = serveUnix(k.t, filepath.Join(k.dir, "pod-resources.sock"), pods)
}

func (k *fakeKubelet) close() {
	k.srv.Close()
	k.pods.Close()
}

// restart is a kubelet restart: every socket in the directory goes, the kubelet's comes back.
func (k *fakeKubelet) restart() {
	k.close()
	entries, _ := os.ReadDir(k.dir)
	for _, e := range entries {
		os.Remove(filepath.Join(k.dir, e.Name()))
	}
	time.Sleep(10 * time.Millisecond) // a new socket gets a new modification time
	k.start()
}

func (k *fakeKubelet) registrations() []RegisterRequest {
	k.mu.Lock()
	defer k.mu.Unlock()
	return append([]RegisterRequest(nil), k.registered...)
}

func serveUnix(t *testing.T, path string, h http.Handler) *http.Server {
	t.Helper()
	os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h, Protocols: h2c()}
	go srv.Serve(ln)
	return srv
}

func pluginClient[Req, Res any](dir, resource, proc string) *connect.Client[Req, Res] {
	return connect.NewClient[Req, Res](unixClient(filepath.Join(dir, socketName(resource))), "http://localhost"+proc, connect.WithGRPC(), connect.WithCodec(codec{}))
}

func holdFile(allocation string, binding string, devices ...string) string {
	s := `{"cdiVersion":"0.6.0","kind":"bcd.dev/gpu","annotations":{"bcd.dev/allocation-id":"` + allocation + `"`
	if binding != "" {
		s += `,"bcd.dev/binding":"` + binding + `"`
	}
	s += `},"devices":[`
	for i, d := range devices {
		if i > 0 {
			s += ","
		}
		s += `{"name":"` + d + `","containerEdits":{"env":["NVIDIA_VISIBLE_DEVICES=` + d + `"]}}`
	}
	return s + `],"containerEdits":{"env":["BCD_ALLOCATION_ID=` + allocation + `"]}}`
}

const nvidiaYAML = `---
cdiVersion: 0.5.0
containerEdits:
  deviceNodes:
  - path: /dev/nvidiactl
devices:
- containerEdits:
    deviceNodes:
    - path: /dev/nvidia0
  name: GPU-1
- name: GPU-2
  containerEdits:
    deviceNodes:
    - path: /dev/nvidia1
- name: MIG-aaaa
kind: nvidia.com/gpu
`

func TestDevicePlugin(t *testing.T) {
	dir, err := os.MkdirTemp("", "kdp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	kubelet := startKubelet(t, dir)
	sys := hostconfig.NewFakeSystem()
	sys.Set(StateFile, `{"server":"https://10.0.0.1:6443","nodeName":"n1","labels":[],"taints":[],"gpu":true}`)
	sys.Set(CDIDir+"/bcd-a1.json", holdFile("a1", BindingKubernetes, "GPU-1", "GPU-2"))
	sys.Set(CDIDir+"/bcd-a2.json", holdFile("a2", "", "GPU-3")) // a plain hold: never advertised
	sys.Set(CDIDir+"/bcd-a3.json", holdFile("a3", BindingKubernetes, "GPU-4/gi1/ci0"))
	sys.Set(cdiRunDir+"/nvidia.yaml", nvidiaYAML)
	now := time.Unix(1_800_000_000, 0)
	var deleted []string
	m := &Manager{
		Sys:          sys,
		Dir:          dir,
		PodResources: filepath.Join(dir, "pod-resources.sock"),
		MigUUID: func(atom string) string {
			if atom == "GPU-4/gi1/ci0" {
				return "MIG-aaaa"
			}
			return ""
		},
		NUMA:    func(gpu string) (int64, bool) { return map[string]int64{"GPU-1": 0, "GPU-2": 1}[gpu], gpu != "GPU-4" },
		Healthy: func(gpu string) bool { return gpu != "GPU-2" },
		DeletePod: func(_ context.Context, ns, name string) error {
			deleted = append(deleted, ns+"/"+name)
			return nil
		},
		Now: func() time.Time { return now },
	}
	ctx := context.Background()
	m.Sync(ctx)
	t.Cleanup(m.stopAll)

	regs := kubelet.registrations()
	if len(regs) != 2 || regs[0].ResourceName != ResourceGPU || regs[0].Endpoint != "bcd-gpu.sock" || regs[0].Version != "v1beta1" ||
		regs[1].ResourceName != ResourceGPUMig || !regs[0].Options.GetPreferredAllocationAvailable {
		t.Fatalf("registrations = %+v", regs)
	}

	// ListAndWatch: exactly the Kubernetes-bound GPUs, with health and NUMA.
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := pluginClient[Empty, ListAndWatchResponse](dir, ResourceGPU, procListAndWatch).CallServerStream(sctx, connect.NewRequest(&Empty{}))
	if err != nil {
		t.Fatal(err)
	}
	next := func() []*Device {
		t.Helper()
		if !stream.Receive() {
			t.Fatalf("stream ended: %v", stream.Err())
		}
		return stream.Msg().Devices
	}
	first := next()
	if len(first) != 2 || !reflect.DeepEqual(*first[0], Device{ID: "GPU-1", Health: Healthy, NUMA: []int64{0}}) || first[1].ID != "GPU-2" || first[1].Health != Unhealthy || !reflect.DeepEqual(first[1].NUMA, []int64{1}) {
		t.Fatalf("devices = %+v %+v", first[0], first[1])
	}

	allocate := pluginClient[AllocateRequest, AllocateResponse](dir, ResourceGPU, procAllocate)
	resp, err := allocate.CallUnary(ctx, connect.NewRequest(&AllocateRequest{ContainerRequests: [][]string{{"GPU-2", "GPU-1"}}}))
	if err != nil {
		t.Fatal(err)
	}
	c := resp.Msg.ContainerResponses[0]
	if !reflect.DeepEqual(c.CDIDevices, []string{"bcd.dev/gpu=GPU-2", "nvidia.com/gpu=GPU-2", "bcd.dev/gpu=GPU-1", "nvidia.com/gpu=GPU-1"}) ||
		c.Envs["NVIDIA_VISIBLE_DEVICES"] != "GPU-1,GPU-2" || c.Envs["BCD_ALLOCATION_IDS"] != "a1" || c.Annotations["bcd.dev/allocation-ids"] != "a1" {
		t.Fatalf("allocate = %+v", c)
	}
	_, err = allocate.CallUnary(ctx, connect.NewRequest(&AllocateRequest{ContainerRequests: [][]string{{"GPU-3"}}}))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("allocating a plain hold's GPU = %v", err)
	}
	mig, err := pluginClient[AllocateRequest, AllocateResponse](dir, ResourceGPUMig, procAllocate).CallUnary(ctx, connect.NewRequest(&AllocateRequest{ContainerRequests: [][]string{{"GPU-4/gi1/ci0"}}}))
	if err != nil || !reflect.DeepEqual(mig.Msg.ContainerResponses[0].CDIDevices, []string{"bcd.dev/gpu=GPU-4/gi1/ci0", "nvidia.com/gpu=MIG-aaaa"}) ||
		mig.Msg.ContainerResponses[0].Envs["NVIDIA_VISIBLE_DEVICES"] != "MIG-aaaa" {
		t.Fatalf("MIG allocate = %+v, %v", mig, err)
	}

	pref, err := pluginClient[PreferredAllocationRequest, PreferredAllocationResponse](dir, ResourceGPU, procGetPreferredAlloc).CallUnary(ctx,
		connect.NewRequest(&PreferredAllocationRequest{ContainerRequests: []*ContainerPreferredAllocationRequest{
			{AvailableDeviceIDs: []string{"GPU-2", "GPU-1"}, MustIncludeDeviceIDs: []string{"GPU-2"}, AllocationSize: 2},
		}}))
	if err != nil || !reflect.DeepEqual(pref.Msg.ContainerResponses, [][]string{{"GPU-2", "GPU-1"}}) {
		t.Fatalf("preferred = %+v, %v", pref, err)
	}

	// A pod keeps GPU-1 after compute releases a1: the plugin withdraws the devices at once and the
	// pod is deleted after the grace period, not before.
	kubelet.mu.Lock()
	kubelet.podList = []PodResources{
		{Name: "train", Namespace: "ml", Containers: []ContainerResources{{Name: "main", Devices: []ContainerDevices{{ResourceName: ResourceGPU, DeviceIDs: []string{"GPU-1"}}}}}},
		{Name: "other", Namespace: "ml", Containers: []ContainerResources{{Name: "main", Devices: []ContainerDevices{{ResourceName: "nvidia.com/gpu", DeviceIDs: []string{"GPU-9"}}}}}},
	}
	kubelet.mu.Unlock()
	sys.Delete(CDIDir + "/bcd-a1.json")
	m.Sync(ctx)
	if devices := next(); len(devices) != 0 {
		t.Fatalf("after the release: %+v", devices)
	}
	if len(deleted) != 0 {
		t.Fatal("deleted a pod before the grace period")
	}
	now = now.Add(31 * time.Second)
	m.Sync(ctx)
	if !reflect.DeepEqual(deleted, []string{"ml/train"}) {
		t.Fatalf("deleted = %v", deleted)
	}

	// A kubelet restart removes the sockets: the plugins come back and register again.
	kubelet.restart()
	m.Sync(ctx)
	if n := len(kubelet.registrations()); n != 4 {
		t.Fatalf("registrations after a kubelet restart = %d", n)
	}
	if _, err := os.Stat(filepath.Join(dir, "bcd-gpu.mig.sock")); err != nil {
		t.Fatal(err)
	}
	m.Sync(ctx)
	if n := len(kubelet.registrations()); n != 4 {
		t.Fatalf("a steady pass registered again (%d)", n)
	}

	// gpu: false (or a node bcd did not join) stops the plugins.
	sys.Set(StateFile, `{"server":"https://10.0.0.1:6443","nodeName":"n1","gpu":false}`)
	m.Sync(ctx)
	if _, err := os.Stat(filepath.Join(dir, "bcd-gpu.mig.sock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the plugin socket stayed: %v", err)
	}
}

func TestResourceOf(t *testing.T) {
	for atom, want := range map[string]string{
		"GPU-1":          ResourceGPU,
		"GPU-1/gi2/ci0":  ResourceGPUMig,
		"GPU-1_gi2_ci0":  ResourceGPUMig,
		"GPU-1/s3":       ResourceGPUSlot,
		"GPU-abc-s3-def": ResourceGPU,
	} {
		if got := ResourceOf(atom); got != want {
			t.Errorf("ResourceOf(%s) = %s", atom, got)
		}
	}
	if GPUOf("GPU-1/gi2/ci0") != "GPU-1" || GPUOf("GPU-1") != "GPU-1" {
		t.Fatal("GPUOf")
	}
}
