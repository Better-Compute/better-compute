// Package dispatch admits and runs commands (PLAN.md §6 "Command semantics" and "Internals",
// §7.4, §7.5). A CommandBody the session delivers goes through, in order:
//
//  1. journal.Resolve: a duplicate resends its result, re-attaches, re-executes or reports without
//     running again;
//  2. Precheck: UNSUPPORTED for another node's commands and unknown or role-disallowed kinds,
//     EXPIRED past not_after, deferral on min_generation and then STALE_GENERATION (BAD_SIGNATURE
//     for unsigned destructive kinds arrives in v0.2);
//  3. Lanes.Admit: a credit on the command's lane, or BUSY, which the server re-queues with backoff;
//  4. journal.Accept (durable), then one of the lane's workers (Lanes.Work) runs the kind's Handler
//     under the KeyedMutex of the resource it touches, then journal.Complete and a CommandUpdate.
//
// The server grants per-lane credits (control 8, provision 4, bulk 2) and refreshes them with
// heartbeats; the daemon runs a fixed worker pool per lane (control 4, provision 2, bulk 1), never a
// goroutine per command. Handlers for the v0.1 kinds (inventory.refresh, diag.nvml, the
// self-terminating node.reboot) arrive in v0.1. Until then the registry is empty and every kind is
// UNSUPPORTED, which fails closed (P11).
package dispatch

import (
	"context"
	"fmt"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"google.golang.org/protobuf/proto"
)

// Role is an agent role, carried in the node certificate (PLAN.md §6 mode table).
type Role string

// Agent roles.
const (
	RoleNode    Role = "node"
	RoleSite    Role = "site"
	RoleRamdisk Role = "ramdisk"
)

// Command is what the dispatcher needs from a delivered agent/v1 Command: the CommandBody fields,
// Command.attempt, and the decoded Body itself for handlers (FromBody builds it). Payload is the
// encoded google.protobuf.Any.
type Command struct {
	ID              string
	NodeID          string
	Seq             uint64
	Kind            string
	Payload         []byte
	Lane            Lane
	NotAfter        time.Time
	MinGeneration   uint64
	RetrySafe       bool
	IdempotencyKey  string
	Traceparent     string
	SelfTerminating bool
	Attested        bool
	WorkflowID      string
	StepID          string
	Attempt         uint32
	// Body is the decoded CommandBody (handlers unpack Body.Payload); nil in tests that do not need it.
	Body *agentv1.CommandBody
}

// FromBody builds the dispatcher's view of a decoded CommandBody.
func FromBody(body *agentv1.CommandBody, attempt uint32) Command {
	var payload []byte
	if body.GetPayload() != nil {
		payload, _ = proto.Marshal(body.GetPayload())
	}
	c := Command{
		ID:              body.GetId(),
		NodeID:          body.GetNodeId(),
		Seq:             body.GetSeq(),
		Kind:            body.GetKind(),
		Payload:         payload,
		Lane:            Lane(body.GetLane()),
		MinGeneration:   body.GetMinGeneration(),
		RetrySafe:       body.GetRetrySafe(),
		IdempotencyKey:  body.GetIdempotencyKey(),
		Traceparent:     body.GetTraceparent(),
		SelfTerminating: body.GetSelfTerminating(),
		Attested:        body.GetAttested(),
		WorkflowID:      body.GetWorkflowId(),
		StepID:          body.GetStepId(),
		Attempt:         attempt,
		Body:            body,
	}
	if body.GetNotAfter() != nil {
		c.NotAfter = body.GetNotAfter().AsTime()
	}
	return c
}

// Delivery returns what the journal rules need from c.
func (c Command) Delivery() journal.Delivery {
	return journal.Delivery{ID: c.ID, Kind: c.Kind, RetrySafe: c.RetrySafe, SelfTerminating: c.SelfTerminating}
}

// Handler executes one command kind.
type Handler interface {
	// Run performs the command's side effect and returns its result. An error is reported as a
	// failed result; Run must stop between actions when ctx is cancelled (Cancel{id}) and must never
	// hide a completed side effect.
	Run(ctx context.Context, cmd Command) (journal.Result, error)
}

// Kind is the daemon's view of one command kind. The server's kind registry is the source of
// truth for retry_safe, self_terminating and attested, which arrive on every CommandBody (§7.4).
type Kind struct {
	Name string
	// Lane is the lane the kind's commands run on.
	Lane Lane
	// Roles lists the agent roles allowed to run the kind (per-role allowlists, PLAN.md §6).
	Roles []Role
	// Destructive kinds must be signed from v0.2 (wipe, deploy.*, firmware.*, gpu.reset).
	Destructive bool
	Handler     Handler
}

// Registry holds the kinds this daemon supports.
type Registry struct {
	kinds map[string]Kind
}

// NewRegistry validates and registers kinds.
func NewRegistry(kinds ...Kind) (*Registry, error) {
	r := &Registry{kinds: make(map[string]Kind, len(kinds))}
	for _, k := range kinds {
		if k.Name == "" || k.Handler == nil || len(k.Roles) == 0 {
			return nil, fmt.Errorf("dispatch: kind %q needs a name, roles and a handler", k.Name)
		}
		if !k.Lane.valid() {
			return nil, fmt.Errorf("dispatch: kind %s: %w %s", k.Name, ErrUnknownLane, k.Lane)
		}
		if _, dup := r.kinds[k.Name]; dup {
			return nil, fmt.Errorf("dispatch: kind %s is registered twice", k.Name)
		}
		r.kinds[k.Name] = k
	}
	return r, nil
}

// Lookup returns the kind called name if role may run it.
func (r *Registry) Lookup(name string, role Role) (Kind, bool) {
	if r == nil {
		return Kind{}, false
	}
	k, ok := r.kinds[name]
	if !ok {
		return Kind{}, false
	}
	for _, allowed := range k.Roles {
		if allowed == role {
			return k, true
		}
	}
	return Kind{}, false
}

// Rejection is a CommandUpdate rejection code. All but RejectBusy are terminal (`rejected`); BUSY
// sends the command back to pending on the server.
type Rejection string

// Rejection codes (PLAN.md §6 "Checks before accepting", §7.4).
const (
	RejectUnsupported     Rejection = "UNSUPPORTED"
	RejectExpired         Rejection = "EXPIRED"
	RejectStaleGeneration Rejection = "STALE_GENERATION"
	RejectBadSignature    Rejection = "BAD_SIGNATURE"
	RejectBusy            Rejection = "BUSY"
)

// Env is what Precheck needs to know about the daemon.
type Env struct {
	// Now is server time: the local clock plus the offset measured from Welcome.server_time.
	Now time.Time
	// NodeID is this node's id; a command addressed to another node is UNSUPPORTED.
	NodeID string
	// Role is this agent's role.
	Role Role
	// AppliedGeneration is the spec generation the daemon has applied.
	AppliedGeneration uint64
	// Deferred is set when re-checking a command that already waited for min_generation.
	Deferred bool
	// UpgradeRequired restricts the session to daemon.upgrade (Welcome.upgrade_required, v0.4).
	UpgradeRequired bool
	// BadSignature is the signed-intent verdict on this delivery: a signature that did not verify, or
	// none where the daemon's kind table requires one.
	BadSignature bool
}

// Verdict is Precheck's answer: accept, reject with a code, or defer until a newer spec arrives
// (the caller sends SpecRequest and re-checks on the next spec or at not_after).
type Verdict struct {
	Reject Rejection
	Defer  bool
}

// Accepted reports whether the command may proceed to admission.
func (v Verdict) Accepted() bool { return v.Reject == "" && !v.Defer }

// Precheck applies the checks before accepting a new or re-executed command, in this order: node
// and kind (UNSUPPORTED), min_generation (defer, then STALE_GENERATION), not_after (EXPIRED), then
// the signature (BAD_SIGNATURE). A command first seen past not_after is EXPIRED; one that waited for
// min_generation until not_after is STALE_GENERATION. Credits (BUSY) are checked by Lanes.Admit.
func Precheck(cmd Command, reg *Registry, env Env) Verdict {
	if cmd.NodeID != env.NodeID {
		return Verdict{Reject: RejectUnsupported}
	}
	if env.UpgradeRequired && cmd.Kind != "daemon.upgrade" {
		return Verdict{Reject: RejectUnsupported}
	}
	if _, ok := reg.Lookup(cmd.Kind, env.Role); !ok {
		return Verdict{Reject: RejectUnsupported}
	}
	pastDeadline := !env.Now.Before(cmd.NotAfter)
	if cmd.MinGeneration > env.AppliedGeneration {
		if !pastDeadline {
			return Verdict{Defer: true}
		}
		if env.Deferred {
			return Verdict{Reject: RejectStaleGeneration}
		}
	}
	if pastDeadline {
		return Verdict{Reject: RejectExpired}
	}
	if env.BadSignature {
		return Verdict{Reject: RejectBadSignature}
	}
	return Verdict{}
}

// Dispatcher receives the commands the session delivers. TODO(v0.1): the implementation wires
// journal.Resolve, Precheck, Lanes, KeyedMutex and the Registry as the package comment describes.
type Dispatcher interface {
	// Deliver admits cmd, or answers it from the journal, and returns once it is accepted,
	// rejected, deferred or reported; execution continues on a lane worker.
	Deliver(ctx context.Context, cmd Command) error
	// Cancel stops a command between actions.
	Cancel(id string)
}
