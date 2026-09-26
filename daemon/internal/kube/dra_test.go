package kube

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
)

func draClient[Req, Res any](socket, proc string) *connect.Client[Req, Res] {
	return connect.NewClient[Req, Res](unixClient(socket), "http://localhost"+proc, connect.WithGRPC(), connect.WithCodec(codec{}))
}

// With gpuApi "dra": no device plugins; the node's ResourceSlice lists exactly the Kubernetes-bound
// devices; the kubelet registers the driver and prepares claims into CDI ids, refused for any device
// not bound here at that moment.
func TestDRADriver(t *testing.T) {
	dir, err := os.MkdirTemp("", "kdra")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	kubelet := startKubelet(t, dir)
	sys := hostconfig.NewFakeSystem()
	sys.Set(StateFile, `{"server":"https://10.0.0.1:6443","nodeName":"n1","gpu":true,"gpuApi":"dra"}`)
	sys.Set(CDIDir+"/bcd-a1.json", holdFile("a1", BindingKubernetes, "GPU-1", "GPU-2"))
	sys.Set(CDIDir+"/bcd-a2.json", holdFile("a2", "", "GPU-3"))
	var mu sync.Mutex
	var applied []map[string]any
	var deleted []string
	gpu1 := draDeviceName("GPU-1", "a1")
	claims := map[string]string{
		"c1": `{"metadata":{"uid":"u1"},"status":{"allocation":{"devices":{"results":[
			{"request":"gpu","driver":"gpu.bcd.dev","pool":"n1","device":"` + gpu1 + `"},
			{"request":"nic","driver":"other.example.com","pool":"n1","device":"nic-0"}]}}}}`,
		"c2": `{"metadata":{"uid":"u2"},"status":{"allocation":{"devices":{"results":[
			{"request":"gpu","driver":"gpu.bcd.dev","pool":"n1","device":"gpu-3"}]}}}}`,
		"c3": `{"metadata":{"uid":"u3-new"},"status":{"allocation":{"devices":{"results":[]}}}}`,
		"c5": `{"metadata":{"uid":"u5"},"status":{"allocation":{"devices":{"results":[
			{"request":"gpu","driver":"gpu.bcd.dev","pool":"n1","device":"` + gpu1 + `","adminAccess":true}]}}}}`,
		"c6": `{"metadata":{"uid":"u6"},"status":{"allocation":{"devices":{"results":[
			{"request":"gpu","driver":"gpu.bcd.dev","pool":"n1","device":"` + gpu1 + `"}]}}}}`,
	}
	sys.Handler = func(_ context.Context, cmd hostconfig.Cmd) ([]byte, error) {
		mu.Lock()
		defer mu.Unlock()
		args := cmd.Args[2:]
		switch args[0] {
		case "api-versions":
			return []byte("apps/v1\nresource.k8s.io/v1\nresource.k8s.io/v1beta1\nv1\n"), nil
		case "apply":
			var slice map[string]any
			if err := json.Unmarshal(cmd.Stdin, &slice); err != nil {
				return nil, err
			}
			applied = append(applied, slice)
		case "delete":
			deleted = append(deleted, strings.Join(args, " "))
		case "get":
			if body, ok := claims[args[4]]; ok && args[1] == "resourceclaim" {
				return []byte(body), nil
			}
			return nil, errors.New("NotFound")
		}
		return nil, nil
	}
	now := time.Unix(1_800_000_000, 0)
	m := &Manager{
		Sys: sys, Dir: dir, PodResources: filepath.Join(dir, "pod-resources.sock"),
		RegistryDir: filepath.Join(dir, "reg"), DRAPluginDir: filepath.Join(dir, "dra"),
		NUMA: func(string) (int64, bool) { return 1, true },
		Now:  func() time.Time { return now },
	}
	ctx := context.Background()
	m.Sync(ctx)
	t.Cleanup(m.stopAll)

	if regs := kubelet.registrations(); len(regs) != 0 {
		t.Fatalf("device plugins registered beside DRA: %+v", regs)
	}
	if len(applied) != 1 {
		t.Fatalf("slices applied = %d", len(applied))
	}
	spec := applied[0]["spec"].(map[string]any)
	if applied[0]["apiVersion"] != "resource.k8s.io/v1" || spec["driver"] != DRADriverName || spec["nodeName"] != "n1" ||
		applied[0]["metadata"].(map[string]any)["name"] != "n1-gpu.bcd.dev" || spec["pool"].(map[string]any)["name"] != "n1" {
		t.Fatalf("slice = %v", applied[0])
	}
	devices := spec["devices"].([]any)
	if len(devices) != 2 {
		t.Fatalf("devices = %v", devices)
	}
	first := devices[0].(map[string]any)
	attrs := first["attributes"].(map[string]any)
	if first["name"] != gpu1 || attrs["uuid"].(map[string]any)["string"] != "GPU-1" || attrs["allocation"].(map[string]any)["string"] != "a1" ||
		attrs["class"].(map[string]any)["string"] != "gpu" || attrs["numaNode"].(map[string]any)["int"] != 1.0 {
		t.Fatalf("device = %v", first)
	}
	// An unchanged pass publishes nothing.
	m.Sync(ctx)
	if len(applied) != 1 {
		t.Fatalf("an unchanged slice was applied again (%d)", len(applied))
	}

	// The kubelet finds the registrar, asks for its info and says it registered.
	info, err := draClient[InfoRequest, PluginInfo](filepath.Join(dir, "reg", "gpu.bcd.dev-reg.sock"), procGetInfo).CallUnary(ctx, connect.NewRequest(&InfoRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	want := PluginInfo{Type: "DRAPlugin", Name: "gpu.bcd.dev", Endpoint: filepath.Join(dir, "dra", "dra.sock"), SupportedVersions: []string{"v1.DRAPlugin", "v1beta1.DRAPlugin"}}
	if !reflect.DeepEqual(*info.Msg, want) {
		t.Fatalf("info = %+v", info.Msg)
	}
	if _, err := draClient[RegistrationStatus, RegistrationStatusResponse](filepath.Join(dir, "reg", "gpu.bcd.dev-reg.sock"), procNotifyRegistered).
		CallUnary(ctx, connect.NewRequest(&RegistrationStatus{PluginRegistered: true})); err != nil || !m.dra.registered.Load() {
		t.Fatalf("notify = %v, registered %v", err, m.dra.registered.Load())
	}

	prepare := func(proc string, claims ...Claim) map[string]ClaimResult {
		t.Helper()
		resp, err := draClient[ClaimsRequest, PrepareResponse](info.Msg.Endpoint, proc).CallUnary(ctx, connect.NewRequest(&ClaimsRequest{Claims: claims}))
		if err != nil {
			t.Fatal(err)
		}
		return resp.Msg.Claims
	}
	got := prepare(procPrepareV1,
		Claim{Namespace: "ml", Name: "c1", UID: "u1"},
		Claim{Namespace: "ml", Name: "c2", UID: "u2"},
		Claim{Namespace: "ml", Name: "c3", UID: "u3"},
		Claim{Namespace: "ml", Name: "gone", UID: "u4"})
	if !reflect.DeepEqual(got["u1"], ClaimResult{Devices: []PreparedDevice{{RequestNames: []string{"gpu"}, PoolName: "n1", DeviceName: gpu1, CDIDeviceIDs: []string{"bcd.dev/gpu=GPU-1"}}}}) {
		t.Fatalf("u1 = %+v", got["u1"])
	}
	for uid, want := range map[string]string{"u2": "not bound to Kubernetes", "u3": "is not the claim", "u4": "read ResourceClaim"} {
		if !strings.Contains(got[uid].Error, want) || len(got[uid].Devices) != 0 {
			t.Fatalf("%s = %+v", uid, got[uid])
		}
	}
	// The v1beta1 service answers the same.
	if got := prepare(procPrepareV1beta1, Claim{Namespace: "ml", Name: "c1", UID: "u1"}); got["u1"].Error != "" {
		t.Fatalf("v1beta1 = %+v", got["u1"])
	}
	// Admin access, and a second claim for a device prepared for u1, are refused (review round 5 #12).
	got = prepare(procPrepareV1, Claim{Namespace: "ml", Name: "c5", UID: "u5"}, Claim{Namespace: "ml", Name: "c6", UID: "u6"})
	if !strings.Contains(got["u5"].Error, "admin access") || !strings.Contains(got["u6"].Error, "prepared for claim u1") {
		t.Fatalf("u5 %+v u6 %+v", got["u5"], got["u6"])
	}
	unprep, err := draClient[ClaimsRequest, UnprepareResponse](info.Msg.Endpoint, procUnprepareV1).CallUnary(ctx, connect.NewRequest(&ClaimsRequest{Claims: []Claim{{UID: "u1"}}}))
	if err != nil || !reflect.DeepEqual(unprep.Msg.Claims, map[string]string{"u1": ""}) {
		t.Fatalf("unprepare = %+v, %v", unprep, err)
	}
	if got := prepare(procPrepareV1, Claim{Namespace: "ml", Name: "c6", UID: "u6"}); got["u6"].Error != "" {
		t.Fatalf("u6 after u1 let go = %+v", got["u6"])
	}
	unprepare := func(uid string) {
		t.Helper()
		if _, err := draClient[ClaimsRequest, UnprepareResponse](info.Msg.Endpoint, procUnprepareV1).CallUnary(ctx, connect.NewRequest(&ClaimsRequest{Claims: []Claim{{UID: uid}}})); err != nil {
			t.Fatal(err)
		}
	}
	// The record outlives bcd (security review 2 #2, #6): a restarted Manager still has gpu-1
	// prepared for u6, so a1 stays in use whatever pod-resources says.
	restarted := &Manager{Sys: sys, Dir: dir, PodResources: m.PodResources, RegistryDir: m.RegistryDir, DRAPluginDir: m.DRAPluginDir}
	restarted.init()
	if !restarted.dra.preparedWithSuffix(draDeviceName("", "a1")) || !restarted.InUse(ctx, "a1") {
		t.Fatal("the prepared record did not survive a restart")
	}
	// One claim per device, checked and recorded under one lock: of two concurrent prepares, one wins.
	unprepare("u6")
	var wg sync.WaitGroup
	var won atomic.Int32
	for _, c := range []Claim{{Namespace: "ml", Name: "c1", UID: "u1"}, {Namespace: "ml", Name: "c6", UID: "u6"}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := draClient[ClaimsRequest, PrepareResponse](info.Msg.Endpoint, procPrepareV1).CallUnary(ctx, connect.NewRequest(&ClaimsRequest{Claims: []Claim{c}}))
			if err == nil && resp.Msg.Claims[c.UID].Error == "" {
				won.Add(1)
			}
		}()
	}
	wg.Wait()
	if won.Load() != 1 {
		t.Fatalf("%d concurrent claims prepared gpu-1", won.Load())
	}
	unprepare("u1")
	unprepare("u6")
	if got := prepare(procPrepareV1, Claim{Namespace: "ml", Name: "c6", UID: "u6"}); got["u6"].Error != "" {
		t.Fatalf("u6 again = %+v", got["u6"])
	}

	// A pod holds gpu-1 through its claim when compute releases it.
	var reaped []string
	m.DeletePod = func(_ context.Context, ns, name string, _ bool) error {
		reaped = append(reaped, ns+"/"+name)
		return nil
	}
	kubelet.mu.Lock()
	kubelet.podList = []PodResources{
		{Name: "train", Namespace: "ml", Containers: []ContainerResources{{Name: "main", Claimed: []ClaimedDevice{{Driver: DRADriverName, Pool: "n1", Device: gpu1}}}}},
		{Name: "other", Namespace: "ml", Containers: []ContainerResources{{Name: "main", Claimed: []ClaimedDevice{{Driver: "other.example.com", Pool: "n1", Device: gpu1}}}}},
	}
	kubelet.mu.Unlock()
	m.Sync(ctx)
	if len(reaped) != 0 {
		t.Fatalf("reaped a pod whose device is still bound: %v", reaped)
	}

	// Released: prepare refuses at once (it reads the holds itself), and the next pass empties the slice.
	sys.Delete(CDIDir + "/bcd-a1.json")
	if got := prepare(procPrepareV1, Claim{Namespace: "ml", Name: "c1", UID: "u1"}); !strings.Contains(got["u1"].Error, "not bound") {
		t.Fatalf("after the release = %+v", got["u1"])
	}
	m.Sync(ctx)
	if len(deleted) != 1 || !strings.Contains(deleted[0], "resourceslice n1-gpu.bcd.dev") {
		t.Fatalf("deleted = %v", deleted)
	}
	now = now.Add(31 * time.Second)
	m.Sync(ctx)
	if !reflect.DeepEqual(reaped, []string{"ml/train"}) {
		t.Fatalf("reaped = %v", reaped)
	}
	kubelet.mu.Lock()
	kubelet.podList = nil
	kubelet.mu.Unlock()
	// No pod lists gpu-1 now, but u6 is still prepared: a1 is in use until the kubelet unprepares it.
	if !m.InUse(ctx, "a1") {
		t.Fatal("a device still prepared for a claim counted as free")
	}
	unprepare("u6")
	if m.InUse(ctx, "a1") {
		t.Fatal("a1 in use after its claim was unprepared")
	}
	// An unreadable record fails closed.
	if err := os.WriteFile(filepath.Join(dir, "dra", "prepared.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if again := (&Manager{Sys: sys, Dir: dir, PodResources: m.PodResources, DRAPluginDir: m.DRAPluginDir}); !again.InUse(ctx, "a1") {
		t.Fatal("an unreadable prepared record counted as nothing prepared")
	}

	// Back to the device plugins: the DRA sockets go.
	sys.Set(StateFile, `{"server":"https://10.0.0.1:6443","nodeName":"n1","gpu":true}`)
	sys.Set(CDIDir+"/bcd-a1.json", holdFile("a1", BindingKubernetes, "GPU-1"))
	m.Sync(ctx)
	if _, err := os.Stat(info.Msg.Endpoint); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the DRA socket stayed: %v", err)
	}
	if regs := kubelet.registrations(); len(regs) != 1 {
		t.Fatalf("device plugin registrations = %+v", regs)
	}
}

func TestResourceSliceV1beta1(t *testing.T) {
	body, _ := resourceSlice("resource.k8s.io/v1beta1", "n1", 7, map[string]map[string]atom{
		ResourceGPUMig: {"GPU-1_gi1_ci0@a1": {id: "GPU-1_gi1_ci0", allocation: "a1", visible: "MIG-x", healthy: true}},
		ResourceGPU:    {"GPU-2@a1": {id: "GPU-2", allocation: "a1", healthy: false}},
	})
	var slice struct {
		Spec struct {
			Pool    map[string]any   `json:"pool"`
			Devices []map[string]any `json:"devices"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(body, &slice); err != nil {
		t.Fatal(err)
	}
	if len(slice.Spec.Devices) != 1 || slice.Spec.Devices[0]["name"] != draDeviceName("GPU-1_gi1_ci0", "a1") || slice.Spec.Pool["generation"] != 7.0 {
		t.Fatalf("slice = %s", body)
	}
	attrs := slice.Spec.Devices[0]["basic"].(map[string]any)["attributes"].(map[string]any)
	if attrs["class"].(map[string]any)["string"] != "gpu.mig" || attrs["visibleDevice"].(map[string]any)["string"] != "MIG-x" {
		t.Fatalf("attributes = %v", attrs)
	}
}
