package kube

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
)

// Security review 2 #3b: the toolkit config that counts is the one the container runtime's
// nvidia-container-runtime reads; configured but missing or unreadable, the toolkit takes its default
// (accept NVIDIA_VISIBLE_DEVICES), which is exposure.
func TestToolkitExposureFollowsTheRuntime(t *testing.T) {
	sys := hostconfig.NewFakeSystem()
	if msg := ToolkitExposure(sys); msg != "" {
		t.Fatalf("no toolkit, no runtime: %s", msg)
	}
	// The GPU operator's toolkit runtime in containerd, its config not there.
	sys.Set(ContainerRuntimeConfigs[0], `version = 2
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.nvidia.options]
  BinaryName = "/usr/local/nvidia/toolkit/nvidia-container-runtime"
`)
	operator := "/usr/local/nvidia/toolkit/.config/nvidia-container-runtime/config.toml"
	if msg := ToolkitExposure(sys); !strings.Contains(msg, "missing or unreadable") || !strings.Contains(msg, operator) {
		t.Fatalf("a configured runtime without its config = %q", msg)
	}
	sys.Set(operator, "[nvidia-container-runtime]\naccept-nvidia-visible-devices-envvar-when-unprivileged = false\n")
	if msg := ToolkitExposure(sys); msg != "" {
		t.Fatalf("a CDI-only toolkit = %q", msg)
	}
	// A CRI-O drop-in running the host package's runtime, whose config keeps the default.
	sys.Set("/etc/crio/crio.conf.d/99-nvidia.conf", "[crio.runtime.runtimes.nvidia]\nruntime_path = \"/usr/bin/nvidia-container-runtime\"\n")
	sys.Set(ToolkitConfigs[0], "[nvidia-container-runtime]\nmode = \"legacy\"\n")
	if msg := ToolkitExposure(sys); !strings.Contains(msg, ToolkitConfigs[0]+" lets unprivileged pods") {
		t.Fatalf("the host package's default = %q", msg)
	}
	// The .cdi runtime takes CDI names only: nothing to check for it.
	sys.Delete("/etc/crio/crio.conf.d/99-nvidia.conf")
	sys.Delete(ToolkitConfigs[0])
	sys.Set(ContainerRuntimeConfigs[0], "BinaryName = \"/usr/bin/nvidia-container-runtime.cdi\"\n")
	if msg := ToolkitExposure(sys); msg != "" {
		t.Fatalf("the .cdi runtime = %q", msg)
	}
}

// Security review 2 #3c: a hosted node that cannot read any container runtime config cannot rule the
// toolkit out (a DirectoryOrCreate mount looks empty).
func TestRuntimeConfigUnverifiable(t *testing.T) {
	sys := hostconfig.NewFakeSystem()
	if RuntimeConfigUnverifiable(sys) == "" {
		t.Fatal("no readable runtime config passed")
	}
	sys.Set("/var/lib/rancher/k3s/agent/etc/containerd/config.toml", "version = 2\n")
	if msg := RuntimeConfigUnverifiable(sys); msg != "" {
		t.Fatalf("k3s's config = %q", msg)
	}
}

// Security review 2 #3a: another DRA driver publishing GPUs on this node withdraws bcd's offer.
func TestForeignDRADriverWithdrawsTheOffer(t *testing.T) {
	m, kubelet, sys, now, _ := securityRig(t)
	ctx := context.Background()
	sys.Set(CDIDir+"/bcd-a1.json", holdFile("a1", BindingKubernetes, "GPU-1"))
	slices := `{"items":[{"spec":{"driver":"net.example.com","nodeName":"n1","devices":[{"name":"nic-0"}]}}]}`
	sys.Handler = func(_ context.Context, cmd hostconfig.Cmd) ([]byte, error) {
		if strings.Contains(strings.Join(cmd.Args, " "), "get resourceslices --field-selector spec.nodeName=n1") {
			return []byte(slices), nil
		}
		return nil, nil
	}
	m.Sync(ctx)
	if len(kubelet.registrations()) != 1 || len(m.Conditions()) != 0 {
		t.Fatalf("a NIC driver withdrew the GPUs: %v", m.Conditions())
	}
	slices = `{"items":[{"spec":{"driver":"gpu.nvidia.com","nodeName":"n1","devices":[{"name":"gpu-0"}]}}]}`
	*now = now.Add(2 * time.Minute) // past the cached read
	m.Sync(ctx)
	if got := conditionTypes(m); !reflect.DeepEqual(got, []string{ConditionForeignGpuExposure}) || !strings.Contains(m.Conditions()[0].Message, "gpu.nvidia.com") {
		t.Fatalf("conditions = %+v", m.Conditions())
	}
	if m.Advertised()[ResourceGPU] != 0 {
		t.Fatal("bcd still advertises GPUs beside another GPU DRA driver")
	}
}
