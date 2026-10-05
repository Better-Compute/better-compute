package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// The shape nvidia-ctk cdi generate --format=json --device-name-strategy=uuid writes.
const nvidiaSpec = `{"cdiVersion":"0.7.0","kind":"nvidia.com/gpu",
 "devices":[
  {"name":"GPU-a","containerEdits":{"deviceNodes":[{"path":"/dev/nvidia0"},{"path":"/dev/dri/card1"}]}},
  {"name":"MIG-a10","containerEdits":{"deviceNodes":[{"path":"/dev/nvidia0"},{"path":"/dev/nvidia-caps/nvidia-cap21"}]}},
  {"name":"GPU-b","containerEdits":{"deviceNodes":[{"path":"/dev/nvidia1"}]}}],
 "containerEdits":{
  "env":["NVIDIA_VISIBLE_DEVICES=void"],
  "deviceNodes":[{"path":"/dev/nvidiactl"},{"path":"/dev/nvidia-uvm"}],
  "hooks":[{"hookName":"createContainer","path":"/usr/bin/nvidia-cdi-hook","args":["nvidia-cdi-hook","update-ldcache","--folder","/usr/lib/x86_64-linux-gnu"]}],
  "mounts":[{"hostPath":"/usr/lib/x86_64-linux-gnu/libcuda.so.580.65.06","containerPath":"/usr/lib/x86_64-linux-gnu/libcuda.so.580.65.06","options":["ro","nosuid","nodev","bind"]}],
  "additionalGids":[44]}}`

func vendorRoot(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for name, body := range files {
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestHoldSpecCarriesNvidiaEdits(t *testing.T) {
	root := vendorRoot(t, map[string]string{
		"etc/cdi/nvidia.json": nvidiaSpec,
		// Ignored: bcd's own holds, YAML, other vendors.
		"etc/cdi/bcd-alloc_1.json": `{"kind":"bcd.dev/gpu","devices":[{"name":"GPU-a"}]}`,
		"etc/cdi/nvidia.yaml":      "cdiVersion: 0.5.0\nkind: nvidia.com/gpu\n",
		"etc/cdi/nic.json":         `{"kind":"mellanox.com/nic","devices":[{"name":"GPU-a"}]}`,
	})
	vendor := loadVendorCDI(root)
	if vendor == nil || len(vendor.devices) != 3 {
		t.Fatalf("vendor = %+v", vendor)
	}
	inv := holdInventory()
	as := &agentv1.DeviceAssignment{AllocationId: "alloc_9", ReservationId: "rsv_9",
		Devices: []*agentv1.AssignedDevice{dev("GPU-a/gi1/ci0", "gpu.mig"), dev("GPU-b/s0", "gpu.slot"), dev("GPU-b/s1", "gpu.slot")}}
	var atoms []atom
	for _, d := range as.GetDevices() {
		a, _, _ := resolveAtom(inv, d)
		atoms = append(atoms, a)
	}
	spec := newCDISpec(as, 7, atoms, false, vendor)
	raw, _ := json.Marshal(spec)
	out := string(raw)
	// The vendor's version (additionalGids need 0.7), its common edits once, minus its "void".
	if spec.CdiVersion != "0.7.0" || strings.Contains(out, "void") || strings.Count(out, `"/dev/nvidiactl"`) != 1 ||
		!strings.Contains(out, "update-ldcache") || !strings.Contains(out, "libcuda.so.580.65.06") ||
		len(spec.ContainerEdits.AdditionalGIDs) != 1 || !strings.Contains(out, `"NVIDIA_VISIBLE_DEVICES=MIG-a10,GPU-b"`) {
		t.Fatalf("spec: %s", out)
	}
	// Each device gets exactly its own nodes: the MIG instance its cap, the slots their GPU's.
	nodes := func(i int) string {
		b, _ := json.Marshal(spec.Devices[i].ContainerEdits.DeviceNodes)
		return string(b)
	}
	if nodes(0) != `[{"path":"/dev/nvidia0"},{"path":"/dev/nvidia-caps/nvidia-cap21"}]` || nodes(1) != `[{"path":"/dev/nvidia1"}]` || nodes(2) != nodes(1) {
		t.Fatalf("device nodes: %s | %s | %s", nodes(0), nodes(1), nodes(2))
	}
	if strings.Contains(out, "/dev/dri/card1") {
		t.Fatal("an unheld GPU's node leaked into the hold")
	}
	// A Kubernetes binding is left to the plugin (it names nvidia.com/gpu=<uuid> itself).
	as.Binding = agentv1.Binding_BINDING_KUBERNETES
	raw, _ = json.Marshal(newCDISpec(as, 7, atoms, false, vendor))
	if k := string(raw); strings.Contains(k, "/dev/nvidia") || strings.Contains(k, `"0.7.0"`) {
		t.Fatalf("kubernetes spec: %s", k)
	}
	// A device the spec does not name is reported, not guessed.
	if m := vendor.missing([]atom{{id: "GPU-z", visible: "GPU-z"}}); len(m) != 1 {
		t.Fatalf("missing = %v", m)
	}
}

// WSL 2: nvidia-ctk's wsl mode names one device, "all" (/dev/dxg), standing for every GPU.
func TestHoldSpecOnWSL(t *testing.T) {
	root := vendorRoot(t, map[string]string{"var/run/cdi/nvidia.json": `{"cdiVersion":"0.5.0","kind":"nvidia.com/gpu",
		"devices":[{"name":"all","containerEdits":{"deviceNodes":[{"path":"/dev/dxg"}]}}],
		"containerEdits":{"mounts":[{"hostPath":"/usr/lib/wsl/lib/libcuda.so.1.1","containerPath":"/usr/lib/wsl/lib/libcuda.so.1.1"}]}}`})
	vendor := loadVendorCDI(root)
	as := &agentv1.DeviceAssignment{AllocationId: "a", ReservationId: "r"}
	spec := newCDISpec(as, 1, []atom{{id: "GPU-5090", class: "gpu", parent: "GPU-5090", visible: "GPU-5090"}}, false, vendor)
	raw, _ := json.Marshal(spec)
	if out := string(raw); !strings.Contains(out, "/dev/dxg") || !strings.Contains(out, "/usr/lib/wsl/lib/libcuda.so.1.1") || spec.CdiVersion != "0.6.0" {
		t.Fatalf("wsl spec: %s", out)
	}
	if loadVendorCDI(t.TempDir()) != nil {
		t.Fatal("a host without NVIDIA specs has a vendor spec")
	}
}
