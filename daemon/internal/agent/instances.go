package agent

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/converge"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
	"google.golang.org/protobuf/proto"
)

// The instances converger (PLAN.md §12, v0.3), FakeHypervisor's rules on real runtimes:
//   - the section is the whole desired set: a domain bcd created that no spec names is removed; a
//     domain bcd did not create is never touched, only reported (the control plane flags a leak);
//   - user data is fetched with SecretRequest bound to the instance's allocation before the domain
//     is defined; the spec never carries it; a refusal fails the instance, an unavailable broker
//     keeps the section PROGRESSING;
//   - the status lists every domain the runtimes hold (instances_complete).

var imageFormats = map[string]bool{"raw": true, "qcow2": true, "iso": true}

type instancesConverger struct {
	a *Agent
	// specs and specErrors are the last pass's instances and those that failed.
	specs      []*agentv1.InstanceSpec
	specErrors map[string]string
}

func (c *instancesConverger) Section() converge.Section { return converge.SectionInstances }

func (c *instancesConverger) runtime(name string) runtime.Runtime {
	for _, r := range c.a.o.Runtimes {
		if r.Name() == name {
			return r
		}
	}
	return nil
}

func wantedState(s agentv1.InstanceDesiredState) string {
	switch s {
	case agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING:
		return runtime.StateRunning
	case agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_PAUSED:
		return runtime.StatePaused
	}
	return runtime.StateStopped
}

func (c *instancesConverger) Plan(_ context.Context, desired []byte) ([]converge.Action, error) {
	section := &agentv1.InstancesSection{}
	if err := proto.Unmarshal(desired, section); err != nil {
		return nil, converge.Terminal(fmt.Errorf("instances section: %w", err))
	}
	c.specs = section.GetInstances()
	if len(c.a.o.Runtimes) == 0 {
		if len(section.GetInstances()) > 0 {
			return nil, converge.Terminal(errors.New("this host runs no instance runtime"))
		}
		return nil, nil
	}
	// One action walks every instance, so a broken one never blocks the others.
	return []converge.Action{{Description: "converge instances", Apply: func(ctx context.Context) error { return c.apply(ctx, section) }}}, nil
}

func (c *instancesConverger) apply(ctx context.Context, section *agentv1.InstancesSection) error {
	domains := map[string]runtime.Domain{}
	for _, r := range c.a.o.Runtimes {
		list, err := r.List(ctx)
		if err != nil {
			return fmt.Errorf("%s: %w", r.Name(), err)
		}
		for _, d := range list {
			domains[d.ID] = d
		}
	}
	named := map[string]bool{}
	for _, s := range section.GetInstances() {
		named[s.GetInstanceId()] = true
	}
	destroy := func(d runtime.Domain) error {
		r := c.runtime(d.Runtime)
		if r == nil {
			return nil
		}
		c.a.log.Info("instance removed", "instance", d.ID)
		return r.Destroy(ctx, d.ID)
	}
	ids := make([]string, 0, len(domains))
	for id := range domains {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if d := domains[id]; d.Managed && !named[id] {
			if err := destroy(d); err != nil {
				return err
			}
		}
	}
	specErrors := map[string]string{}
	var waiting []string
	for _, spec := range section.GetInstances() {
		id := spec.GetInstanceId()
		existing, exists := domains[id]
		if spec.GetDesiredState() == agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_DELETED {
			if exists && existing.Managed {
				if err := destroy(existing); err != nil {
					specErrors[id] = err.Error()
				}
			}
			continue
		}
		if exists && !existing.Managed {
			specErrors[id] = "a domain named " + id + " exists that bcd did not create"
			continue
		}
		r := c.runtime(spec.GetRuntime())
		if r == nil {
			specErrors[id] = "runtime " + spec.GetRuntime() + " is not installed on this host"
			continue
		}
		if img := spec.GetImage(); !exists && (img == nil || !imageFormats[img.GetFormat()] || img.GetUrl() == "" || len(img.GetSha256()) == 0) {
			specErrors[id] = fmt.Sprintf("image %s is not a raw, qcow2 or iso image", img.GetRef())
			continue
		}
		var userData []byte
		if ref := spec.GetUserDataRef(); ref != "" && !exists {
			v, err := c.a.RequestSecret(ctx, ref, pki.SecretBinding{AllocationID: spec.GetAllocationId()})
			if errors.Is(err, pki.ErrRefused) {
				specErrors[id] = "user data refused: " + err.Error()
				continue
			}
			if err != nil {
				waiting = append(waiting, id)
				continue
			}
			userData = v
		}
		if err := r.Ensure(ctx, spec, userData); err != nil {
			specErrors[id] = err.Error()
			continue
		}
		if err := r.SetState(ctx, id, wantedState(spec.GetDesiredState())); err != nil {
			specErrors[id] = err.Error()
		}
	}
	c.specErrors = specErrors
	if len(waiting) > 0 {
		return fmt.Errorf("waiting for the user data of %s", strings.Join(waiting, ", "))
	}
	if len(specErrors) > 0 {
		var msgs []string
		for id, m := range specErrors {
			msgs = append(msgs, id+": "+m)
		}
		sort.Strings(msgs)
		msg := strings.Join(msgs, "; ")
		if len(msg) > 1024 {
			msg = msg[:1024]
		}
		return converge.Terminal(errors.New(msg))
	}
	return nil
}

// report lists the runtimes' domains, plus specs that failed before a domain existed.
func (c *instancesConverger) report(ctx context.Context, specErrors map[string]string, specs []*agentv1.InstanceSpec) []*agentv1.InstanceStatus {
	var out []*agentv1.InstanceStatus
	seen := map[string]bool{}
	for _, r := range c.a.o.Runtimes {
		list, err := r.List(ctx)
		if err != nil {
			continue
		}
		for _, d := range list {
			seen[d.ID] = true
			st := &agentv1.InstanceStatus{InstanceId: d.ID, Runtime: d.Runtime, Addresses: d.Addresses, Message: d.Message}
			switch d.State {
			case runtime.StateRunning:
				st.State = agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING
			case runtime.StatePaused:
				st.State = agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_PAUSED
			case runtime.StateError:
				st.State = agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR
			default:
				st.State = agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_STOPPED
			}
			if msg, failed := specErrors[d.ID]; failed && d.Managed {
				st.State, st.Message = agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR, msg
			}
			out = append(out, st)
		}
	}
	for _, s := range specs {
		if msg, failed := specErrors[s.GetInstanceId()]; failed && !seen[s.GetInstanceId()] {
			out = append(out, &agentv1.InstanceStatus{InstanceId: s.GetInstanceId(), Runtime: s.GetRuntime(),
				State: agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR, Message: msg})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].InstanceId < out[j].InstanceId })
	return out
}
