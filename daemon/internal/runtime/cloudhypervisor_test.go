package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// fakeCH stands in for cloud-hypervisor VMMs (one per API socket, started by systemd-run) and their
// REST API; qemu-img and genisoimage come from fakeVirt.
type fakeCH struct {
	virt  *fakeVirt
	mu    sync.Mutex
	vmms  map[string]*fakeVMM
	calls []string
}

type fakeVMM struct {
	config json.RawMessage
	state  string // "" (no VM), Created, Running, Paused, Shutdown
}

func (f *fakeCH) exec(ctx context.Context, name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	switch name {
	case "systemd-run":
		f.calls = append(f.calls, "systemd-run "+args[0])
		for _, a := range args {
			if strings.HasPrefix(a, "path=") {
				f.vmms[strings.TrimPrefix(a, "path=")] = &fakeVMM{}
			}
		}
		f.mu.Unlock()
		return nil, nil
	case "systemctl", "ip":
		f.calls = append(f.calls, name+" "+strings.Join(args, " "))
		f.mu.Unlock()
		return nil, nil
	}
	f.mu.Unlock()
	return f.virt.exec(ctx, name, args...)
}

func (f *fakeCH) api(_ context.Context, socket, method, path string, body any) ([]byte, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	vmm := f.vmms[socket]
	if vmm == nil {
		return nil, 0, errors.New("connect: no such file or directory")
	}
	op := strings.TrimPrefix(path, "/api/v1/")
	f.calls = append(f.calls, method+" "+op)
	switch op {
	case "vmm.ping":
		return []byte(`{"version":"v43.0"}`), 200, nil
	case "vm.info":
		if vmm.state == "" {
			return []byte("VM is not created"), 500, nil
		}
		return []byte(`{"state":"` + vmm.state + `"}`), 200, nil
	case "vm.create":
		vmm.config, _ = json.Marshal(body)
		vmm.state = "Created"
	case "vm.boot":
		if vmm.state == "" {
			return nil, 500, nil
		}
		vmm.state = "Running"
	case "vm.pause":
		vmm.state = "Paused"
	case "vm.resume":
		vmm.state = "Running"
	case "vm.power-button", "vm.shutdown":
		vmm.state = "Shutdown"
	case "vmm.shutdown":
		delete(f.vmms, socket)
	case "vm.resize-disk":
	case "vm.snapshot":
		dst := strings.TrimPrefix(body.(map[string]any)["destination_url"].(string), "file://")
		_ = os.WriteFile(filepath.Join(dst, "config.json"), vmm.config, 0o600)
		_ = os.WriteFile(filepath.Join(dst, "state.json"), []byte(`{"cpu":"state"}`), 0o600)
		_ = os.WriteFile(filepath.Join(dst, "memory-ranges"), []byte("guest memory"), 0o600)
	case "vm.restore":
		src := strings.TrimPrefix(body.(map[string]any)["source_url"].(string), "file://")
		cfg, err := os.ReadFile(filepath.Join(src, "config.json"))
		if err != nil {
			return nil, 500, nil
		}
		vmm.config, vmm.state = cfg, "Paused"
	default:
		return nil, 404, nil
	}
	return nil, 204, nil
}

func TestCloudHypervisorRuntime(t *testing.T) {
	image := []byte("ubuntu base image")
	sum := sha256.Sum256(image)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(image) }))
	defer srv.Close()
	ch := &fakeCH{virt: &fakeVirt{domains: map[string]*fakeDomain{}}, vmms: map[string]*fakeVMM{}}
	dir := t.TempDir()
	c := &CloudHypervisor{Dir: dir, Exec: ch.exec, API: ch.api, HTTP: srv.Client(), Poll: 1, ShutdownTimeout: 1,
		GPUAddress: func(id string) (string, bool) { return map[string]string{"GPU-1": "0000:3b:00.0"}[id], id == "GPU-1" }}
	ctx := context.Background()
	spec := &agentv1.InstanceSpec{
		InstanceId: "inst_web", Runtime: "cloud-hypervisor", AllocationId: "alloc_1", Vcpu: 4, MemoryBytes: 8 << 30, DiskBytes: 40 << 30,
		Image:        &agentv1.ImageRef{Ref: "ubuntu", Url: srv.URL + "/ubuntu.qcow2", Sha256: sum[:], Format: "qcow2"},
		GpuDeviceIds: []string{"GPU-1"},
		Nics:         []*agentv1.InstanceNic{{Network: "br0", Mac: "52:54:00:00:00:07", Addresses: []string{"10.0.0.7/24"}}},
	}
	if err := c.Ensure(ctx, spec, []byte("#cloud-config\nhostname: web\n"), nil); err != nil {
		t.Fatal(err)
	}
	web := filepath.Join(dir, "instances", "inst_web")
	indented, _ := os.ReadFile(filepath.Join(web, "vm.json"))
	var compact bytes.Buffer
	_ = json.Compact(&compact, indented)
	rec := compact.Bytes()
	for _, want := range []string{
		filepath.Join(web, "disk.qcow2"), `"tap":"` + TapName("inst_web", 0) + `"`, `"mac":"52:54:00:00:00:07"`,
		`/sys/bus/pci/devices/0000:3b:00.0/`, `"boot_vcpus":4`, `CLOUDHV.fd`, filepath.Join(web, "serial.sock"), `"readonly":true`,
	} {
		if !strings.Contains(string(rec), strings.ReplaceAll(want, `\`, `\\`)) {
			t.Errorf("vm.json lacks %s:\n%s", want, rec)
		}
	}
	if seed, _ := os.ReadFile(filepath.Join(web, "seed.iso")); !bytes.Contains(seed, []byte("hostname: web")) {
		t.Fatalf("seed = %q", seed)
	}
	// A directory bcd did not write is not bcd's.
	_ = os.MkdirAll(filepath.Join(dir, "instances", "someone-elses"), 0o700)
	if c.Ensure(ctx, &agentv1.InstanceSpec{InstanceId: "someone-elses"}, nil, nil) == nil || c.Destroy(ctx, "someone-elses") == nil {
		t.Fatal("a foreign instance was touched")
	}
	domains, err := c.List(ctx)
	if err != nil || len(domains) != 1 || !domains[0].Managed || domains[0].State != StateStopped || domains[0].AllocationID != "alloc_1" || domains[0].Addresses[0] != "10.0.0.7/24" {
		t.Fatalf("list = %+v, %v", domains, err)
	}

	// States: a VMM unit, the VM created and booted, its tap on its bridge.
	for _, want := range []string{StateRunning, StatePaused, StateRunning} {
		if err := c.SetState(ctx, "inst_web", want); err != nil {
			t.Fatal(err)
		}
		if got, _ := c.state(ctx, "inst_web"); got != want {
			t.Fatalf("state = %s, want %s", got, want)
		}
	}
	calls := strings.Join(ch.calls, "\n")
	for _, want := range []string{"systemd-run --unit=bcd-ch-inst_web", "PUT vm.create", "PUT vm.boot", "ip link set " + TapName("inst_web", 0) + " master br0"} {
		if !strings.Contains(calls, want) {
			t.Fatalf("calls lack %q:\n%s", want, calls)
		}
	}

	// A memory snapshot of the running VM: paused for it, then carries on.
	var snap bytes.Buffer
	cpu, err := c.Snapshot(ctx, "inst_web", true, "AMD EPYC 9654", &snap)
	if err != nil || cpu != "AMD EPYC 9654" {
		t.Fatalf("Snapshot = %q, %v", cpu, err)
	}
	names := tarNames(t, snap.Bytes())
	for _, n := range []string{"meta.json", "disk.qcow2", "seed.iso", "ch/config.json", "ch/state.json", "ch/memory-ranges"} {
		if _, ok := names[n]; !ok {
			t.Fatalf("snapshot lacks %s: %v", n, names)
		}
	}
	if got, _ := c.state(ctx, "inst_web"); got != StateRunning {
		t.Fatalf("after the snapshot: %s", got)
	}

	// Restored into a clone: its config points at the clone's own disk, tap and console.
	file := filepath.Join(t.TempDir(), "snap.tar")
	_ = os.WriteFile(file, snap.Bytes(), 0o600)
	clone := &agentv1.InstanceSpec{InstanceId: "inst_clone", Vcpu: 4, MemoryBytes: 8 << 30, DiskBytes: 40 << 30,
		Nics: []*agentv1.InstanceNic{{Network: "br0", Mac: "52:54:00:00:00:08"}}}
	if err := c.Ensure(ctx, clone, nil, &Restore{Path: file, Sha256: "ab", CPUModel: "Intel Xeon"}); err == nil {
		t.Fatal("a memory snapshot restored on another CPU model")
	}
	if err := c.Ensure(ctx, clone, nil, &Restore{Path: file, Sha256: "ab", CPUModel: "AMD EPYC 9654"}); err != nil {
		t.Fatal(err)
	}
	cfg, _ := os.ReadFile(filepath.Join(dir, "instances", "inst_clone", "snapshot", "config.json"))
	if !strings.Contains(string(cfg), "inst_clone") || strings.Contains(string(cfg), filepath.Join("instances", "inst_web")) ||
		!strings.Contains(string(cfg), TapName("inst_clone", 0)) {
		t.Fatalf("restored config = %s", cfg)
	}
	if err := c.SetState(ctx, "inst_clone", StateRunning); err != nil {
		t.Fatal(err)
	}
	if got, _ := c.state(ctx, "inst_clone"); got != StateRunning {
		t.Fatalf("clone = %s", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "instances", "inst_clone", "snapshot")); err == nil {
		t.Fatal("the used memory snapshot was kept")
	}

	// Stop: power button, shutdown, the VMM and its unit go; then destroyed.
	if err := c.SetState(ctx, "inst_web", StateStopped); err != nil {
		t.Fatal(err)
	}
	if got, _ := c.state(ctx, "inst_web"); got != StateStopped || !strings.Contains(strings.Join(ch.calls, "\n"), "systemctl stop bcd-ch-inst_web") {
		t.Fatalf("stop: %s", got)
	}
	if err := c.Destroy(ctx, "inst_web"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(web); err == nil {
		t.Fatal("the instance directory survived")
	}
}
