package agent

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// Hold atoms (PLAN.md §10.6): a whole GPU ("gpu", its UUID), a MIG compute instance ("gpu.mig",
// "<gpuUuid>/gi<g>/ci<c>") or a timeslice/MPS slot ("gpu.slot", "<gpuUuid>/s<k>"). A MIG instance
// and a slot name their parent GPU, so the node can refuse a hold that would share a GPU another
// hold (or a VM) has whole.

var (
	migAtom  = regexp.MustCompile(`^([^/]+)/gi([0-9]+)/ci([0-9]+)$`)
	slotAtom = regexp.MustCompile(`^([^/]+)/s([0-9]+)$`)
)

// atom is one held device, resolved against the inventory.
type atom struct {
	id    string
	class string
	// parent is the GPU it lives on (its own UUID for a whole GPU).
	parent string
	// visible is what NVIDIA_VISIBLE_DEVICES names: the GPU's UUID, or the MIG instance's "MIG-…".
	visible string
}

// whole reports whether the atom is its parent GPU entirely.
func (a atom) whole() bool { return a.class == "gpu" }

// resolveAtom checks a device against the inventory; reason is "unsupported-device" or
// "device-missing" when it cannot be held.
func resolveAtom(inv *inventory.NodeInventory, dev *agentv1.AssignedDevice) (atom, string, string) {
	id, class := dev.GetId(), dev.GetDeviceClass()
	if class == "" {
		class = "gpu"
	}
	gpu := func(uuid string) *inventory.Gpu {
		if inv == nil || inv.Gpus == nil {
			return nil
		}
		for _, g := range inv.Gpus.Gpus {
			if g.Uuid == uuid {
				return g
			}
		}
		return nil
	}
	switch class {
	case "gpu":
		if gpu(id) == nil {
			return atom{}, "device-missing", id + " not present"
		}
		return atom{id: id, class: class, parent: id, visible: id}, "", ""
	case "gpu.mig":
		m := migAtom.FindStringSubmatch(id)
		if m == nil {
			return atom{}, "unsupported-device", fmt.Sprintf("%q is not a MIG instance id (<gpu>/gi<g>/ci<c>)", id)
		}
		g := gpu(m[1])
		if g == nil {
			return atom{}, "device-missing", m[1] + " not present"
		}
		gi, _ := strconv.ParseUint(m[2], 10, 32)
		ci, _ := strconv.ParseUint(m[3], 10, 32)
		if g.Mig != nil {
			for _, in := range g.Mig.Instances {
				if uint64(in.GiId) == gi && uint64(in.CiId) == ci && in.Uuid != "" {
					return atom{id: id, class: class, parent: m[1], visible: in.Uuid}, "", ""
				}
			}
		}
		// The layout the control plane booked is not (yet) the GPU's: mig-layout applies it first.
		return atom{}, "device-missing", fmt.Sprintf("%s has no MIG instance gi%d/ci%d", m[1], gi, ci)
	case "gpu.slot":
		m := slotAtom.FindStringSubmatch(id)
		if m == nil {
			return atom{}, "unsupported-device", fmt.Sprintf("%q is not a GPU slot id (<gpu>/s<k>)", id)
		}
		if gpu(m[1]) == nil {
			return atom{}, "device-missing", m[1] + " not present"
		}
		return atom{id: id, class: class, parent: m[1], visible: m[1]}, "", ""
	}
	return atom{}, "unsupported-device", fmt.Sprintf("device class %s cannot be held", class)
}

// holdConflict says why atoms of allocation id cannot be held beside the other holds (claimed: held
// atom id → allocation) and the GPUs VMs have (passed: GPU UUID → instance), or "".
func holdConflict(id string, atoms []atom, claimed map[string]string, passed map[string]string) string {
	seen := map[string]bool{}
	for _, a := range atoms {
		if seen[a.id] {
			return "a device is listed twice"
		}
		seen[a.id] = true
		if vm, ok := passed[a.parent]; ok {
			return a.parent + " is passed through to instance " + vm
		}
		for held, owner := range claimed {
			if owner == id {
				continue
			}
			heldParent, _, _ := strings.Cut(held, "/")
			switch {
			case held == a.id:
				return a.id + " is assigned to " + owner
			case a.whole() && heldParent == a.parent:
				// The whole GPU, while part of it is held.
				return a.parent + " has " + held + " assigned to " + owner
			case !a.whole() && held == a.parent:
				// Part of a GPU another hold has whole.
				return a.parent + " is assigned to " + owner
			}
		}
	}
	return ""
}

// cdiDeviceName is an atom id as a CDI device name ([A-Za-z0-9_.:-], no "/"): the real id is
// carried in the device's annotations.
func cdiDeviceName(id string) string {
	return strings.NewReplacer("/", "_").Replace(id)
}

// holdSlice is the cgroup-v2 slice a hold with limits runs its workloads in (PLAN.md §3.8).
func holdSlice(allocationID string) string { return "bcd-alloc-" + allocationID + ".slice" }

// mpsPipeDir is where the MPS control daemon (hostconfig's gpu-sharing unit) listens; slot holds get
// it as CUDA_MPS_PIPE_DIRECTORY when it runs.
const mpsPipeDir = "/run/nvidia-mps"
