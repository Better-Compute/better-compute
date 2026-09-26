package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/converge"
	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
	"github.com/better-compute/better-compute/daemon/internal/kube"
	"google.golang.org/protobuf/proto"
)

// HostUnits returns the config units bcd applies from NodeSpec.host, in convergence order, with a
// k8s-join that joins no cluster root has not allowed (HostUnitsWith sets the allowlist). bcd node
// plans with HostUnitsWith and bcd helper applies with it (as root), so both hold the same units.
func HostUnits(o hostconfig.Options) *hostconfig.Registry {
	return HostUnitsWith(o, kube.JoinUnit{RequireAllowed: true})
}

// hostConverger applies NodeSpec.host (hostconfig): kernel modules and parameters, hugepages, the
// NVIDIA driver, Fabric Manager, the MIG layout, GPU sharing and the container toolkit. Under bcd
// helper the node plans, unprivileged, and the helper applies each unit that is not converged.
// Units report standing conditions (FabricManagerDown, MPSDown) with the section's status.
type hostConverger struct {
	a   *Agent
	sys hostconfig.System
	// helper applies units for an unprivileged node; nil applies them in this process.
	helper *helper.Client

	mu         sync.Mutex
	conditions []*agentv1.Condition
}

func newHostConverger(a *Agent) *hostConverger {
	c := &hostConverger{a: a, sys: &hostconfig.OSSystem{Root: a.host.Path("/")}}
	if real, ok := a.host.(*RealHost); ok && real.Helper != nil {
		c.helper = real.Helper
	}
	return c
}

func (c *hostConverger) Section() converge.Section { return converge.SectionHost }

func (c *hostConverger) Plan(ctx context.Context, desired []byte) ([]converge.Action, error) {
	section := &agentv1.HostSection{}
	if err := proto.Unmarshal(desired, section); err != nil {
		return nil, converge.Terminal(fmt.Errorf("host section: %w", err))
	}
	configs := make([]hostconfig.Config, 0, len(section.GetUnits()))
	for _, u := range section.GetUnits() {
		configs = append(configs, hostconfig.Config{Unit: u.GetUnit(), Settings: json.RawMessage(u.GetConfigJson())})
	}
	busy := c.busyGPUs()
	reg := HostUnitsWith(hostconfig.Options{GPUBusy: func(uuid string) bool { return gpuBusy(busy, uuid) }}, c.a.kubeJoinUnit())
	if c.helper != nil {
		h := c.helper
		reg.Delegate = func(ctx context.Context, unit string, settings json.RawMessage) error {
			if unit == kube.UnitName && settings != nil {
				if err := c.a.stageKubeToken(ctx, c.sys, settings); err != nil {
					return fmt.Errorf("stage the bootstrap token: %w", err)
				}
			}
			return h.HostUnit(ctx, unit, settings, busy)
		}
	}
	actions, err := reg.Plan(ctx, c.sys, configs)
	c.setConditions(reg.Conditions(ctx, c.sys, configs))
	if err != nil {
		return nil, err
	}
	// What the units change shows in the inventory (driver version, MIG devices, hugepages).
	for i := range actions {
		apply := actions[i].Apply
		actions[i].Apply = func(ctx context.Context) error {
			err := apply(ctx)
			go c.a.refreshSections()
			return err
		}
	}
	return actions, nil
}

// busyGPUs lists the devices the live holds use.
func (c *hostConverger) busyGPUs() []string {
	if c.a.devices == nil {
		return nil
	}
	assigned := c.a.devices.assignedDevices()
	out := make([]string, 0, len(assigned))
	for id := range assigned {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// gpuBusy reports whether a GPU holds allocations: a hold names it, or one of its atoms (a hold's
// device ids name their GPU first: "<gpuUuid>/gi<g>/ci<c>" for MIG, "<gpuUuid>/s<k>" for slots).
func gpuBusy(assigned []string, uuid string) bool {
	for _, id := range assigned {
		if parent, _, _ := strings.Cut(id, "/"); parent == uuid {
			return true
		}
	}
	return false
}

func (c *hostConverger) setConditions(conds []hostconfig.Condition) {
	out := make([]*agentv1.Condition, 0, len(conds))
	for _, h := range conds {
		out = append(out, &agentv1.Condition{
			Type:    h.Type,
			Status:  agentv1.ConditionStatus_CONDITION_STATUS_TRUE,
			Reason:  h.Reason,
			Message: h.Message,
		})
	}
	c.mu.Lock()
	c.conditions = out
	c.mu.Unlock()
}

// currentConditions are the units' conditions of the last pass (StatusReport.conditions).
func (c *hostConverger) currentConditions() []*agentv1.Condition {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return cloneConditions(c.conditions)
}
