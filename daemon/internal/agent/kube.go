package agent

import (
	"context"
	"encoding/json"
	"os"
	"regexp"
	"strconv"
	"strings"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
	"github.com/better-compute/better-compute/daemon/internal/kube"
	"github.com/better-compute/better-compute/daemon/internal/pki"
)

// HostUnitsWith is HostUnits with the k8s-join unit configured by the caller: bcd node gives it
// the secret broker and its labels, bcd helper root's allowlist.
func HostUnitsWith(o hostconfig.Options, join kube.JoinUnit) *hostconfig.Registry {
	r := hostconfig.Builtin(o)
	r.Add(join)
	return r
}

// k8sTokenBinding is how a SecretRequest claims the k8s-join unit's tokenRef: the broker releases it
// only while the node's current spec names that ref at k8s-join.tokenRef.
var k8sTokenBinding = pki.SecretBinding{WorkflowID: "host:" + kube.UnitName, StepID: "tokenRef"}

// kubeJoinUnit is the k8s-join unit as bcd node runs it.
func (a *Agent) kubeJoinUnit() kube.JoinUnit {
	return kube.JoinUnit{
		Token: func(ctx context.Context, ref string) ([]byte, error) {
			return a.RequestSecret(ctx, ref, k8sTokenBinding)
		},
		Labels:  a.kubeLabels,
		Allowed: a.o.KubernetesAllowed,
		// Root decides which clusters get this machine, as root or not (review round 5 #4): an empty
		// [kubernetes] allowed_clusters refuses every k8s-join.
		RequireAllowed: true,
	}
}

// stageKubeToken writes the bootstrap token for bcd helper before it applies k8s-join, while the
// node is not joined yet (the helper cannot ask the control plane for secrets).
func (a *Agent) stageKubeToken(ctx context.Context, sys hostconfig.System, settings json.RawMessage) error {
	ref, err := kube.PendingToken(sys, settings)
	if err != nil || ref == "" {
		return err
	}
	token, err := a.RequestSecret(ctx, ref, k8sTokenBinding)
	if err != nil {
		return err
	}
	return a.host.WriteFile(kube.TokenFile, token, 0o600)
}

var labelUnsafe = regexp.MustCompile(`[^A-Za-z0-9_.-]+`)

// labelValue makes a Kubernetes label value (63 characters, alphanumeric at both ends); "" when
// nothing is left.
func labelValue(s string) string {
	v := labelUnsafe.ReplaceAllString(strings.TrimSpace(s), "-")
	if len(v) > 63 {
		v = v[:63]
	}
	return strings.Trim(v, "-_.")
}

// kubeLabels are the bcd.dev/* labels of this node's Kubernetes Node.
func (a *Agent) kubeLabels() map[string]string {
	out := map[string]string{}
	if v := labelValue(a.NodeID()); v != "" {
		out[kube.BcdLabelPrefix+"node-id"] = v
	}
	a.mu.Lock()
	site := a.state.SiteID
	a.mu.Unlock()
	if v := labelValue(site); v != "" {
		out[kube.BcdLabelPrefix+"site"] = v
	}
	a.invMu.Lock()
	defer a.invMu.Unlock()
	if a.inv != nil && a.inv.Gpus != nil && len(a.inv.Gpus.Gpus) > 0 {
		out[kube.BcdLabelPrefix+"gpu.count"] = strconv.Itoa(len(a.inv.Gpus.Gpus))
		if v := labelValue(a.inv.Gpus.Gpus[0].Name); v != "" {
			out[kube.BcdLabelPrefix+"gpu.product"] = v
		}
		if v := labelValue(a.inv.Gpus.DriverVersion); v != "" {
			out[kube.BcdLabelPrefix+"gpu.driver"] = v
		}
	}
	return out
}

// newKubeManager builds the device-plugin manager: it runs only once bcd joined this node to a
// cluster with gpu on (kube.StateFile), and reads the GPUs' NUMA nodes, MIG UUIDs and health from
// the inventory.
func newKubeManager(a *Agent) *kube.Manager {
	return &kube.Manager{
		Sys:          &hostconfig.OSSystem{Root: a.host.Path("/")},
		Dir:          a.host.Path("/var/lib/kubelet/device-plugins"),
		PodResources: a.host.Path("/var/lib/kubelet/pod-resources/kubelet.sock"),
		MigUUID:      a.migUUID,
		NUMA: func(uuid string) (int64, bool) {
			g := a.gpu(uuid)
			if g == nil || g.NumaNode == nil {
				return 0, false
			}
			return int64(*g.NumaNode), true
		},
		Healthy: a.gpuHealthy,
		Log:     a.log.With("component", "kube"),
		// As the cluster's DaemonSet (provider-kubernetes, [host] units = false) the node is a worker
		// without k8s-join; the DaemonSet names its Node in NODE_NAME.
		Hosted:   a.o.ExternalHost,
		NodeName: os.Getenv("NODE_NAME"),
		Labels:   a.kubeLabels,
		GPUAPI:   a.o.KubernetesGPUAPI,
		// ForeignGpuExposure, PodResourcesUnavailable, KubernetesReleased reach the control plane with
		// the next status.
		Changed: a.triggerConverge,
		// The DRA driver's sockets live beside the device plugins' (fakehw maps them under its root).
		RegistryDir:  a.host.Path("/var/lib/kubelet/plugins_registry"),
		DRAPluginDir: a.host.Path("/var/lib/kubelet/plugins/" + kube.DRADriverName),
	}
}

// kubeConditions are the device plugin manager's conditions as StatusReport conditions.
func (a *Agent) kubeConditions() []*agentv1.Condition {
	var out []*agentv1.Condition
	for _, c := range a.kube.Conditions() {
		out = append(out, &agentv1.Condition{Type: c.Type, Status: agentv1.ConditionStatus_CONDITION_STATUS_TRUE, Reason: c.Reason, Message: c.Message})
	}
	return out
}

// gpu returns the inventory's GPU by UUID (a copy's pointer; nil when unknown).
func (a *Agent) gpu(uuid string) *inventory.Gpu {
	a.invMu.Lock()
	defer a.invMu.Unlock()
	if a.inv == nil || a.inv.Gpus == nil {
		return nil
	}
	for _, g := range a.inv.Gpus.Gpus {
		if g.Uuid == uuid {
			return g
		}
	}
	return nil
}

var kubeMigAtom = regexp.MustCompile(`^(.+?)[/_]gi(\d+)[/_]ci(\d+)$`)

// migUUID maps a MIG atom (<gpu>/gi<g>/ci<c>) to the MIG-… UUID nvidia-smi reported for it.
func (a *Agent) migUUID(atom string) string {
	m := kubeMigAtom.FindStringSubmatch(atom)
	if m == nil {
		return ""
	}
	g := a.gpu(m[1])
	if g == nil || g.Mig == nil {
		return ""
	}
	for _, inst := range g.Mig.Instances {
		if strconv.FormatUint(uint64(inst.GiId), 10) == m[2] && strconv.FormatUint(uint64(inst.CiId), 10) == m[3] {
			return inst.Uuid
		}
	}
	return ""
}

// gpuHealthy: a GPU with a failed row remap, a pending one, uncorrectable ECC errors since the
// driver loaded, or an active XID condition takes no new pods.
func (a *Agent) gpuHealthy(uuid string) bool {
	if g := a.gpu(uuid); g != nil {
		if r := g.RowRemap; r != nil && (r.Failure || r.Pending) {
			return false
		}
		if e := g.Ecc; e != nil && e.VolatileCounts != nil && e.VolatileCounts.Uncorrectable > 0 {
			return false
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, f := range a.faults {
		if f.GetDeviceId() == uuid {
			return false
		}
	}
	return true
}
