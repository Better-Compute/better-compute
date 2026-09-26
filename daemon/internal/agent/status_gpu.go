package agent

import (
	"context"
	"sort"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
	"github.com/better-compute/better-compute/daemon/internal/kube"
)

// GPUStatus is one GPU as bcd status shows it: identity from the inventory, a live reading (when a
// sampler answered within 10 s) and what holds it.
type GPUStatus struct {
	UUID  string `json:"uuid"`
	Index uint32 `json:"index"`
	Model string `json:"model"`
	// Healthy is gpuHealthy (no failed or pending row remap, no uncorrectable ECC, no XID this boot).
	Healthy bool `json:"healthy"`
	// Held names the allocation holding it (or one of its MIG instances or slots).
	Held string `json:"held,omitempty"`

	UtilizationPct uint32 `json:"utilizationPct"`
	TemperatureC   uint32 `json:"temperatureC"`
	PowerDrawW     uint32 `json:"powerDrawW"`
	PowerLimitW    uint32 `json:"powerLimitW"`
	MemoryUsed     uint64 `json:"memoryUsedBytes"`
	MemoryTotal    uint64 `json:"memoryTotalBytes"`
	Processes      int    `json:"processes"`
}

// KubeStatus is this node as a Kubernetes worker.
type KubeStatus struct {
	// Mode is "joined" (k8s-join) or "hosted" (the cluster's DaemonSet).
	Mode     string `json:"mode"`
	Server   string `json:"server,omitempty"`
	NodeName string `json:"nodeName,omitempty"`
	// Advertised counts the devices each bcd.dev resource offers the kubelet.
	Advertised map[string]int `json:"advertised"`
}

func (a *Agent) gpuStatus() []GPUStatus {
	a.invMu.Lock()
	var out []GPUStatus
	if a.inv != nil && a.inv.Gpus != nil {
		for _, g := range a.inv.Gpus.Gpus {
			out = append(out, GPUStatus{UUID: g.Uuid, Index: g.Index, Model: g.Name, MemoryTotal: g.VramBytes})
		}
	}
	a.invMu.Unlock()
	if len(out) == 0 {
		return nil
	}
	holds := map[string]string{}
	if a.devices != nil {
		if observed, err := a.devices.observed(); err == nil {
			for id, h := range observed {
				for _, dev := range h.deviceIDs {
					holds[kube.GPUOf(dev)] = id
				}
			}
		}
	}
	byUUID := map[string]*GPUStatus{}
	for i := range out {
		g := &out[i]
		g.Healthy = a.gpuHealthy(g.UUID)
		g.Held = holds[g.UUID]
		byUUID[g.UUID] = g
	}
	if a.o.GPUSampler != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if snap, err := a.o.GPUSampler(ctx); err == nil && snap != nil {
			for _, s := range snap.Samples {
				if g := byUUID[s.UUID]; g != nil {
					g.UtilizationPct, g.TemperatureC, g.Processes = s.UtilizationGPU, s.TemperatureC, s.Processes
					g.PowerDrawW, g.PowerLimitW = (s.PowerDrawMw+500)/1000, (s.PowerLimitMw+500)/1000
					g.MemoryUsed = s.MemoryUsed
					if s.MemoryTotal > 0 {
						g.MemoryTotal = s.MemoryTotal
					}
				}
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Index < out[j].Index })
	return out
}

func (a *Agent) kubeStatus() *KubeStatus {
	advertised := a.kube.Advertised()
	if state, joined, err := kube.ReadState(&hostconfig.OSSystem{Root: a.host.Path("/")}); err == nil && joined {
		return &KubeStatus{Mode: "joined", Server: state.Server, NodeName: state.NodeName, Advertised: advertised}
	}
	if a.kube.Hosted && len(advertised) > 0 {
		return &KubeStatus{Mode: "hosted", NodeName: a.kube.NodeName, Advertised: advertised}
	}
	return nil
}
