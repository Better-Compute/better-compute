package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
	"github.com/better-compute/better-compute/daemon/internal/kube"
	"github.com/better-compute/better-compute/daemon/internal/nvml"
)

func TestKubeChecks(t *testing.T) {
	sys := hostconfig.NewFakeSystem()
	up := map[string]bool{}
	active := func(unit string) bool { return up[unit] }
	bad := &config.Config{KubernetesAllowedClusters: "http://x#abc"}
	if got := kubeChecks(bad, sys, active); len(got) != 1 || got[0].status != "fail" {
		t.Fatalf("bad allowlist = %+v", got)
	}
	if got := kubeChecks(&config.Config{}, sys, active); len(got) != 0 {
		t.Fatalf("not a Kubernetes node = %+v", got)
	}
	sys.Set(kube.StateFile, `{"server":"https://10.0.0.1:6443","nodeName":"gpu-7","gpu":true}`)
	// Joined, but no allowlist: every k8s-join is refused now (review round 5 #4).
	if got := kubeChecks(&config.Config{}, sys, active); got[0].status != "fail" || !strings.Contains(got[0].detail, "allowed_clusters is empty") {
		t.Fatalf("joined without an allowlist = %+v", got)
	}
	allowed := &config.Config{KubernetesAllowedClusters: "https://10.0.0.1:6443#sha256:" + strings.Repeat("ab", 32)}
	got := kubeChecks(allowed, sys, active)
	if len(got) != 3 || got[0].status != "ok" || got[1].check != "kubelet" || got[1].status != "fail" || got[2].status != "warn" {
		t.Fatalf("joined, kubelet down = %+v", got)
	}
	up["kubelet"] = true
	sys.Set("/var/lib/kubelet/device-plugins/kubelet.sock", "")
	got = kubeChecks(allowed, sys, active)
	if got[1].status != "ok" || got[1].detail != "node gpu-7 of https://10.0.0.1:6443" || got[2].status != "ok" {
		t.Fatalf("joined = %+v", got)
	}
	// A toolkit that lets pods pick GPUs by environment variable (its default) fails GPU isolation.
	sys.Set(kube.ToolkitConfigs[0], "[nvidia-container-runtime]\n")
	got = kubeChecks(allowed, sys, active)
	if len(got) != 4 || got[2].check != "gpu-isolation" || got[2].status != "fail" {
		t.Fatalf("toolkit = %+v", got)
	}
}

func TestGpuChecks(t *testing.T) {
	snap := fakehw.GPUSnapshot(1, time.Unix(1_800_000_000, 0))
	snap.Section.Gpus[1].RowRemap = &inventory.GpuRowRemap{Pending: true}
	snap.Section.Gpus[2].Ecc = &inventory.GpuEcc{Enabled: true, VolatileCounts: &inventory.EccCounts{Uncorrectable: 2}}
	got := gpuChecks(func(context.Context) (*nvml.Snapshot, error) { return snap, nil })
	if len(got) != len(snap.Section.Gpus) {
		t.Fatalf("checks = %+v", got)
	}
	if got[0].status != "ok" || !strings.Contains(got[0].detail, "% busy") || got[1].status != "warn" || got[2].status != "fail" || !strings.Contains(got[2].detail, "2 uncorrectable ECC errors") {
		t.Fatalf("checks = %+v", got[:3])
	}
	if got := gpuChecks(func(context.Context) (*nvml.Snapshot, error) { return nil, nvml.ErrNoDriver }); got != nil {
		t.Fatalf("no driver = %+v", got)
	}
}
