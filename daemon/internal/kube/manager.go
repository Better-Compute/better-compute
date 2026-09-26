package kube

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
)

// Manager runs bcd's device plugins while the node is a Kubernetes worker bcd joined with gpu on:
// each pass it reads the Kubernetes-bound holds, advertises exactly their devices (one plugin per
// resource), re-registers after a kubelet restart, and deletes the pods still holding a device
// compute released (Reaper).
type Manager struct {
	// Sys reads the holds, the NVIDIA CDI specs and the join state, and runs kubectl.
	Sys hostconfig.System
	// Dir is the kubelet's device-plugins directory (default /var/lib/kubelet/device-plugins) and
	// PodResources its pod-resources socket; both are real paths (sockets).
	Dir          string
	PodResources string
	// MigUUID maps a MIG atom (<gpu>/gi<g>/ci<c>) to its MIG-… UUID (the inventory's); "" when
	// unknown.
	MigUUID func(atom string) string
	// NUMA returns a GPU's NUMA node.
	NUMA func(gpu string) (int64, bool)
	// Healthy reports whether a GPU may take work (nil: all are).
	Healthy func(gpu string) bool
	// DeletePod deletes a pod still using a released device (default: kubectl with the kubelet's
	// credentials): first with a 10 s grace period, then, if it still holds the device a minute later,
	// forced.
	DeletePod func(ctx context.Context, namespace, name string, force bool) error
	// Interval between passes (default 5 s) and Grace a released device may stay in use before its
	// pods are deleted (default 30 s).
	Interval, Grace time.Duration
	Now             func() time.Time
	Log             *slog.Logger
	// Hosted: bcd runs as the cluster's DaemonSet ([host] units = false; provider-kubernetes). The
	// node is a worker because the cluster says so, not because k8s-join joined it: the plugins run
	// whenever the kubelet is there, and the Manager keeps the Node's bcd.dev/* labels itself (the
	// join unit does on a node it joined).
	Hosted bool
	// NodeName is the Node (the DaemonSet's NODE_NAME) and Labels its bcd.dev/* labels, for Hosted.
	NodeName string
	Labels   func() map[string]string
	// LabelInterval spaces the hosted label syncs (default 1 min).
	LabelInterval time.Duration
	// Changed is called after a pass whose conditions differ from the previous one's (the agent then
	// sends a status with them).
	Changed func()
	// GPUAPI is how a hosted node offers its GPUs (APIDevicePlugin, the default, or APIDRA); a node
	// k8s-join joined takes its record's gpuApi.
	GPUAPI string
	// RegistryDir is the kubelet's plugins_registry and DRAPluginDir the DRA driver's own directory
	// (defaults under /var/lib/kubelet).
	RegistryDir, DRAPluginDir string

	trigger chan struct{}
	dra     *draDriver
	once    sync.Once
	plugins map[string]*plugin
	// stale remembers when a pod was first seen holding a released device (namespace/name → time).
	stale map[string]time.Time
	// deleted remembers when a pod's deletion was last asked for (forced a minute later).
	deleted   map[string]time.Time
	labelSync time.Time
	// advertised is each resource's device count as of the last pass (Advertised), conditions its
	// conditions (Conditions).
	advertised atomic.Pointer[map[string]int]
	conditions atomic.Pointer[[]Condition]
}

// forceAfter is how long a deleted pod may keep a released device before its deletion is forced.
const forceAfter = time.Minute

// Advertised returns how many devices each bcd.dev resource advertises to the kubelet now (none
// while the node is not a worker), for bcd status.
func (m *Manager) Advertised() map[string]int {
	if p := m.advertised.Load(); p != nil {
		return *p
	}
	return map[string]int{}
}

func (m *Manager) init() {
	m.once.Do(func() {
		m.trigger = make(chan struct{}, 1)
		m.plugins = map[string]*plugin{}
		m.stale = map[string]time.Time{}
		if m.Dir == "" {
			m.Dir = defaultDevicePluginsDir
		}
		if m.PodResources == "" {
			m.PodResources = defaultPodResourcesSock
		}
		if m.RegistryDir == "" {
			m.RegistryDir = defaultRegistryDir
		}
		if m.DRAPluginDir == "" {
			m.DRAPluginDir = defaultDRAPluginDir
		}
		m.dra = &draDriver{m: m}
		if m.Interval <= 0 {
			m.Interval = 5 * time.Second
		}
		if m.Grace <= 0 {
			m.Grace = 30 * time.Second
		}
		if m.Now == nil {
			m.Now = time.Now
		}
		if m.Log == nil {
			m.Log = slog.New(slog.DiscardHandler)
		}
		if m.DeletePod == nil {
			m.DeletePod = func(ctx context.Context, namespace, name string, force bool) error {
				args := []string{"delete", "pod", "--namespace", namespace, name, "--wait=false", "--ignore-not-found", "--grace-period=10"}
				if force {
					args = append(args[:len(args)-1], "--grace-period=0", "--force")
				}
				_, err := m.Sys.Run(ctx, kubectl(args...))
				return err
			}
		}
		m.deleted = map[string]time.Time{}
	})
}

// Trigger runs a pass soon (the devices converger bound or released a hold).
func (m *Manager) Trigger() {
	m.init()
	select {
	case m.trigger <- struct{}{}:
	default:
	}
}

// Run passes until ctx ends, then stops the plugins.
func (m *Manager) Run(ctx context.Context) {
	m.init()
	t := time.NewTicker(m.Interval)
	defer t.Stop()
	defer m.stopAll()
	for {
		m.Sync(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-m.trigger:
		}
	}
}

func (m *Manager) stopAll() {
	m.stopPlugins()
	if m.dra != nil {
		m.dra.stop()
	}
}

func (m *Manager) stopPlugins() {
	for _, p := range m.plugins {
		p.stop()
	}
	m.plugins = map[string]*plugin{}
}

// api is the GPU API of this node: its k8s-join record's, else GPUAPI; the device plugins by default.
func (m *Manager) api() string {
	if state, ok, err := ReadState(m.Sys); err == nil && ok && state.GPUAPI != "" {
		return state.GPUAPI
	}
	if m.GPUAPI == APIDRA {
		return APIDRA
	}
	return APIDevicePlugin
}

func (m *Manager) logf(msg string, args ...any) { m.Log.Info(msg, args...) }

// enabled reports whether the kubelet is up on a node bcd joined with gpu on (or, Hosted, on any
// node the DaemonSet runs on).
func (m *Manager) enabled() bool {
	if !m.Hosted {
		state, ok, err := ReadState(m.Sys)
		if err != nil || !ok || !state.GPU {
			return false
		}
	}
	_, err := os.Stat(filepath.Join(m.Dir, kubeletSocketName))
	return err == nil
}

// syncLabels keeps a hosted Node's bcd.dev/* labels (at most every LabelInterval): the same plan as
// the join unit's, with no taints and nothing recorded but bcd.dev/*.
func (m *Manager) syncLabels(ctx context.Context) {
	if !m.Hosted || m.NodeName == "" || m.Labels == nil {
		return
	}
	interval := m.LabelInterval
	if interval <= 0 {
		interval = time.Minute
	}
	now := m.Now()
	if !m.labelSync.IsZero() && now.Sub(m.labelSync) < interval {
		return
	}
	m.labelSync = now
	labels := map[string]string{}
	for k, v := range m.Labels() {
		if strings.HasPrefix(k, BcdLabelPrefix) && checkLabelKey(k) == nil && checkLabelValue(v) {
			labels[k] = v
		}
	}
	steps, err := planNode(ctx, m.Sys, m.NodeName, State{}, labels, nil)
	if err != nil {
		m.Log.Warn("read the Node's labels", "node", m.NodeName, "error", err.Error())
		return
	}
	for _, s := range steps {
		if err := s.Apply(ctx); err != nil {
			m.Log.Warn("label the Node", "node", m.NodeName, "error", err.Error())
			return
		}
	}
}

// Sync runs one pass.
func (m *Manager) Sync(ctx context.Context) {
	m.init()
	var conditions []Condition
	defer func() {
		previous := m.conditions.Swap(&conditions)
		if m.Changed != nil && (previous == nil && len(conditions) > 0 || previous != nil && !reflect.DeepEqual(*previous, conditions)) {
			m.Changed()
		}
	}()
	if !m.enabled() {
		if len(m.plugins) > 0 {
			m.Log.Info("device plugins stopped: the node is not a bcd-joined Kubernetes worker with gpu on")
		}
		m.stopAll()
		m.advertised.Store(&map[string]int{})
		if state, ok, err := ReadState(m.Sys); err == nil && ok && state.Released {
			conditions = append(conditions, Condition{Type: ConditionKubernetesReleased, Reason: "Released",
				Message: "compute released this machine from " + state.Server + ": Node " + state.NodeName + " is cordoned and drained"})
		}
		return
	}
	holds, err := ReadHolds(m.Sys)
	if err != nil {
		// Keep advertising what we had; never reap on a failed read.
		m.Log.Warn("read the holds", "error", err.Error())
		return
	}
	want := m.atoms(holds)
	// Another path to the GPUs (a second device plugin, a toolkit honouring NVIDIA_VISIBLE_DEVICES from any
	// pod) makes compute's bindings meaningless: offer nothing until it is closed (review round 5 #2).
	if exposed := m.exposure(ctx); exposed != nil {
		if len(m.plugins) > 0 || m.dra.serving() {
			m.Log.Warn("GPUs withdrawn from the kubelet", "reason", exposed.Message)
		}
		m.stopPlugins()
		if m.dra.lastPublished() {
			if err := m.dra.publish(ctx, nil); err != nil {
				m.Log.Warn("DRA ResourceSlice", "error", err.Error())
			}
		}
		m.dra.stop()
		m.advertised.Store(&map[string]int{})
		conditions = append(conditions, *exposed)
		conditions = append(conditions, m.reap(ctx, want, len(holds) > 0)...)
		m.syncLabels(ctx)
		return
	}
	counts := map[string]int{}
	for resource, atoms := range want {
		counts[resource] = len(atoms)
	}
	m.advertised.Store(&counts)
	if m.api() == APIDRA {
		// DRA or the device plugins, never both: one GPU offered twice could go to two pods.
		m.stopPlugins()
		if !m.dra.serving() {
			if err := m.dra.start(); err != nil {
				m.Log.Warn("DRA driver", "error", err.Error())
			}
		}
		if err := m.dra.publish(ctx, want); err != nil {
			m.Log.Warn("DRA ResourceSlice", "error", err.Error())
		}
		conditions = append(conditions, m.reap(ctx, want, len(holds) > 0)...)
		m.syncLabels(ctx)
		return
	}
	m.dra.stop()
	for _, resource := range Resources {
		atoms := want[resource]
		p := m.plugins[resource]
		if p == nil {
			if len(atoms) == 0 {
				continue
			}
			p = newPlugin(resource, m.Dir, m.logf)
			m.plugins[resource] = p
		}
		p.set(atoms)
		if !p.serving() {
			if err := p.start(ctx); err != nil {
				m.Log.Warn("device plugin", "resource", resource, "error", err.Error())
			}
		}
	}
	conditions = append(conditions, m.reap(ctx, want, len(holds) > 0)...)
	m.syncLabels(ctx)
}

// atoms builds each resource's advertised devices from the holds.
func (m *Manager) atoms(holds []Hold) map[string]map[string]atom {
	nvidia := nvidiaDevices(m.Sys)
	out := map[string]map[string]atom{}
	for _, h := range holds {
		for _, id := range h.Devices {
			resource := ResourceOf(id)
			gpu := GPUOf(id)
			a := atom{id: id, allocation: h.AllocationID, cdi: []string{cdiKind + "=" + id}, visible: gpu, healthy: true}
			if resource == ResourceGPUMig {
				a.visible = ""
				if m.MigUUID != nil {
					a.visible = m.MigUUID(id)
				}
			}
			if a.visible != "" && nvidia[a.visible] {
				a.cdi = append(a.cdi, nvidiaKind+"="+a.visible)
			}
			if m.NUMA != nil {
				if n, ok := m.NUMA(gpu); ok {
					a.numa = []int64{n}
				}
			}
			if m.Healthy != nil {
				a.healthy = m.Healthy(gpu)
			}
			if out[resource] == nil {
				out[resource] = map[string]atom{}
			}
			out[resource][deviceID(id, h.AllocationID)] = a
		}
	}
	return out
}

// reap deletes the pods whose containers still hold a bcd.dev device that is no longer advertised,
// once they have held it for Grace (the kubelet's view lags a release by a pass or two). Without the
// pod-resources socket it cannot, which is a condition while bcd holds devices for Kubernetes.
func (m *Manager) reap(ctx context.Context, want map[string]map[string]atom, holding bool) []Condition {
	if _, err := os.Stat(m.PodResources); err != nil {
		if !holding {
			return nil
		}
		m.Log.Warn("pod-resources socket missing: released devices cannot be reclaimed from pods", "socket", m.PodResources)
		return []Condition{{Type: ConditionPodResourcesUnavailable, Reason: "SocketMissing",
			Message: m.PodResources + " is missing: pods keep devices compute released until the kubelet serves it"}}
	}
	client := connect.NewClient[ListPodResourcesRequest, ListPodResourcesResponse](unixClient(m.PodResources),
		"http://localhost"+procListPodResources, connect.WithGRPC(), connect.WithCodec(codec{}))
	lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, err := client.CallUnary(lctx, connect.NewRequest(&ListPodResourcesRequest{}))
	if err != nil {
		m.Log.Warn("list pod resources", "error", err.Error())
		if !holding {
			return nil
		}
		return []Condition{{Type: ConditionPodResourcesUnavailable, Reason: "ListFailed", Message: err.Error()}}
	}
	now := m.Now()
	seen := map[string]bool{}
	node := m.nodeName()
	bound := m.dra.byDeviceName(want)
	for _, pod := range resp.Msg.Pods {
		key := pod.Namespace + "/" + pod.Name
		var released []string
		for _, c := range pod.Containers {
			// DRA: this node's gpu.bcd.dev devices of the pod's claims.
			for _, d := range c.Claimed {
				if d.Driver != DRADriverName || d.Pool != node {
					continue
				}
				if _, ok := bound[d.Device]; !ok {
					released = append(released, d.Device)
				}
			}
			for _, d := range c.Devices {
				if !strings.HasPrefix(d.ResourceName, "bcd.dev/") {
					continue
				}
				for _, id := range d.DeviceIDs {
					if _, ok := want[d.ResourceName][id]; !ok {
						released = append(released, id)
					}
				}
			}
		}
		if len(released) == 0 {
			continue
		}
		seen[key] = true
		first, ok := m.stale[key]
		if !ok {
			m.stale[key] = now
			continue
		}
		if now.Sub(first) < m.Grace {
			continue
		}
		asked, deleting := m.deleted[key]
		if deleting && now.Sub(asked) < forceAfter {
			continue
		}
		m.Log.Warn("deleting a pod that holds released devices", "pod", key, "devices", strings.Join(released, ","), "force", deleting)
		if err := m.DeletePod(ctx, pod.Namespace, pod.Name, deleting); err != nil {
			m.Log.Warn("delete pod", "pod", key, "error", err.Error())
		}
		m.deleted[key] = now
	}
	for key := range m.stale {
		if !seen[key] {
			delete(m.stale, key)
			delete(m.deleted, key)
		}
	}
	return nil
}
