package agent

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

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
//   - the status lists every domain the runtimes hold (instances_complete);
//   - a memory restore's guest is given its own identity once it runs (rebind.go).

var imageFormats = map[string]bool{"raw": true, "qcow2": true, "iso": true}

type instancesConverger struct {
	a *Agent
	// specs and specErrors are the last pass's instances and those that failed. specs is also read
	// off the converger (devices, gpu.reset, diag.dcgm): through currentSpecs, under specsMu.
	specsMu    sync.Mutex
	specs      []*agentv1.InstanceSpec
	specErrors map[string]string
	// exhausted: the last pass's starts host-side admission refused (admission.go); they stay
	// stopped, with the reason as their message, and are tried again.
	exhausted map[string]string
	// firewall is the network-policy ruleset last loaded (netpolicy.go); "" before the first pass.
	firewall string
	// stale: the loaded table went missing (an external flush); the next pass loads it again.
	stale atomic.Bool
	// volumes is the host's volume store (runtime.VolumeDir), shared with the runtimes.
	volumes *runtime.Volumes
}

// ensureVolumes creates and grows the section's volumes; it returns the ones that failed, and the
// ones that grew.
func (c *instancesConverger) ensureVolumes(section *agentv1.InstancesSection) (failed map[string]string, grown map[string]bool) {
	failed, grown = map[string]string{}, map[string]bool{}
	for _, hv := range section.GetVolumes() {
		grew, err := c.volumes.Ensure(hv)
		if err != nil {
			failed[hv.GetVolumeId()] = err.Error()
			c.a.log.Warn("volume not ensured", "volume", hv.GetVolumeId(), "err", err.Error())
		}
		grown[hv.GetVolumeId()] = grew
	}
	return failed, grown
}

// tellGrownVolumes tells a running or paused instance's runtime which of its volumes grew this pass,
// so the guest sees the new size now rather than at its next start.
func (c *instancesConverger) tellGrownVolumes(ctx context.Context, r runtime.Runtime, spec *agentv1.InstanceSpec, grown map[string]bool) {
	g, ok := r.(runtime.VolumeGrower)
	if !ok {
		return
	}
	for _, iv := range spec.GetVolumes() {
		if !grown[iv.GetVolumeId()] {
			continue
		}
		v, err := c.volumes.Get(iv.GetVolumeId())
		if err == nil {
			err = g.GrowVolume(ctx, spec.GetInstanceId(), runtime.AttachedVolume{Volume: v, ReadOnly: iv.GetReadOnly()})
		}
		if err != nil {
			c.a.log.Warn("the guest was not told its volume grew; it sees it at its next start",
				"instance", spec.GetInstanceId(), "volume", iv.GetVolumeId(), "err", err.Error())
		}
	}
}

// volumeRefusals are the instances whose volumes cannot be attached: one the section does not list,
// one that failed, or one another running (or paused) instance has when either attachment is
// read-write (a raw volume has one writer and no readers beside it). What a domain that keeps
// running has open counts first, whatever its spec says now (a detach applies at its next start);
// then the first in spec order keeps the volume. Domains being stopped are stopped before anything
// starts (apply).
func volumeRefusals(section *agentv1.InstancesSection, failed map[string]string, domains map[string]runtime.Domain) map[string]string {
	listed := map[string]bool{}
	for _, v := range section.GetVolumes() {
		listed[v.GetVolumeId()] = true
	}
	type user struct {
		id string
		rw bool
	}
	users := map[string][]user{}
	keepsRunning := map[string]bool{}
	for _, spec := range section.GetInstances() {
		switch spec.GetDesiredState() {
		case agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING, agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_PAUSED:
			keepsRunning[spec.GetInstanceId()] = true
		}
	}
	ids := make([]string, 0, len(domains))
	for id := range domains {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		d := domains[id]
		if d.Managed && keepsRunning[id] && (d.State == runtime.StateRunning || d.State == runtime.StatePaused) {
			for _, v := range d.Volumes {
				users[v.ID] = append(users[v.ID], user{id, !v.ReadOnly})
			}
		}
	}
	out := map[string]string{}
	for _, spec := range section.GetInstances() {
		state := spec.GetDesiredState()
		if state == agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_DELETED {
			continue
		}
		active := state == agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING ||
			state == agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_PAUSED
		id := spec.GetInstanceId()
	volumes:
		for _, iv := range spec.GetVolumes() {
			vid := iv.GetVolumeId()
			switch {
			case !listed[vid]:
				out[id] = "volume " + vid + " is not on this host"
			case failed[vid] != "":
				out[id] = "volume " + vid + ": " + failed[vid]
			case active:
				for _, u := range users[vid] {
					if u.id == id {
						continue // itself, already running with it
					}
					if u.rw {
						out[id] = fmt.Sprintf("volume %s is attached read-write to %s", vid, u.id)
						break
					} else if !iv.GetReadOnly() {
						out[id] = fmt.Sprintf("volume %s is attached to %s: a read-write attachment is exclusive", vid, u.id)
						break
					}
				}
			}
			if out[id] != "" {
				break volumes
			}
		}
		if out[id] == "" && active {
			for _, iv := range spec.GetVolumes() {
				users[iv.GetVolumeId()] = append(users[iv.GetVolumeId()], user{id, !iv.GetReadOnly()})
			}
		}
	}
	return out
}

// collectVolumes destroys the stored volumes the section no longer lists that no instance still
// attaches (an instance whose delete failed keeps its volumes).
func (c *instancesConverger) collectVolumes(section *agentv1.InstancesSection, specErrors map[string]string) {
	keep := map[string]bool{}
	for _, v := range section.GetVolumes() {
		keep[v.GetVolumeId()] = true
	}
	for _, spec := range section.GetInstances() {
		deleted := spec.GetDesiredState() == agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_DELETED
		if _, failed := specErrors[spec.GetInstanceId()]; !deleted || failed {
			for _, iv := range spec.GetVolumes() {
				keep[iv.GetVolumeId()] = true
			}
		}
	}
	ids, err := c.volumes.List()
	if err != nil {
		c.a.log.Warn("volumes not listed", "err", err.Error())
		return
	}
	for _, id := range ids {
		if keep[id] {
			continue
		}
		if err := c.volumes.Destroy(id); err != nil {
			c.a.log.Warn("volume not destroyed", "volume", id, "err", err.Error())
			continue
		}
		c.a.log.Info("volume destroyed", "volume", id)
	}
}

// enforceNetworkPolicies loads the instances' firewall (anti-spoofing and network policies) when it
// changed. It returns the instances that must not run: a policy that cannot be expressed, or rules
// that failed to load (fail closed). Egress instances run without the rules, but the metadata
// service stays off; a failed load is retried on the next pass.
func (c *instancesConverger) enforceNetworkPolicies(ctx context.Context, specs []*agentv1.InstanceSpec) map[string]string {
	ruleset, failed, guarded := firewallRuleset(specs, bridgeAddrs(specs))
	if ruleset == c.firewall && !c.stale.Swap(false) {
		return failed
	}
	err := c.a.host.ApplyFirewall(ctx, ruleset)
	// The metadata service and instance tunnels name instances by address: they trust only the
	// addresses these rules bind to their taps, and only while the rules are loaded.
	c.a.mu.Lock()
	if err == nil {
		c.a.guarded = guarded
	} else {
		c.a.guarded = nil
	}
	c.a.mu.Unlock()
	c.a.spoofGuard.Store(err == nil)
	c.a.tableLoaded.Store(err == nil && strings.Contains(ruleset, "chain input"))
	if err == nil {
		c.firewall = ruleset
		c.a.lastFirewall.Store(&ruleset)
		return failed
	}
	c.a.log.Warn("instance firewall not loaded; the metadata service is off until it is", "error", err.Error())
	for _, s := range specs {
		if policyEnforced(s.GetNetworkPolicy()) && s.GetDesiredState() != agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_DELETED {
			if _, already := failed[s.GetInstanceId()]; !already {
				failed[s.GetInstanceId()] = "network policy: " + err.Error()
			}
		}
	}
	return failed
}

func (c *instancesConverger) Section() converge.Section { return converge.SectionInstances }

// currentSpecs are the last pass's instances.
func (c *instancesConverger) currentSpecs() []*agentv1.InstanceSpec {
	c.specsMu.Lock()
	defer c.specsMu.Unlock()
	return c.specs
}

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
	c.specsMu.Lock()
	c.specs = section.GetInstances()
	c.specsMu.Unlock()
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
	// Volumes exist (and have grown) before the instances that attach them are defined.
	failedVolumes, grownVolumes := c.ensureVolumes(section)
	refusedVolumes := volumeRefusals(section, failedVolumes, domains)
	// The rules go in before any domain starts: taps are matched by name, so they apply from the
	// first frame.
	unenforceable := c.enforceNetworkPolicies(ctx, section.GetInstances())
	var waiting []string
	// Host-side admission (admission.go): read once per pass, then charged start by start.
	var hostMem *hostMemory
	exhausted := map[string]string{}
	// Stops and deletes before starts: a volume (or the memory) handed from one instance to another
	// in the same pass is let go before it is taken.
	ordered := make([]*agentv1.InstanceSpec, 0, len(section.GetInstances()))
	for _, active := range []bool{false, true} {
		for _, spec := range section.GetInstances() {
			switch spec.GetDesiredState() {
			case agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING, agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_PAUSED:
				if active {
					ordered = append(ordered, spec)
				}
			default:
				if !active {
					ordered = append(ordered, spec)
				}
			}
		}
	}
	for _, spec := range ordered {
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
		if msg, bad := unenforceable[id]; bad {
			// Never running without its policy: a running domain stops.
			specErrors[id] = msg
			if exists && existing.State != runtime.StateStopped {
				if err := r.SetState(ctx, id, runtime.StateStopped); err != nil {
					specErrors[id] = msg + "; stopping it failed: " + err.Error()
				}
			}
			continue
		}
		if msg, bad := refusedVolumes[id]; bad {
			// A second writer (or a reader beside one) would corrupt the volume: it stops.
			specErrors[id] = msg
			if exists && existing.State != runtime.StateStopped {
				if err := r.SetState(ctx, id, runtime.StateStopped); err != nil {
					specErrors[id] = msg + "; stopping it failed: " + err.Error()
				}
			}
			continue
		}
		restoreFrom := spec.GetRestoreFrom()
		if restoreFrom.GetUrl() == "" {
			restoreFrom = nil
		}
		if restoreFrom != nil && len(restoreFrom.GetSha256()) != 32 {
			specErrors[id] = fmt.Sprintf("snapshot %s has no sha256 to verify", firstNonEmpty(restoreFrom.GetRef(), restoreFrom.GetUrl()))
			continue
		}
		if img := spec.GetImage(); !exists && restoreFrom == nil && (img == nil || !imageFormats[img.GetFormat()] || img.GetUrl() == "" || len(img.GetSha256()) == 0) {
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
		var restore *runtime.Restore
		if restoreFrom != nil && !exists {
			path, pending, err := c.a.restoreFile(restoreFrom.GetUrl(), restoreFrom.GetSha256())
			if pending {
				waiting = append(waiting, id)
				continue
			}
			if err != nil {
				specErrors[id] = "snapshot: " + err.Error()
				continue
			}
			restore = &runtime.Restore{Path: path, Sha256: fmt.Sprintf("%x", restoreFrom.GetSha256()), CPUModel: c.a.cpuModel()}
		}
		if err := r.Ensure(ctx, spec, userData, restore); err != nil {
			specErrors[id] = err.Error()
			continue
		}
		if starts(spec, existing, exists) {
			if self, ok := r.(runtime.SelfAdmitting); !ok || !self.AdmitsItself() {
				if hostMem == nil {
					probed, err := probeHostMemory(domains)
					if err != nil {
						c.a.log.Warn("host memory unreadable; starting without host-side admission", "err", err)
						probed = nil
					} else {
						// What the GPU holds were promised is not the VMs' to take.
						for _, h := range c.a.holdCommitments() {
							probed.reserve(h)
						}
					}
					hostMem = probed
				}
				if hostMem != nil {
					if err := hostMem.admit(spec); err != nil {
						if strings.HasPrefix(err.Error(), ResourcesExhausted) {
							exhausted[id] = err.Error()
						} else {
							specErrors[id] = err.Error()
						}
						continue
					}
				}
			}
		}
		if err := r.SetState(ctx, id, wantedState(spec.GetDesiredState())); err != nil {
			specErrors[id] = err.Error()
			continue
		}
		c.tellGrownVolumes(ctx, r, spec, grownVolumes)
		// A bcx runtime is told its taps' names; one that did not use them would run outside the
		// rules, which match by name: it stops (fail closed).
		if _, plugin := r.(*PluginRuntime); plugin && tapRulesApply(spec) &&
			spec.GetDesiredState() == agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING {
			if missing := c.a.missingTaps(spec); len(missing) > 0 {
				msg := fmt.Sprintf("runtime %s did not create taps %s: its network rules cannot apply", r.Name(), strings.Join(missing, ", "))
				if err := r.SetState(ctx, id, runtime.StateStopped); err != nil {
					msg += "; stopping it failed: " + err.Error()
				}
				specErrors[id] = msg
				continue
			}
		}
		// A memory restore's guest gets its own identity once it runs (rebind.go).
		if spec.GetDesiredState() == agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING {
			c.a.maybeRebind(r, spec)
		}
	}
	c.a.pruneRebinds(section.GetInstances())
	c.collectVolumes(section, specErrors)
	c.specErrors = specErrors
	c.exhausted = exhausted
	keep := map[string]bool{}
	for _, spec := range section.GetInstances() {
		if d := spec.GetRestoreFrom().GetSha256(); len(d) == 32 && spec.GetDesiredState() != agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_DELETED {
			keep[hex.EncodeToString(d)] = true
		}
	}
	c.a.collectSnapshots(keep)
	if len(waiting) > 0 {
		return fmt.Errorf("waiting for the user data or snapshot of %s", strings.Join(waiting, ", "))
	}
	if len(exhausted) > 0 && len(specErrors) == 0 {
		// Not terminal: memory may free up (another instance stops); the next pass tries again.
		ids := make([]string, 0, len(exhausted))
		for id := range exhausted {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		return fmt.Errorf("%s: this host cannot start %s now", ResourcesExhausted, strings.Join(ids, ", "))
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

// starts reports whether applying spec starts a domain that is not running (a resume from paused is
// not a start: its memory is already the host's).
func starts(spec *agentv1.InstanceSpec, existing runtime.Domain, exists bool) bool {
	switch spec.GetDesiredState() {
	case agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING, agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_PAUSED:
	default:
		return false
	}
	return !exists || (existing.State != runtime.StateRunning && existing.State != runtime.StatePaused)
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
			if d.Managed {
				st.IdentityReboundRef = c.a.reboundRef(d.ID)
			}
			if msg, failed := specErrors[d.ID]; failed && d.Managed {
				st.State, st.Message = agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR, msg
			} else if msg, waits := c.exhausted[d.ID]; waits && d.Managed {
				// Not an error: it stays stopped until the host can give it its memory.
				st.Message = msg
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
