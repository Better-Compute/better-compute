package agent

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/converge"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// NodeSpec field numbers, reported as the reason of a SectionUnsupported condition.
var sectionField = map[converge.Section]int{
	converge.SectionHost:      1,
	converge.SectionDevices:   2,
	converge.SectionInstances: 3,
	converge.SectionAccess:    4,
	converge.SectionTelemetry: 5,
	converge.SectionDaemon:    6,
	"site":                    7,
}

// loadSpec restores the last full spec from the journal (enforced while offline).
func (a *Agent) loadSpec() error {
	stored, ok, err := a.j.Spec()
	if err != nil || !ok {
		return err
	}
	body := &agentv1.DesiredStateBody{}
	if err := proto.Unmarshal(stored.Body, body); err != nil {
		return fmt.Errorf("stored spec: %w", err)
	}
	spec := body.GetFull()
	if spec == nil {
		return errors.New("stored spec is not a full spec")
	}
	a.mu.Lock()
	a.spec = spec
	if stored.Generation > a.applied {
		a.applied = stored.Generation
	}
	a.mu.Unlock()
	return nil
}

// onDesired applies a DesiredState: newer generations only, patches only on their base, signatures
// checked when the daemon holds command-signing roots (then every spec must be signed: an unsigned
// spec with a huge generation would otherwise freeze the node's specs). A refused spec is not applied.
func (a *Agent) onDesired(d *agentv1.DesiredState) {
	body := &agentv1.DesiredStateBody{}
	if err := proto.Unmarshal(d.GetBody(), body); err != nil {
		a.log.Warn("undecodable desired state dropped")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if body.GetNodeId() != a.NodeID() {
		a.log.Warn("desired state for another node ignored", "nodeId", body.GetNodeId())
		return
	}
	generation := body.GetGeneration()
	if generation <= a.applied {
		a.log.Debug("stale desired state ignored", "generation", generation, "applied", a.applied)
		return
	}
	var spec *agentv1.NodeSpec
	switch s := body.GetSpec().(type) {
	case *agentv1.DesiredStateBody_Patch:
		if body.GetBaseGeneration() != a.applied || a.spec == nil {
			a.log.Info("patch base mismatch; asking for a full spec", "base", body.GetBaseGeneration(), "applied", a.applied)
			a.sendLocked(&agentv1.AgentFrame{Msg: &agentv1.AgentFrame_SpecRequest{SpecRequest: &agentv1.SpecRequest{
				HaveGeneration: a.applied,
				Reason:         agentv1.SpecRequestReason_SPEC_REQUEST_REASON_PATCH_BASE_MISMATCH,
			}}})
			return
		}
		spec = mergeSpec(a.spec, s.Patch)
	case *agentv1.DesiredStateBody_Full:
		spec = s.Full
	default:
		spec = &agentv1.NodeSpec{}
	}
	if err := validateAccess(spec.GetAccess()); err != nil {
		a.log.Warn("desired state refused", "generation", generation, "reason", err.Error())
		return
	}
	if roots := a.state.TrustRoots; len(roots) > 0 {
		if err := pki.VerifyIntent(pki.PurposeDesiredState, d.GetBody(), d.GetSignature(), roots, a.serverNowLocked()); err != nil {
			a.log.Warn("desired state refused", "generation", generation, "reason", err.Error())
			return
		}
		// bcd helper applies host units only with the signed body that set them.
		a.hostcfg.noteSignedSpec(d, body)
	}
	full, err := marshal(&agentv1.DesiredStateBody{
		NodeId:      body.GetNodeId(),
		Generation:  generation,
		SpecHash:    body.GetSpecHash(),
		Spec:        &agentv1.DesiredStateBody_Full{Full: spec},
		Traceparent: body.GetTraceparent(),
	})
	if err != nil {
		a.log.Error("encode the spec", "error", err.Error())
		return
	}
	var sig []byte
	if d.GetSignature() != nil {
		sig, _ = marshal(d.GetSignature())
	}
	if err := a.j.SaveSpec(journal.Spec{Generation: generation, Hash: body.GetSpecHash(), Body: full, Signature: sig}); err != nil {
		a.log.Error("journal: save spec", "error", err.Error())
		return
	}
	meta, err := a.j.Meta()
	if err == nil {
		meta.AppliedGeneration = generation
		err = a.j.SaveMeta(meta)
	}
	if err != nil {
		a.log.Error("journal: applied generation", "error", err.Error())
		return
	}
	_, patch := body.GetSpec().(*agentv1.DesiredStateBody_Patch)
	a.log.Info("spec applied", "generation", generation, "patch", patch)
	a.spec = spec
	a.applied = generation
	a.triggerConverge()
	for _, w := range a.deferred {
		a.admitLocked(w.cmd, true, w.intent, w.command, w.body)
	}
}

// mergeSpec applies a section-level patch: every section set in the patch replaces that section
// wholesale (an empty message clears it); unset sections keep their value.
func mergeSpec(current, patch *agentv1.NodeSpec) *agentv1.NodeSpec {
	out := proto.Clone(current).(*agentv1.NodeSpec)
	dst := out.ProtoReflect()
	patch.ProtoReflect().Range(func(fd protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		dst.Set(fd, v)
		return true
	})
	if unknown := patch.ProtoReflect().GetUnknown(); len(unknown) > 0 {
		dst.SetUnknown(unknown)
	}
	return out
}

func (a *Agent) triggerConverge() {
	select {
	case a.convergeCh <- struct{}{}:
	default:
	}
}

// driftInterval is how often a converged spec is converged again anyway (P2, level-triggered): what
// changed on the host behind bcd's back (a sysctl, a kernel module, a service, a CDI spec, a mount
// lost at a reboot) is repaired within it, even when no new spec arrives.
var driftInterval = 10 * time.Minute

func (a *Agent) convergeLoop(ctx context.Context) {
	var retry <-chan struct{}
	drift := time.NewTicker(driftInterval)
	defer drift.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-a.convergeCh:
		case <-retry:
		case <-drift.C:
		}
		progressing := a.convergeOnce(ctx)
		retry = nil
		if progressing {
			ch := make(chan struct{})
			retry = ch
			go func() {
				if sleepCtx(ctx, a.o.ConvergeRetry) == nil {
					close(ch)
				}
			}()
		}
	}
}

// convergeOnce runs every section once over the enforced spec and reports the result. It returns
// true while a section is still progressing (retried later).
func (a *Agent) convergeOnce(ctx context.Context) bool {
	a.mu.Lock()
	spec := a.spec
	generation := a.applied
	a.mu.Unlock()
	if spec == nil {
		return false
	}
	sections := map[converge.Section][]byte{}
	put := func(name converge.Section, m proto.Message, set bool) {
		if !set {
			return
		}
		b, err := marshal(m)
		if err == nil {
			sections[name] = b
		}
	}
	put(converge.SectionHost, spec.GetHost(), spec.Host != nil)
	put(converge.SectionDevices, spec.GetDevices(), spec.Devices != nil)
	put(converge.SectionInstances, spec.GetInstances(), spec.Instances != nil)
	put(converge.SectionAccess, spec.GetAccess(), spec.Access != nil)
	put(converge.SectionTelemetry, spec.GetTelemetry(), spec.Telemetry != nil)
	put(converge.SectionDaemon, spec.GetDaemon(), spec.Daemon != nil)
	// The site section is reported only when the spec sets it.
	if spec.Site != nil {
		put("site", spec.GetSite(), true)
		if _, ok := sections["site"]; ok && len(sections["site"]) == 0 {
			sections["site"] = nil
		}
	}
	unknown := unknownFields(spec.ProtoReflect().GetUnknown())
	for _, no := range unknown {
		sections[converge.Section(strconv.Itoa(no))] = []byte{0}
	}
	a.devices.generation = generation
	a.access.generation = generation
	convergers := []converge.Converger{a.devices, a.access, a.instances, a.telemetry, siteConverger{a}}
	if !a.o.ExternalHost {
		convergers = append(convergers, a.hostcfg)
	}
	if a.o.Update != nil {
		convergers = append(convergers, daemonConverger{a})
	}
	report, err := converge.Run(ctx, converge.Spec{Generation: generation, Sections: sections}, convergers)
	if err != nil {
		return false
	}
	status := &agentv1.StatusReport{AppliedGeneration: generation}
	if len(a.o.Runtimes) > 0 {
		// Everything the runtimes hold, managed or not: the control plane finds leaks by it.
		status.Instances = a.instances.report(ctx, a.instances.specErrors, a.instances.currentSpecs())
		status.InstancesComplete = true
	}
	for _, r := range report.Sections {
		if r.Section == "site" && spec.Site == nil {
			continue
		}
		st := &agentv1.SectionStatus{Section: string(r.Section), Generation: generation}
		switch r.Status {
		case converge.StatusConverged:
			st.State = agentv1.SectionState_SECTION_STATE_CONVERGED
		case converge.StatusProgressing:
			st.State = agentv1.SectionState_SECTION_STATE_PROGRESSING
			st.Reason = "Retrying"
			st.Message = errText(r.Err)
		case converge.StatusFailed:
			st.State = agentv1.SectionState_SECTION_STATE_FAILED
			st.Reason = failedReason(r.Section)
			st.Message = errText(r.Err)
		case converge.StatusUnsupported:
			st.State = agentv1.SectionState_SECTION_STATE_UNSUPPORTED
			if r.Section == converge.SectionHost && a.o.ExternalHost {
				// Observed only: whatever the units ask, the host is what its inventory reports.
				st.Reason = "HostManagedExternally"
				st.Message = "the host's configuration is managed outside bcd ([host] units = false); no unit is applied"
				break
			}
			st.Reason = "SectionUnsupported"
			no, known := sectionField[r.Section]
			if !known {
				no, _ = strconv.Atoi(string(r.Section))
			}
			status.Conditions = append(status.Conditions, &agentv1.Condition{
				Type:    "SectionUnsupported",
				Status:  agentv1.ConditionStatus_CONDITION_STATUS_TRUE,
				Reason:  strconv.Itoa(no),
				Message: fmt.Sprintf("section %s is not supported by bcd %s", r.Section, a.o.Version),
			})
		}
		status.Sections = append(status.Sections, st)
	}
	a.mu.Lock()
	if report.Observed && generation > a.observed {
		a.observed = generation
	}
	status.ObservedGeneration = a.observed
	status.Pressure = a.pressure
	status.Conditions = append(status.Conditions, cloneConditions(a.faults)...)
	status.Conditions = append(status.Conditions, a.hostcfg.currentConditions()...)
	status.Conditions = append(status.Conditions, a.kubeConditions()...)
	status.Conditions = append(status.Conditions, a.devices.currentConditions()...)
	if a.o.State.Role == "site" {
		// The unknown machines that PXE-booted (discovery.go).
		status.Discovered = a.discovery.list(a.serverNowLocked())
	}
	if stored, ok, err := a.j.Spec(); err == nil && ok {
		status.AppliedSpecHash = stored.Hash
	}
	a.lastStatus = status
	a.sendStatusLocked()
	a.mu.Unlock()
	a.log.Info("converged", "generation", generation, "observed", status.ObservedGeneration, "progressing", !report.Observed)
	return !report.Observed
}

func failedReason(s converge.Section) string {
	switch s {
	case converge.SectionDevices:
		return "AllocationFailed"
	case converge.SectionInstances:
		return "InstanceFailed"
	case converge.SectionDaemon:
		return "UpdateFailed"
	}
	return "ConvergeFailed"
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// sendStatusLocked sends the last status. trust_version rides only the first status sent after a
// newer trust bundle was applied (0 means unchanged; Hello carries it at session start).
func (a *Agent) sendStatusLocked() {
	if a.lastStatus == nil {
		return
	}
	status := a.lastStatus
	if a.trustPending {
		status = proto.Clone(a.lastStatus).(*agentv1.StatusReport)
		status.TrustVersion = a.state.TrustVersion
		status.ApproverSetEpoch, status.ApproverSetSha256 = a.heldApproverSetLocked()
	}
	if a.sendLocked(&agentv1.AgentFrame{Msg: &agentv1.AgentFrame_Status{Status: status}}) {
		a.trustPending = false
	}
}

// unknownFields lists the field numbers in raw unknown bytes (sections this daemon does not know).
func unknownFields(raw []byte) []int {
	seen := map[int]bool{}
	for len(raw) > 0 {
		num, typ, n := protowire.ConsumeTag(raw)
		if n < 0 {
			break
		}
		raw = raw[n:]
		m := protowire.ConsumeFieldValue(num, typ, raw)
		if m < 0 {
			break
		}
		raw = raw[m:]
		seen[int(num)] = true
	}
	out := make([]int, 0, len(seen))
	for no := range seen {
		out = append(out, no)
	}
	sort.Ints(out)
	return out
}
