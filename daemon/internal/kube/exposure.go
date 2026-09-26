package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
	"google.golang.org/protobuf/encoding/protowire"
)

// Condition is a node condition the Manager raises (agent StatusReport.conditions).
type Condition struct {
	Type, Reason, Message string
}

// Conditions the Manager raises.
const (
	// ForeignGpuExposure: something besides bcd hands this node's GPUs to pods (another device plugin
	// such as the GPU operator's nvidia.com/gpu, or a container toolkit that honours
	// NVIDIA_VISIBLE_DEVICES from unprivileged pods). bcd then stops offering GPUs: compute's bindings
	// mean nothing while any pod can take any GPU.
	ConditionForeignGpuExposure = "ForeignGpuExposure"
	// PodResourcesUnavailable: the kubelet's pod-resources socket is missing while bcd offers devices,
	// so released devices cannot be reclaimed from pods.
	ConditionPodResourcesUnavailable = "PodResourcesUnavailable"
	// KubernetesReleased: the spec dropped k8s-join; bcd cordoned and drained the Node.
	ConditionKubernetesReleased = "KubernetesReleased"
)

// Conditions returns the conditions of the last pass.
func (m *Manager) Conditions() []Condition {
	if p := m.conditions.Load(); p != nil {
		return append([]Condition(nil), (*p)...)
	}
	return nil
}

// ToolkitConfigs are where the NVIDIA container toolkit's config may live: the host package's and the
// GPU operator's.
var ToolkitConfigs = []string{
	"/etc/nvidia-container-runtime/config.toml",
	"/usr/local/nvidia/toolkit/.config/nvidia-container-runtime/config.toml",
}

var envvarUnprivileged = regexp.MustCompile(`(?m)^\s*accept-nvidia-visible-devices-envvar-when-unprivileged\s*=\s*(true|false)\s*$`)

// ContainerRuntimeConfigs are where the kubelet's container runtime keeps its config: containerd
// (plain, k3s, RKE2) and CRI-O; ContainerRuntimeDropIns their drop-in directories.
var (
	ContainerRuntimeConfigs = []string{
		"/etc/containerd/config.toml",
		"/var/lib/rancher/k3s/agent/etc/containerd/config.toml",
		"/var/lib/rancher/rke2/agent/etc/containerd/config.toml",
		"/etc/crio/crio.conf",
	}
	ContainerRuntimeDropIns = []string{"/etc/containerd/conf.d", "/etc/containerd/config.d", "/etc/crio/crio.conf.d"}
)

// nvidiaRuntimeBinary finds a runtime entry that runs the NVIDIA container runtime: containerd's
// BinaryName, CRI-O's runtime_path.
var nvidiaRuntimeBinary = regexp.MustCompile(`(?m)^\s*(?:BinaryName|runtime_path)\s*=\s*["']([^"']*nvidia-container-runtime[^"']*)["']`)

// NvidiaRuntimes returns the nvidia-container-runtime binaries the container runtime's config names
// (the .cdi variant, which takes CDI names only, excluded), and whether any container runtime
// config could be read at all.
func NvidiaRuntimes(sys hostconfig.System) (binaries []string, readable bool) {
	files := append([]string(nil), ContainerRuntimeConfigs...)
	for _, dir := range ContainerRuntimeDropIns {
		names, err := sys.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, n := range names {
			if strings.HasSuffix(n, ".toml") || strings.HasSuffix(n, ".conf") {
				files = append(files, dir+"/"+n)
			}
		}
	}
	seen := map[string]bool{}
	for _, file := range files {
		b, err := sys.ReadFile(file)
		if err != nil {
			continue
		}
		readable = true
		for _, m := range nvidiaRuntimeBinary.FindAllStringSubmatch(string(b), -1) {
			if bin := m[1]; !strings.HasSuffix(bin, ".cdi") && !seen[bin] {
				seen[bin] = true
				binaries = append(binaries, bin)
			}
		}
	}
	sort.Strings(binaries)
	return binaries, readable
}

// ToolkitConfigFor is the config a runtime binary reads: the GPU operator's toolkit keeps it beside
// its install directory (<dir>/toolkit/.config/nvidia-container-runtime/config.toml, its wrapper's
// XDG_CONFIG_HOME), the host package in /etc/nvidia-container-runtime.
func ToolkitConfigFor(binary string) string {
	if dir := filepath.Dir(binary); filepath.Base(dir) == "toolkit" {
		return dir + "/.config/nvidia-container-runtime/config.toml"
	}
	return ToolkitConfigs[0]
}

// ToolkitExposure reports toolkit configs that let an unprivileged pod pick GPUs with
// NVIDIA_VISIBLE_DEVICES: the key true, or absent (the toolkit's default is true). For each
// nvidia-container-runtime the container runtime is configured with, its config must exist and say
// false: missing or unreadable, the toolkit takes its defaults (security review 2 #3b). The other
// known configs count only when present.
func ToolkitExposure(sys hostconfig.System) string {
	var why []string
	checked := map[string]bool{}
	check := func(path, runtime string) {
		if checked[path] {
			return
		}
		checked[path] = true
		b, err := sys.ReadFile(path)
		if err != nil {
			if runtime != "" {
				why = append(why, fmt.Sprintf("the container runtime runs %s, but its config %s is missing or unreadable (the toolkit then accepts NVIDIA_VISIBLE_DEVICES from any pod)", runtime, path))
			}
			return
		}
		m := envvarUnprivileged.FindStringSubmatch(string(b))
		if m == nil || m[1] == "true" {
			why = append(why, path+" lets unprivileged pods choose GPUs with NVIDIA_VISIBLE_DEVICES (set accept-nvidia-visible-devices-envvar-when-unprivileged = false; CDI only)")
		}
	}
	binaries, _ := NvidiaRuntimes(sys)
	for _, bin := range binaries {
		check(ToolkitConfigFor(bin), bin)
	}
	for _, path := range ToolkitConfigs {
		check(path, "")
	}
	return strings.Join(why, "; ")
}

// RuntimeConfigUnverifiable is the reason a hosted node cannot rule the toolkit out: no container
// runtime config is readable (a hostPath mount of type DirectoryOrCreate makes a missing directory
// look empty; security review 2 #3c). "" when one is.
func RuntimeConfigUnverifiable(sys hostconfig.System) string {
	if _, readable := NvidiaRuntimes(sys); readable {
		return ""
	}
	return "no container runtime config is readable (" + strings.Join(ContainerRuntimeConfigs, ", ") +
		"): bcd cannot tell whether the NVIDIA toolkit hands GPUs to pods (mount the runtime's config read-only, as a File or Directory, never DirectoryOrCreate)"
}

// sliceList is the part of a ResourceSlice list the foreign-driver check reads.
type sliceList struct {
	Items []struct {
		Spec struct {
			Driver   string `json:"driver"`
			NodeName string `json:"nodeName"`
			Devices  []any  `json:"devices"`
		} `json:"spec"`
	} `json:"items"`
}

// gpuDriverName matches a DRA driver that hands out GPUs (gpu.nvidia.com, gpu.amd.com, …).
var gpuDriverName = regexp.MustCompile(`(?i)(^|[.-])(gpu|nvidia)([.-]|$)`)

// ForeignDRADrivers lists the DRA drivers besides gpu.bcd.dev that publish GPU devices for node
// (security review 2 #3a), read with the kubelet's credentials. An API server without
// resource.k8s.io, or one that refuses the list, is an error: no evidence either way.
func ForeignDRADrivers(ctx context.Context, sys hostconfig.System, node string) ([]string, error) {
	out, err := sys.Run(ctx, kubectl("get", "resourceslices", "--field-selector", "spec.nodeName="+node, "-o", "json"))
	if err != nil {
		return nil, err
	}
	var list sliceList
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, it := range list.Items {
		d := it.Spec.Driver
		if d != DRADriverName && len(it.Spec.Devices) > 0 && gpuDriverName.MatchString(d) {
			seen[d] = true
		}
	}
	drivers := keys(seen)
	sort.Strings(drivers)
	return drivers, nil
}

// draForeignEvery spaces the ResourceSlice reads (one kubectl per minute, not per pass).
const draForeignEvery = time.Minute

// foreignDRA caches ForeignDRADrivers for draForeignEvery.
type foreignDRA struct {
	mu      sync.Mutex
	at      time.Time
	drivers []string
}

func (m *Manager) foreignDRADrivers(ctx context.Context) []string {
	m.draForeign.mu.Lock()
	defer m.draForeign.mu.Unlock()
	now := m.Now()
	if !m.draForeign.at.IsZero() && now.Sub(m.draForeign.at) < draForeignEvery {
		return m.draForeign.drivers
	}
	m.draForeign.at = now
	drivers, err := ForeignDRADrivers(ctx, m.Sys, m.nodeName())
	if err != nil {
		m.Log.Debug("ResourceSlices unreadable: other DRA drivers are not checked", "error", err.Error())
		drivers = nil
	}
	m.draForeign.drivers = drivers
	return drivers
}

// AllocatableResponse is podresources v1.AllocatableResourcesResponse (the devices only).
type AllocatableResponse struct{ Devices []ContainerDevices }

func (*AllocatableResponse) marshal() []byte { return nil }

func (m *AllocatableResponse) unmarshal(b []byte) error {
	return fields(b, func(num protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
		if num != 1 {
			return nil
		}
		var d ContainerDevices
		err := fields(raw, func(num protowire.Number, _ protowire.Type, _ uint64, s []byte) error {
			switch num {
			case 1:
				d.ResourceName = string(s)
			case 2:
				d.DeviceIDs = append(d.DeviceIDs, string(s))
			}
			return nil
		})
		m.Devices = append(m.Devices, d)
		return err
	})
}

const procAllocatable = "/v1.PodResourcesLister/GetAllocatableResources"

// foreignGpuResources lists the GPU resources the kubelet can allocate that are not bcd's
// (nvidia.com/gpu, nvidia.com/mig-…), from pod-resources' GetAllocatableResources.
func (m *Manager) foreignGpuResources(ctx context.Context) ([]string, error) {
	if _, err := os.Stat(m.PodResources); err != nil {
		return nil, err
	}
	client := connect.NewClient[ListPodResourcesRequest, AllocatableResponse](unixClient(m.PodResources),
		"http://localhost"+procAllocatable, connect.WithGRPC(), connect.WithCodec(codec{}))
	lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, err := client.CallUnary(lctx, connect.NewRequest(&ListPodResourcesRequest{}))
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, d := range resp.Msg.Devices {
		if strings.HasPrefix(d.ResourceName, "nvidia.com/") && len(d.DeviceIDs) > 0 {
			seen[d.ResourceName] = true
		}
	}
	out := keys(seen)
	sort.Strings(out)
	return out, nil
}

// exposure is the ForeignGpuExposure condition, or nil when nothing but bcd hands out GPUs.
func (m *Manager) exposure(ctx context.Context) *Condition {
	var why []string
	if foreign, err := m.foreignGpuResources(ctx); err == nil && len(foreign) > 0 {
		why = append(why, "the kubelet also offers "+strings.Join(foreign, ", ")+" (disable that device plugin: devicePlugin.enabled=false in the GPU operator)")
	}
	if drivers := m.foreignDRADrivers(ctx); len(drivers) > 0 {
		why = append(why, "the ResourceSlices of this node also offer GPUs through "+strings.Join(drivers, ", ")+" (disable that DRA driver on nodes compute manages)")
	}
	if msg := ToolkitExposure(m.Sys); msg != "" {
		why = append(why, msg)
	}
	if m.Hosted {
		if msg := RuntimeConfigUnverifiable(m.Sys); msg != "" {
			why = append(why, msg)
		}
	}
	if len(why) == 0 {
		return nil
	}
	return &Condition{Type: ConditionForeignGpuExposure, Reason: "OtherGpuPath", Message: "bcd offers no GPUs: " + strings.Join(why, "; ")}
}
