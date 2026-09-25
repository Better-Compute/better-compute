// Package converge applies NodeSpec desired state (PLAN.md §6 "Internals", §7.3).
//
// Desired state holds standing facts and commands are one-shot: if losing something leaves the
// wrong steady state, it is desired state. A spec is split into sections, converged in this order:
//
//	host       host configuration: sysctls, kernel modules, files, units
//	devices    device assignments: CDI specs /etc/cdi/bcd-<alloc>.json, env files, ownership;
//	           the MIG layout from v0.5
//	instances  VPS instances (v0.3)
//	access     SSH CA principals and the exec-ticket JWKS; empty in v0.1, filled from v0.3
//	telemetry  OTLP / remote-write targets (telemetry never rides the Session, P8)
//	daemon     the daemon version for self-update (v0.4)
//
// Each section is an idempotent plan(desired, observed) + apply, run level-triggered (P2):
// observedGeneration advances to a spec's generation only when every section has converged or
// failed terminally, and a retryable failure is retried on the next pass. A section the daemon has
// no converger for is reported SectionUnsupported (§7.6) and counts as terminal; so is the site
// section of NodeSpec until site agents arrive in v0.2. Status mirrors agent/v1 SectionState.
//
// The convergers themselves (devices, access, telemetry) live in internal/agent, which also applies
// patches against base_generation and hands Run each section's encoding.
package converge

import (
	"context"
	"errors"
	"fmt"
	"sort"
)

// Section names a NodeSpec section.
type Section string

// NodeSpec sections.
const (
	SectionHost      Section = "host"
	SectionDevices   Section = "devices"
	SectionInstances Section = "instances"
	SectionAccess    Section = "access"
	SectionTelemetry Section = "telemetry"
	SectionDaemon    Section = "daemon"
)

// Order returns the sections in the order they converge.
func Order() []Section {
	return []Section{SectionHost, SectionDevices, SectionInstances, SectionAccess, SectionTelemetry, SectionDaemon}
}

// Action is one idempotent step toward a section's desired state.
type Action struct {
	Description string
	Apply       func(ctx context.Context) error
}

// Converger owns one section.
type Converger interface {
	// Section returns the section this converger owns.
	Section() Section
	// Plan compares the section's desired state (its encoded body in the spec, nil when absent)
	// with what the node observes now, and returns the actions that close the gap. No actions
	// means converged. Plan must not change the node.
	Plan(ctx context.Context, desired []byte) ([]Action, error)
}

// ErrTerminal marks a failure that retrying cannot fix, such as invalid desired state or missing
// hardware.
var ErrTerminal = errors.New("converge: terminal failure")

// Terminal wraps err so that Run treats it as terminal.
func Terminal(err error) error {
	return fmt.Errorf("%w: %w", ErrTerminal, err)
}

// Status is a section's outcome in one pass.
type Status string

// Section outcomes.
const (
	StatusConverged   Status = "converged"
	StatusProgressing Status = "progressing"
	StatusFailed      Status = "failed"
	StatusUnsupported Status = "unsupported"
)

// SectionReport is one section's outcome.
type SectionReport struct {
	Section Section
	Status  Status
	// Applied counts the actions applied in this pass.
	Applied int
	// Err is set for StatusProgressing and StatusFailed.
	Err error
}

// Report is the outcome of one pass over a spec.
type Report struct {
	Generation uint64
	Sections   []SectionReport
	// Observed reports that every section converged or failed terminally, so observedGeneration
	// may advance to Generation.
	Observed bool
}

// Spec is the part of a NodeSpec the converger needs.
type Spec struct {
	Generation uint64
	Sections   map[Section][]byte
}

// Run converges spec once. Known sections run in Order, then sections this daemon does not know,
// by name. A known section without a converger converges trivially when its desired state is
// empty and is unsupported otherwise.
func Run(ctx context.Context, spec Spec, convergers []Converger) (Report, error) {
	owners := make(map[Section]Converger, len(convergers))
	for _, c := range convergers {
		s := c.Section()
		if _, dup := owners[s]; dup {
			return Report{}, fmt.Errorf("converge: two convergers for section %s", s)
		}
		owners[s] = c
	}
	report := Report{Generation: spec.Generation, Observed: true}
	for _, s := range sectionsOf(spec) {
		if err := ctx.Err(); err != nil {
			return Report{}, err
		}
		r := runSection(ctx, s, owners[s], spec.Sections[s])
		if r.Status == StatusProgressing {
			report.Observed = false
		}
		report.Sections = append(report.Sections, r)
	}
	return report, nil
}

func sectionsOf(spec Spec) []Section {
	sections := Order()
	known := make(map[Section]bool, len(sections))
	for _, s := range sections {
		known[s] = true
	}
	var unknown []Section
	for s := range spec.Sections {
		if !known[s] {
			unknown = append(unknown, s)
		}
	}
	sort.Slice(unknown, func(i, j int) bool { return unknown[i] < unknown[j] })
	return append(sections, unknown...)
}

func runSection(ctx context.Context, s Section, c Converger, desired []byte) SectionReport {
	r := SectionReport{Section: s}
	if c == nil {
		if len(desired) == 0 {
			r.Status = StatusConverged
		} else {
			r.Status = StatusUnsupported
		}
		return r
	}
	actions, err := c.Plan(ctx, desired)
	if err != nil {
		return failed(r, fmt.Errorf("plan: %w", err))
	}
	for _, a := range actions {
		if err := a.Apply(ctx); err != nil {
			return failed(r, fmt.Errorf("%s: %w", a.Description, err))
		}
		r.Applied++
	}
	r.Status = StatusConverged
	return r
}

func failed(r SectionReport, err error) SectionReport {
	r.Err = err
	if errors.Is(err, ErrTerminal) {
		r.Status = StatusFailed
	} else {
		r.Status = StatusProgressing
	}
	return r
}
