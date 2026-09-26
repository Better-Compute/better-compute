package kube

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
)

// InUse reports whether a pod may still hold a device of an allocation bound to Kubernetes on this
// node; InUseDevices also checks the host's processes for the allocation's whole GPUs. The devices
// converger asks before reporting a Kubernetes hold released (review round 5 #3), so compute
// re-books a GPU only once the pods let go of it. It fails closed (security review 2 #1, #2):
//   - a node that is or was a Kubernetes worker (hosted, a k8s-join record even released, a kubelet
//     configuration on disk) whose kubelet cannot be asked answers true: false only on a node that
//     never was a worker;
//   - a gpu.bcd.dev device still prepared for a claim (the DRA driver's persisted record) is in use
//     until the kubelet unprepares the claim, whatever pod-resources says: its DRA fields need the
//     KubeletPodResourcesDynamicResources gate, off before 1.34;
//   - a process in a pod's cgroup (kubepods) with the GPU's /dev/nvidia<minor> open is a backstop for
//     what pod-resources does not account (static pods, a lost kubelet checkpoint). Only whole GPUs:
//     MIG instances and slots share their GPU's device node with other holds.
func (m *Manager) InUse(ctx context.Context, allocationID string) bool {
	return m.InUseDevices(ctx, allocationID, nil)
}

// InUseDevices is InUse with the allocation's device ids (atoms), for the process backstop.
func (m *Manager) InUseDevices(ctx context.Context, allocationID string, deviceIDs []string) bool {
	m.init()
	if !m.worker() {
		return false
	}
	if m.dra.preparedWithSuffix(draDeviceName("", allocationID)) {
		return true
	}
	if m.podProcessHolds(deviceIDs) {
		return true
	}
	if _, err := os.Stat(m.PodResources); err != nil {
		return true
	}
	client := connect.NewClient[ListPodResourcesRequest, ListPodResourcesResponse](unixClient(m.PodResources),
		"http://localhost"+procListPodResources, connect.WithGRPC(), connect.WithCodec(codec{}))
	lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, err := client.CallUnary(lctx, connect.NewRequest(&ListPodResourcesRequest{}))
	if err != nil {
		return true
	}
	suffix := "@" + allocationID
	tag := draDeviceName("", allocationID) // "-<8 hex>"
	node := m.nodeName()
	for _, pod := range resp.Msg.Pods {
		for _, c := range pod.Containers {
			for _, d := range c.Devices {
				if !strings.HasPrefix(d.ResourceName, "bcd.dev/") {
					continue
				}
				for _, id := range d.DeviceIDs {
					if strings.HasSuffix(id, suffix) {
						return true
					}
				}
			}
			for _, d := range c.Claimed {
				if d.Driver == DRADriverName && d.Pool == node && strings.HasSuffix(d.Device, tag) {
					return true
				}
			}
		}
	}
	return false
}

// kubeletConfigYAML is the kubelet's configuration (kubeadm writes it; so do most installers).
const kubeletConfigYAML = "/var/lib/kubelet/config.yaml"

// worker reports whether this node is or was a Kubernetes worker: hosted, a k8s-join record (even a
// released one), or the kubelet's kubeconfig, configuration or pod-resources socket on disk. A record
// or file that cannot be read counts as one.
func (m *Manager) worker() bool {
	if m.Hosted {
		return true
	}
	if _, ok, err := ReadState(m.Sys); err != nil || ok {
		return true
	}
	for _, path := range []string{KubeletConf, kubeletConfigYAML} {
		if _, err := m.Sys.ReadFile(path); err == nil || !errors.Is(err, fs.ErrNotExist) {
			return true
		}
	}
	if _, err := os.Stat(m.PodResources); err == nil {
		return true
	}
	return false
}

// offersGPUs reports whether this node hands its bound GPUs to pods at all (hosted, or joined with gpu
// on and not released): otherwise no bcd.dev device is legitimately held by any pod.
func (m *Manager) offersGPUs() bool {
	if m.Hosted {
		return true
	}
	state, ok, err := ReadState(m.Sys)
	return err == nil && ok && state.GPU && !state.Released
}

// podProcessHolds reports whether a process in a pod's cgroup has one of the whole GPUs of deviceIDs
// open (/dev/nvidia<minor>, the minor from /proc/driver/nvidia/gpus/*/information). An unreadable
// driver directory or process table is no evidence either way.
func (m *Manager) podProcessHolds(deviceIDs []string) bool {
	gpus := map[string]bool{}
	for _, id := range deviceIDs {
		if ResourceOf(id) == ResourceGPU {
			gpus[GPUOf(id)] = true
		}
	}
	return m.podProcessHoldsGPUs(gpus)
}

// podProcessHoldsGPUs reports whether a process in a pod's cgroup has one of gpus (UUIDs) open.
func (m *Manager) podProcessHoldsGPUs(gpus map[string]bool) bool {
	// As the DaemonSet (no hostPID) /proc is bcd's own pod: no evidence there, and bcd's own
	// nvidia-smi would look like a holder. Hosted relies on pod-resources and the DRA record.
	if m.Hosted && m.ProcRoot == "" {
		return false
	}
	if len(gpus) == 0 {
		return false
	}
	nodes := map[string]bool{}
	for uuid, minor := range m.gpuMinors() {
		if gpus[uuid] {
			nodes["/dev/nvidia"+strconv.Itoa(minor)] = true
		}
	}
	if len(nodes) == 0 {
		return false
	}
	procs, err := os.ReadDir(m.procRoot())
	if err != nil {
		return false
	}
	for _, p := range procs {
		if _, err := strconv.Atoi(p.Name()); err != nil {
			continue
		}
		dir := filepath.Join(m.procRoot(), p.Name())
		cg, err := os.ReadFile(filepath.Join(dir, "cgroup"))
		if err != nil || !strings.Contains(string(cg), "kubepods") {
			continue
		}
		fds, err := os.ReadDir(filepath.Join(dir, "fd"))
		if err != nil {
			continue
		}
		for _, fd := range fds {
			if target, err := os.Readlink(filepath.Join(dir, "fd", fd.Name())); err == nil && nodes[target] {
				m.Log.Warn("a pod process still has a released GPU open", "pid", p.Name(), "device", target)
				return true
			}
		}
	}
	return false
}

func (m *Manager) procRoot() string {
	if m.ProcRoot != "" {
		return m.ProcRoot
	}
	return "/proc"
}

// gpuMinors maps each GPU's UUID to its device minor (/dev/nvidia<minor>), from the driver's
// /proc/driver/nvidia/gpus/<bus>/information.
func (m *Manager) gpuMinors() map[string]int {
	out := map[string]int{}
	dir := filepath.Join(m.procRoot(), "driver", "nvidia", "gpus")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		raw, err := os.ReadFile(filepath.Join(dir, e.Name(), "information"))
		if err != nil {
			continue
		}
		uuid, minor := "", -1
		for _, line := range strings.Split(string(raw), "\n") {
			key, value, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			switch strings.TrimSpace(key) {
			case "GPU UUID":
				uuid = strings.TrimSpace(value)
			case "Device Minor":
				if n, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
					minor = n
				}
			}
		}
		if uuid != "" && minor >= 0 {
			out[uuid] = minor
		}
	}
	return out
}

// HeldOutside reports whether a pod may hold a bcd GPU of an allocation not in live: a device plugin
// id <atom>@<allocation>, or a gpu.bcd.dev device (prepared for a claim in the DRA driver's record,
// or claimed by a pod in pod-resources) whose name carries another allocation's tag, or a pod
// process with one of gpuUUIDs open. gpuUUIDs are the whole GPUs no live allocation holds (a
// process cannot be told apart by allocation, so a live one's GPUs would always match). It fails
// closed like InUse: true when a node that is or was a worker cannot ask its kubelet, or the DRA
// record is unreadable; false on a node that never was a worker. The devices converger clears an
// unreadable releasing.json's blanket claim once it answers false.
func (m *Manager) HeldOutside(ctx context.Context, live map[string]bool, gpuUUIDs []string) bool {
	m.init()
	if !m.worker() {
		return false
	}
	tags := map[string]bool{}
	for alloc := range live {
		tags[draDeviceName("", alloc)] = true
	}
	outside := func(device string) bool {
		i := strings.LastIndex(device, "-")
		return i < 0 || !tags[device[i:]]
	}
	if m.dra.preparedOutside(outside) {
		return true
	}
	gpus := map[string]bool{}
	for _, uuid := range gpuUUIDs {
		gpus[uuid] = true
	}
	if m.podProcessHoldsGPUs(gpus) {
		return true
	}
	if _, err := os.Stat(m.PodResources); err != nil {
		return true
	}
	client := connect.NewClient[ListPodResourcesRequest, ListPodResourcesResponse](unixClient(m.PodResources),
		"http://localhost"+procListPodResources, connect.WithGRPC(), connect.WithCodec(codec{}))
	lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, err := client.CallUnary(lctx, connect.NewRequest(&ListPodResourcesRequest{}))
	if err != nil {
		return true
	}
	node := m.nodeName()
	for _, pod := range resp.Msg.Pods {
		for _, c := range pod.Containers {
			for _, d := range c.Devices {
				if !strings.HasPrefix(d.ResourceName, "bcd.dev/") {
					continue
				}
				for _, id := range d.DeviceIDs {
					if _, alloc, ok := strings.Cut(id, "@"); !ok || !live[alloc] {
						return true
					}
				}
			}
			for _, d := range c.Claimed {
				if d.Driver == DRADriverName && d.Pool == node && outside(d.Device) {
					return true
				}
			}
		}
	}
	return false
}
