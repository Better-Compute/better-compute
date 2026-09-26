package agent

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"google.golang.org/protobuf/proto"
)

// An XID fails diag.nvml's xid.recent for its GPU (and re-collects the inventory); a narrowed PCIe
// link fails pcie.link; a gpu.reset that brings the GPU back healthy clears the XID condition.
func TestGpuHealthChecksAndResetClearsXids(t *testing.T) {
	r, w := io.Pipe()
	inv := fakehw.Inventory(1)
	gpu, other := inv.Gpus.Gpus[2], inv.Gpus.Gpus[5]
	h := newHarness(t, func(o *Options) { o.Host.(*fakeHost).kmsg = r })
	defer w.Close()
	// The other GPU trained its link at x8 of x16.
	sysfs := func(bus, name, value string) {
		domain, rest, _ := strings.Cut(strings.ToLower(bus), ":")
		dir := h.host.Path("/sys/bus/pci/devices/" + domain[len(domain)-4:] + ":" + rest)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(value+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	sysfs(other.PciBusId, "current_link_width", "8")
	sysfs(other.PciBusId, "max_link_width", "16")
	sysfs(gpu.PciBusId, "current_link_width", "16")
	sysfs(gpu.PciBusId, "max_link_width", "16")

	s, _ := h.open()
	s.push(desired(1, &agentv1.NodeSpec{}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil })
	collectedAt := func() time.Time {
		h.agent.invMu.Lock()
		defer h.agent.invMu.Unlock()
		return h.agent.collectedAt
	}
	before := collectedAt()
	bus := strings.TrimSuffix(strings.TrimPrefix(strings.ToLower(gpu.PciBusId), "0000"), ".0")
	_, _ = io.WriteString(w, "3,1,1,-;NVRM: Xid (PCI:"+bus+"): 48, pid=1, An uncorrectable double bit error.\n")
	s.next(t, "status with the XID", func(f *agentv1.AgentFrame) bool {
		for _, c := range f.GetStatus().GetConditions() {
			if c.GetType() == "Xid48" && c.GetDeviceId() == gpu.Uuid {
				return true
			}
		}
		return false
	})
	// The XID re-collects the inventory once its burst is over.
	deadline := time.Now().Add(10 * time.Second)
	for !collectedAt().After(before) {
		if time.Now().After(deadline) {
			t.Fatal("the XID did not re-collect the inventory")
		}
		time.Sleep(50 * time.Millisecond)
	}

	// The device plugins and DRA read health from gpuHealthy: the XID makes the GPU unhealthy.
	healthOf := func(uuid string) bool {
		for _, g := range h.agent.Status().GPUs {
			if g.UUID == uuid {
				return g.Healthy
			}
		}
		t.Fatalf("no GPU %s in the status", uuid)
		return false
	}
	if healthOf(gpu.Uuid) || !healthOf(other.Uuid) {
		t.Fatal("the XID did not make its GPU (and only it) unhealthy")
	}

	diag := func(id string) *agentv1.DiagNvmlResult {
		t.Helper()
		s.push(command(body(id, "diag.nvml", &agentv1.DiagNvmlRequest{GpuUuids: []string{gpu.Uuid, other.Uuid}})))
		done := s.update(t, id, commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
		result := &agentv1.DiagNvmlResult{}
		if err := proto.Unmarshal(done.GetResult(), result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	check := func(g *agentv1.GpuDiagnostic, name string) *agentv1.DiagnosticCheck {
		for _, c := range g.GetChecks() {
			if c.GetName() == name {
				return c
			}
		}
		t.Fatalf("no %s check in %v", name, g)
		return nil
	}
	result := diag("d1")
	if result.GetPassed() {
		t.Fatalf("diag passed with an XID and a narrowed link: %v", result)
	}
	byUUID := map[string]*agentv1.GpuDiagnostic{}
	for _, g := range result.GetGpus() {
		byUUID[g.GetUuid()] = g
	}
	if c := check(byUUID[gpu.Uuid], "xid.recent"); c.GetPassed() || !strings.Contains(c.GetMessage(), "Xid48") {
		t.Fatalf("xid.recent = %v", c)
	}
	if c := check(byUUID[gpu.Uuid], "pcie.link"); !c.GetPassed() {
		t.Fatalf("pcie.link of a full-width GPU = %v", c)
	}
	if c := check(byUUID[other.Uuid], "pcie.link"); c.GetPassed() || c.GetMessage() != "PCIe link x8 of x16" {
		t.Fatalf("pcie.link = %v", c)
	}

	// The reset brings the GPU back healthy: its XID condition goes, in the status too.
	s.push(command(body("r1", "gpu.reset", &agentv1.GpuResetRequest{GpuUuids: []string{gpu.Uuid}})))
	// The status without it is sent before the command's result.
	s.update(t, "r1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	h.agent.mu.Lock()
	for _, c := range h.agent.lastStatus.GetConditions() {
		if strings.HasPrefix(c.GetType(), "Xid") {
			t.Fatalf("the status still carries %v", c)
		}
	}
	h.agent.mu.Unlock()
	if c := check(diag("d2").GetGpus()[0], "xid.recent"); !c.GetPassed() {
		t.Fatalf("after the reset: %v", c)
	}
	h.agent.mu.Lock()
	faults := len(h.agent.faults)
	h.agent.mu.Unlock()
	if faults != 0 {
		t.Fatalf("faults after the reset = %d", faults)
	}
	if !healthOf(gpu.Uuid) {
		t.Fatal("the reset GPU is still unhealthy")
	}
}

// Without the driver's management interface (procfs GPUs only), Hello does not claim nvml and
// diag.nvml fails nvml.init.
func TestNoNvmlWithoutTheManagementInterface(t *testing.T) {
	inv := fakehw.Inventory(1)
	inv.Gpus.CudaDriverVersion = ""
	h := newHarness(t, func(o *Options) { o.Host.(*fakeHost).inv = inv })
	s, hello := h.open()
	for _, c := range hello.GetCapabilities() {
		if c == "nvml" {
			t.Fatalf("capabilities = %v", hello.GetCapabilities())
		}
	}
	s.push(command(body("d1", "diag.nvml", &agentv1.DiagNvmlRequest{})))
	done := s.update(t, "d1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	result := &agentv1.DiagNvmlResult{}
	_ = proto.Unmarshal(done.GetResult(), result)
	if result.GetPassed() || result.GetChecks()[0].GetName() != "nvml.init" || result.GetChecks()[0].GetPassed() {
		t.Fatalf("diag = %v", result)
	}
}
