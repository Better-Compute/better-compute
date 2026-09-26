package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
	"github.com/better-compute/better-compute/daemon/internal/kube"
	"github.com/better-compute/better-compute/daemon/internal/nvml"
)

// kubeChecks: the [kubernetes] allowlist, and on a node bcd joined to a cluster its kubelet and the
// device plugins' socket directory.
func kubeChecks(cfg *config.Config, sys hostconfig.System, active func(unit string) bool) []doctorCheck {
	var out []doctorCheck
	allowed, err := kube.ParseAllowedClusters(cfg.KubernetesAllowedClusters)
	switch {
	case err != nil:
		out = append(out, doctorCheck{"fail", "kubernetes", err.Error()})
	case len(allowed) > 0:
		out = append(out, doctorCheck{"ok", "kubernetes", fmt.Sprintf("%d allowed clusters", len(allowed))})
	case cfg.Helper.Socket != "":
		out = append(out, doctorCheck{"warn", "kubernetes", "no [kubernetes] allowed_clusters: bcd helper refuses every k8s-join"})
	}
	state, joined, err := kube.ReadState(sys)
	if err != nil {
		return append(out, doctorCheck{"fail", "kubernetes", err.Error()})
	}
	if !joined {
		return out
	}
	if !active("kubelet") {
		out = append(out, doctorCheck{"fail", "kubelet", fmt.Sprintf("joined to %s as %s but the kubelet is not running", state.Server, state.NodeName)})
	} else {
		out = append(out, doctorCheck{"ok", "kubelet", fmt.Sprintf("node %s of %s", state.NodeName, state.Server)})
	}
	if state.GPU {
		if _, err := sys.ReadDir("/var/lib/kubelet/device-plugins"); err != nil {
			out = append(out, doctorCheck{"warn", "device-plugin", "no /var/lib/kubelet/device-plugins: bcd cannot hand GPUs to the kubelet"})
		} else {
			out = append(out, doctorCheck{"ok", "device-plugin", "bcd.dev/gpu, bcd.dev/gpu.mig, bcd.dev/gpu.slot"})
		}
	}
	return out
}

// gpuChecks read every GPU once through nvidia-smi: its load, and what needs attention (row
// remapping, uncorrectable ECC errors, a pending MIG mode change). The PCIe link is diag.nvml's.
func gpuChecks(snapshot func(ctx context.Context) (*nvml.Snapshot, error)) []doctorCheck {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	snap, err := snapshot(ctx)
	if errors.Is(err, nvml.ErrNoDriver) {
		return nil
	}
	if err != nil {
		return []doctorCheck{{"fail", "gpus", err.Error()}}
	}
	var out []doctorCheck
	samples := map[string]nvml.Sample{}
	for _, s := range snap.Samples {
		samples[s.UUID] = s
	}
	for _, g := range snap.Section.Gpus {
		s := samples[g.Uuid]
		detail := fmt.Sprintf("%s %s: %d%% busy, %d C, %.0f/%.0f W, %.1f/%.1f GiB", g.Uuid, g.Name, s.UtilizationGPU, s.TemperatureC,
			float64(s.PowerDrawMw)/1000, float64(s.PowerLimitMw)/1000, float64(s.MemoryUsed)/(1<<30), float64(s.MemoryTotal)/(1<<30))
		status := "ok"
		var problems []string
		if r := g.RowRemap; r != nil && r.Failure {
			status, problems = "fail", append(problems, "row remapping failed (RMA)")
		} else if r != nil && r.Pending {
			status, problems = "warn", append(problems, "a row remap waits for a GPU reset")
		}
		if e := g.Ecc; e != nil && e.VolatileCounts != nil && e.VolatileCounts.Uncorrectable > 0 {
			status, problems = "fail", append(problems, fmt.Sprintf("%d uncorrectable ECC errors", e.VolatileCounts.Uncorrectable))
		}
		if g.Mig != nil && g.Mig.Pending != 0 && g.Mig.Pending != g.Mig.Current {
			problems = append(problems, "a MIG mode change waits for a reset")
			if status == "ok" {
				status = "warn"
			}
		}
		if len(problems) > 0 {
			detail += "; " + strings.Join(problems, "; ")
		}
		out = append(out, doctorCheck{status, "gpu", detail})
	}
	return out
}

// hostKubeChecks runs kubeChecks against this host.
func hostKubeChecks(cfg *config.Config) []doctorCheck {
	return kubeChecks(cfg, &hostconfig.OSSystem{}, func(unit string) bool {
		out, err := exec.Command("systemctl", "is-active", unit).Output()
		return err == nil && strings.TrimSpace(string(out)) == "active"
	})
}
