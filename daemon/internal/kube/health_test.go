package kube

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
)

// A Kubernetes-bound GPU that goes bad (an XID, a failed row remap) is never offered as healthy: the
// device plugin re-lists it Unhealthy at once, the DRA slice drops it and prepare refuses it; its pods
// are not deleted for it (the device is still bound: only a release reaps).
func TestUnhealthyDevicesAreNeverOffered(t *testing.T) {
	dir, err := os.MkdirTemp("", "kh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	kubelet := startKubelet(t, dir)
	sys := hostconfig.NewFakeSystem()
	sys.Set(StateFile, `{"server":"https://10.0.0.1:6443","nodeName":"n1","gpu":true}`)
	sys.Set(CDIDir+"/bcd-a1.json", holdFile("a1", BindingKubernetes, "GPU-1", "GPU-2"))
	var mu sync.Mutex
	var slices []string
	sys.Handler = func(_ context.Context, cmd hostconfig.Cmd) ([]byte, error) {
		mu.Lock()
		defer mu.Unlock()
		switch cmd.Args[2] {
		case "api-versions":
			return []byte("resource.k8s.io/v1\n"), nil
		case "apply":
			slices = append(slices, string(cmd.Stdin))
		case "get":
			return []byte(`{"metadata":{"uid":"u1"},"status":{"allocation":{"devices":{"results":[{"request":"gpu","driver":"gpu.bcd.dev","pool":"n1","device":"gpu-2"}]}}}}`), nil
		}
		return nil, nil
	}
	var bad atomic.Value
	bad.Store("")
	var reaped []string
	m := &Manager{
		Sys: sys, Dir: dir, PodResources: filepath.Join(dir, "pod-resources.sock"),
		RegistryDir: filepath.Join(dir, "reg"), DRAPluginDir: filepath.Join(dir, "dra"),
		Healthy:   func(gpu string) bool { return gpu != bad.Load().(string) },
		DeletePod: func(_ context.Context, ns, name string) error { reaped = append(reaped, ns+"/"+name); return nil },
		Grace:     time.Millisecond,
	}
	ctx := context.Background()
	kubelet.mu.Lock()
	kubelet.podList = []PodResources{{Name: "train", Namespace: "ml", Containers: []ContainerResources{{Name: "main", Devices: []ContainerDevices{{ResourceName: ResourceGPU, DeviceIDs: []string{"GPU-2"}}}}}}}
	kubelet.mu.Unlock()
	m.Sync(ctx)
	t.Cleanup(m.stopAll)

	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := pluginClient[Empty, ListAndWatchResponse](dir, ResourceGPU, procListAndWatch).CallServerStream(sctx, connect.NewRequest(&Empty{}))
	if err != nil {
		t.Fatal(err)
	}
	health := func() map[string]string {
		t.Helper()
		if !stream.Receive() {
			t.Fatalf("stream ended: %v", stream.Err())
		}
		out := map[string]string{}
		for _, d := range stream.Msg().Devices {
			out[d.ID] = d.Health
		}
		return out
	}
	if got := health(); got["GPU-1"] != Healthy || got["GPU-2"] != Healthy {
		t.Fatalf("health = %v", got)
	}
	bad.Store("GPU-2")
	m.Sync(ctx)
	if got := health(); got["GPU-1"] != Healthy || got["GPU-2"] != Unhealthy {
		t.Fatalf("after the XID: %v", got)
	}
	time.Sleep(5 * time.Millisecond)
	m.Sync(ctx)
	if len(reaped) != 0 {
		t.Fatalf("a pod was deleted for an unhealthy but still bound device: %v", reaped)
	}

	// With DRA: the slice leaves the bad GPU out, and a claim allocated to it before is refused.
	sys.Set(StateFile, `{"server":"https://10.0.0.1:6443","nodeName":"n1","gpu":true,"gpuApi":"dra"}`)
	m.Sync(ctx)
	mu.Lock()
	last := slices[len(slices)-1]
	mu.Unlock()
	var slice struct {
		Spec struct {
			Devices []struct {
				Name string `json:"name"`
			} `json:"devices"`
		} `json:"spec"`
	}
	if err := json.Unmarshal([]byte(last), &slice); err != nil || len(slice.Spec.Devices) != 1 || slice.Spec.Devices[0].Name != "gpu-1" {
		t.Fatalf("slice = %s", last)
	}
	resp, err := draClient[ClaimsRequest, PrepareResponse](filepath.Join(dir, "dra", "dra.sock"), procPrepareV1).
		CallUnary(ctx, connect.NewRequest(&ClaimsRequest{Claims: []Claim{{Namespace: "ml", Name: "c1", UID: "u1"}}}))
	if err != nil || !strings.Contains(resp.Msg.Claims["u1"].Error, "unhealthy") {
		t.Fatalf("prepare = %+v, %v", resp, err)
	}
	// Healthy again: it comes back.
	bad.Store("")
	m.Sync(ctx)
	mu.Lock()
	last = slices[len(slices)-1]
	mu.Unlock()
	if !strings.Contains(last, `"gpu-2"`) {
		t.Fatalf("slice after recovery = %s", last)
	}
}
