package kube

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"regexp"
	"sort"
	"strings"
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

// toolkitExposure reports a toolkit config that lets an unprivileged pod pick GPUs with
// NVIDIA_VISIBLE_DEVICES: the key true, or absent (the toolkit's default is true). An unreadable or
// missing file is not evidence.
func toolkitExposure(sys hostconfig.System) string {
	for _, path := range ToolkitConfigs {
		b, err := sys.ReadFile(path)
		if errors.Is(err, fs.ErrNotExist) || err != nil {
			continue
		}
		m := envvarUnprivileged.FindStringSubmatch(string(b))
		if m == nil || m[1] == "true" {
			return path + " lets unprivileged pods choose GPUs with NVIDIA_VISIBLE_DEVICES (set accept-nvidia-visible-devices-envvar-when-unprivileged = false; CDI only)"
		}
	}
	return ""
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
	if msg := toolkitExposure(m.Sys); msg != "" {
		why = append(why, msg)
	}
	if len(why) == 0 {
		return nil
	}
	return &Condition{Type: ConditionForeignGpuExposure, Reason: "OtherGpuPath", Message: "bcd offers no GPUs: " + strings.Join(why, "; ")}
}
