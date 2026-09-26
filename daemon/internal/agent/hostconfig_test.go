package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
)

func hostFile(t *testing.T, root, abs, data string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(abs))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestHostSectionConverges(t *testing.T) {
	h := newHarness(t, nil)
	root := h.host.root
	hostFile(t, root, "/proc/sys/vm/swappiness", "60\n")
	// An NVSwitch system without Fabric Manager: the unit keeps retrying (no package source under
	// a fake root) and the node reports FabricManagerDown.
	hostFile(t, root, hostconfig.NVSwitchDevices+"/0000:05:00.0/information", "x")
	hostFile(t, root, hostconfig.NvidiaModuleVersion, "570.86.15\n")
	hostFile(t, root, hostconfig.NvidiaProcVersion, "NVRM version: NVIDIA UNIX Open Kernel Module  570.86.15\n")
	s, _ := h.open()
	s.push(desired(1, &agentv1.NodeSpec{Host: &agentv1.HostSection{Units: []*agentv1.ConfigUnit{
		{Unit: "sysctl", ConfigJson: `{"vm.swappiness":10}`},
		{Unit: "fabric-manager", ConfigJson: `{}`},
	}}}))
	status := s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil }).GetStatus()
	var host *agentv1.SectionStatus
	for _, st := range status.GetSections() {
		if st.GetSection() == "host" {
			host = st
		}
	}
	if host == nil || host.GetState() != agentv1.SectionState_SECTION_STATE_PROGRESSING || !strings.Contains(host.GetMessage(), "fabric-manager") {
		t.Fatalf("host section = %v", host)
	}
	down := false
	for _, c := range status.GetConditions() {
		down = down || c.GetType() == "FabricManagerDown"
	}
	if !down {
		t.Fatalf("conditions = %v", status.GetConditions())
	}
	if b, _ := os.ReadFile(filepath.Join(root, "proc/sys/vm/swappiness")); string(b) != "10\n" {
		t.Fatalf("swappiness = %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(root, filepath.FromSlash(hostconfig.SysctlFile))); !strings.Contains(string(b), "vm.swappiness = 10") {
		t.Fatalf("drop-in = %q", b)
	}
	if status.GetObservedGeneration() == 1 {
		t.Fatal("observed while the host section is progressing")
	}
}

func TestHostSectionReportsRebootRequired(t *testing.T) {
	h := newHarness(t, nil)
	root := h.host.root
	hostFile(t, root, "/usr/sbin/update-grub", "#!/bin/sh\n") // found by LookPath; recorded, not run
	hostFile(t, root, "/proc/sys/vm/swappiness", "60\n")
	s, _ := h.open()
	s.push(desired(1, &agentv1.NodeSpec{Host: &agentv1.HostSection{Units: []*agentv1.ConfigUnit{
		{Unit: "cpu", ConfigJson: `{"isolate":"2-3"}`},
		{Unit: "sysctl", ConfigJson: `{"vm.swappiness":10}`},
	}}}))
	status := s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil }).GetStatus()
	var reboot *agentv1.Condition
	for _, c := range status.GetConditions() {
		if c.GetType() == "RebootRequired" {
			reboot = c
		}
	}
	if reboot == nil || reboot.GetReason() != "cpu" || !strings.Contains(reboot.GetMessage(), "reboot the node") {
		t.Fatalf("conditions = %v", status.GetConditions())
	}
	// The unit waiting for the reboot held nothing back.
	if b, _ := os.ReadFile(filepath.Join(root, "proc/sys/vm/swappiness")); string(b) != "10\n" {
		t.Fatalf("swappiness = %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "etc/default/grub.d/90-bcd-cpu.cfg")); !strings.Contains(string(b), "isolcpus=managed_irq,domain,2-3") {
		t.Fatalf("drop-in = %q", b)
	}
}

// Drift behind bcd's back is repaired by the periodic pass, without a new spec.
func TestHostDriftRepairedWithoutANewSpec(t *testing.T) {
	was := driftInterval
	driftInterval = 50 * time.Millisecond
	t.Cleanup(func() { driftInterval = was })
	h := newHarness(t, nil)
	root := h.host.root
	hostFile(t, root, "/proc/sys/vm/swappiness", "60\n")
	s, _ := h.open()
	s.push(desired(1, &agentv1.NodeSpec{Host: &agentv1.HostSection{Units: []*agentv1.ConfigUnit{
		{Unit: "sysctl", ConfigJson: `{"vm.swappiness":10}`},
	}}}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil })
	swappiness := filepath.Join(root, "proc/sys/vm/swappiness")
	if err := os.WriteFile(swappiness, []byte("60\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if b, _ := os.ReadFile(swappiness); string(b) == "10\n" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the drifted sysctl was not repaired")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestExternalHostAppliesNoUnit(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.ExternalHost = true })
	hostFile(t, h.host.root, "/proc/sys/vm/swappiness", "60\n")
	s, _ := h.open()
	s.push(desired(1, &agentv1.NodeSpec{Host: &agentv1.HostSection{Units: []*agentv1.ConfigUnit{
		{Unit: "sysctl", ConfigJson: `{"vm.swappiness":10}`},
	}}}))
	status := s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil }).GetStatus()
	var host *agentv1.SectionStatus
	for _, st := range status.GetSections() {
		if st.GetSection() == "host" {
			host = st
		}
	}
	if host == nil || host.GetState() != agentv1.SectionState_SECTION_STATE_UNSUPPORTED || host.GetReason() != "HostManagedExternally" {
		t.Fatalf("host section = %v", host)
	}
	for _, c := range status.GetConditions() {
		if c.GetType() == "SectionUnsupported" {
			t.Fatalf("reported as a version gap: %v", c)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(h.host.root, "proc/sys/vm/swappiness")); string(b) != "60\n" {
		t.Fatalf("a unit was applied: %q", b)
	}
	if status.GetObservedGeneration() != 1 {
		t.Fatal("an externally managed host holds back the generation")
	}
}

func TestGPUBusy(t *testing.T) {
	if !gpuBusy([]string{"GPU-aaaa"}, "GPU-aaaa") || gpuBusy([]string{"GPU-aaaa"}, "GPU-bbbb") {
		t.Fatal("whole GPU holds")
	}
	if !gpuBusy([]string{"GPU-bbbb/gi1/ci0"}, "GPU-bbbb") || !gpuBusy([]string{"GPU-bbbb/s3"}, "GPU-bbbb") {
		t.Fatal("a held MIG instance or slot keeps its GPU as it is")
	}
	if gpuBusy([]string{"GPU-aaaa/gi1/ci0"}, "GPU-aaaa0") {
		t.Fatal("a UUID prefix is not its GPU")
	}
}
