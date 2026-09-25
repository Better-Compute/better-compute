package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/proto"
)

// Kind is one command kind this daemon runs: the dispatch view (lane, roles, destructive) plus its
// implementation.
type Kind struct {
	Name  string
	Lane  dispatch.Lane
	Roles []dispatch.Role
	// Destructive kinds need a valid worker signature once the daemon holds command-signing roots.
	Destructive bool
	// SelfTerminating kinds call Agent.markRunning themselves, immediately before their side effect.
	SelfTerminating bool
	// Exec performs the command. A *KindError fails it with that code; any other error fails it
	// "internal".
	Exec func(ctx context.Context, cmd dispatch.Command) (journal.Result, error)
}

// Run implements dispatch.Handler.
func (k *Kind) Run(ctx context.Context, cmd dispatch.Command) (journal.Result, error) {
	return k.Exec(ctx, cmd)
}

// KindError is a command failure with a stable code (CommandError.code).
type KindError struct {
	Code    string
	Message string
}

func (e *KindError) Error() string { return e.Code + ": " + e.Message }

func invalidPayload(err error) error {
	return &KindError{Code: "invalid-payload", Message: err.Error()}
}

type phase uint8

const (
	phaseQueued phase = iota + 1
	phaseRunning
	phaseDone
)

// exec is an accepted command in this process.
type exec struct {
	cmd     dispatch.Command
	kind    *Kind
	phase   phase
	release func()
	// cancel aborts the wait for a worker (Cancel before the side effect started).
	cancel context.CancelFunc
	ctx    context.Context
}

// deferred is a command waiting for its min_generation.
type deferred struct {
	cmd    dispatch.Command
	badSig bool
	timer  *time.Timer
}

func (a *Agent) onCommand(c *agentv1.Command) {
	body := &agentv1.CommandBody{}
	if err := proto.Unmarshal(c.GetBody(), body); err != nil || body.GetId() == "" {
		a.log.Warn("undecodable command dropped")
		return
	}
	badSig := a.badSignature(c, body)
	cmd := dispatch.FromBody(body, c.GetAttempt())
	a.mu.Lock()
	defer a.mu.Unlock()
	d, err := journal.Resolve(a.j, cmd.Delivery(), a.runtime())
	if err != nil {
		a.log.Error("journal: resolve", "id", cmd.ID, "error", err.Error())
		return
	}
	a.log.Info("command", "id", cmd.ID, "kind", cmd.Kind, "attempt", cmd.Attempt, "action", d.Action.String())
	switch d.Action {
	case journal.ActionResend, journal.ActionReport:
		a.sendLocked(updateFrame(a.updateOf(cmd.ID, *d.Result)))
	case journal.ActionReattach:
	case journal.ActionExecute, journal.ActionReexecute:
		a.admitLocked(cmd, false, badSig)
	}
}

// badSignature is the signed-intent verdict (PLAN.md §6, §13): with command-signing roots, a
// signature that is present is always checked, and the daemon's own kind table (never the body)
// decides whether one is required. Without roots (v0.1) nothing is enforced.
func (a *Agent) badSignature(c *agentv1.Command, body *agentv1.CommandBody) bool {
	a.mu.Lock()
	roots := a.state.TrustRoots
	now := a.serverNowLocked()
	a.mu.Unlock()
	if len(roots) == 0 {
		return false
	}
	required := false
	if k := a.kinds[body.GetKind()]; k != nil {
		required = k.Destructive
	}
	if c.GetSignature() == nil && !required {
		return false
	}
	if err := pki.VerifyIntent(pki.PurposeCommand, c.GetBody(), c.GetSignature(), roots, now); err != nil {
		a.log.Warn("command signature rejected", "id", body.GetId(), "kind", body.GetKind(), "reason", err.Error())
		return true
	}
	return false
}

// admitLocked runs the acceptance checks (dispatch.Precheck order), then a lane credit (BUSY), then
// makes `accepted` durable and hands the command to a lane worker. recheck is set when a deferred
// command is checked again (a new spec arrived, or its not_after passed).
func (a *Agent) admitLocked(cmd dispatch.Command, recheck bool, badSig bool) {
	known := a.deferred[cmd.ID]
	if known != nil && !recheck {
		return // a duplicate of a command already waiting for its spec
	}
	verdict := dispatch.Precheck(cmd, a.reg, dispatch.Env{
		Now:               a.serverNowLocked(),
		NodeID:            a.NodeID(),
		Role:              a.role(),
		AppliedGeneration: a.applied,
		Deferred:          recheck,
		UpgradeRequired:   a.upgradeNeeded,
		BadSignature:      badSig,
	})
	if verdict.Defer {
		if known != nil {
			return
		}
		wait := cmd.NotAfter.Sub(a.serverNowLocked())
		d := &deferred{cmd: cmd, badSig: badSig}
		d.timer = time.AfterFunc(max(wait, 0), func() {
			a.mu.Lock()
			defer a.mu.Unlock()
			if a.deferred[cmd.ID] == d {
				a.admitLocked(cmd, true, badSig)
			}
		})
		a.deferred[cmd.ID] = d
		a.log.Info("command deferred", "id", cmd.ID, "minGeneration", cmd.MinGeneration, "applied", a.applied)
		a.sendLocked(&agentv1.AgentFrame{Msg: &agentv1.AgentFrame_SpecRequest{SpecRequest: &agentv1.SpecRequest{
			HaveGeneration: a.applied,
			Reason:         agentv1.SpecRequestReason_SPEC_REQUEST_REASON_MIN_GENERATION,
		}}})
		return
	}
	if known != nil {
		known.timer.Stop()
		delete(a.deferred, cmd.ID)
	}
	if verdict.Reject != "" {
		r, err := journal.RecordRejection(a.j, cmd.Delivery(), string(verdict.Reject), a.runtime())
		if err != nil {
			a.log.Error("journal: record rejection", "id", cmd.ID, "error", err.Error())
			return
		}
		a.log.Info("command rejected", "id", cmd.ID, "reason", string(verdict.Reject))
		a.sendLocked(updateFrame(a.updateOf(cmd.ID, r)))
		return
	}
	kind := a.kinds[cmd.Kind]
	release, ok, err := a.lanes.Admit(kind.Lane)
	if err != nil {
		a.log.Error("lanes", "error", err.Error())
		return
	}
	if !ok || len(a.overflow) > 0 {
		if ok {
			release()
		}
		a.log.Info("command busy", "id", cmd.ID, "lane", kind.Lane.String(), "journalFull", len(a.overflow) > 0)
		a.sendLocked(updateFrame(&agentv1.CommandUpdate{
			CommandId:    cmd.ID,
			State:        commonv1.CommandState_COMMAND_STATE_REJECTED,
			RejectReason: commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BUSY,
			BootId:       a.bootID,
		}))
		return
	}
	if err := journal.Accept(a.j, cmd.Delivery(), a.runtime()); err != nil {
		release()
		a.log.Error("journal: accept", "id", cmd.ID, "error", err.Error())
		return
	}
	ctx, cancel := context.WithCancel(a.ctx)
	x := &exec{cmd: cmd, kind: kind, phase: phaseQueued, release: release, cancel: cancel, ctx: ctx}
	a.execs[cmd.ID] = x
	a.log.Info("command accepted", "id", cmd.ID, "kind", cmd.Kind, "lane", kind.Lane.String())
	a.sendLocked(updateFrame(&agentv1.CommandUpdate{
		CommandId: cmd.ID, State: commonv1.CommandState_COMMAND_STATE_ACKED, BootId: a.bootID,
	}))
	go a.execute(x)
}

// execute waits for a lane worker, then runs the kind and records its result.
func (a *Agent) execute(x *exec) {
	workerDone, err := a.lanes.Work(x.ctx, x.kind.Lane)
	if err != nil {
		return // cancelled while queued: onCancel completed it
	}
	defer workerDone()
	a.mu.Lock()
	if x.phase != phaseQueued {
		a.mu.Unlock()
		return
	}
	x.phase = phaseRunning
	a.mu.Unlock()
	if !x.kind.SelfTerminating {
		if err := a.markRunning(x.cmd.ID); err != nil {
			a.finish(x, journal.Result{}, err)
			return
		}
	}
	// Once the side effect started, Cancel no longer stops it: its real outcome is reported.
	r, err := x.kind.Run(a.ctx, x.cmd)
	if err != nil && a.ctx.Err() != nil {
		// The process is stopping (or rebooting): record nothing. The journal's running entry is
		// completed by the next start (SUCCEEDED{rebooted}, FAILED{interrupted} or a re-execution).
		a.mu.Lock()
		delete(a.execs, x.cmd.ID)
		x.release()
		a.mu.Unlock()
		return
	}
	a.finish(x, r, err)
}

// markRunning journals running{boot_id} and reports RUNNING. Self-terminating kinds call it
// immediately before their side effect.
func (a *Agent) markRunning(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := journal.MarkRunning(a.j, id, a.runtime()); err != nil {
		return err
	}
	a.sendLocked(updateFrame(&agentv1.CommandUpdate{
		CommandId: id, State: commonv1.CommandState_COMMAND_STATE_RUNNING, BootId: a.bootID,
	}))
	return nil
}

func (a *Agent) finish(x *exec, r journal.Result, err error) {
	if err != nil {
		var ke *KindError
		if errors.As(err, &ke) {
			r = journal.Result{Outcome: journal.OutcomeFailed, Reason: ke.Code, Message: ke.Message}
		} else {
			r = journal.Result{Outcome: journal.OutcomeFailed, Reason: "internal", Message: err.Error()}
		}
	}
	if r.Outcome == "" {
		r.Outcome = journal.OutcomeSucceeded
	}
	r.BootID = a.bootID
	r.Attested = x.cmd.Attested
	a.mu.Lock()
	defer a.mu.Unlock()
	x.phase = phaseDone
	delete(a.execs, x.cmd.ID)
	x.release()
	x.cancel()
	if err := journal.Complete(a.j, x.cmd.ID, r, time.Now()); err != nil {
		a.log.Error("journal: complete", "id", x.cmd.ID, "error", err.Error())
		return
	}
	a.log.Info("command done", "id", x.cmd.ID, "kind", x.cmd.Kind, "outcome", string(r.Outcome), "reason", r.Reason)
	a.sendLocked(updateFrame(a.updateOf(x.cmd.ID, r)))
}

// onCancel stops a command between actions: one still queued or deferred ends CANCELLED; one whose
// side effect started reports its real outcome (never hidden).
func (a *Agent) onCancel(c *agentv1.Cancel) {
	id := c.GetCommandId()
	reason := c.GetReason()
	if reason == "" {
		reason = "cancelled"
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	cancelled := journal.Result{Outcome: journal.OutcomeCancelled, Reason: reason, BootID: a.bootID}
	if x := a.execs[id]; x != nil {
		if x.phase != phaseQueued {
			a.log.Info("cancel too late; the side effect started", "id", id)
			return
		}
		x.phase = phaseDone
		x.cancel()
		x.release()
		delete(a.execs, id)
		if err := journal.Complete(a.j, id, cancelled, time.Now()); err != nil {
			a.log.Error("journal: complete", "id", id, "error", err.Error())
			return
		}
		a.log.Info("command cancelled", "id", id)
		a.sendLocked(updateFrame(a.updateOf(id, cancelled)))
		return
	}
	if d := a.deferred[id]; d != nil {
		d.timer.Stop()
		delete(a.deferred, id)
		del := d.cmd.Delivery()
		r := cancelled
		if err := a.j.PutCommand(journal.Command{
			ID: del.ID, Kind: del.Kind, RetrySafe: del.RetrySafe, SelfTerminating: del.SelfTerminating,
			State: journal.StateDone, Incarnation: a.incarnation, Result: &r, UpdatedAt: time.Now(),
		}); err != nil {
			a.log.Error("journal: cancel a deferred command", "id", id, "error", err.Error())
			return
		}
		a.log.Info("deferred command cancelled", "id", id)
		a.sendLocked(updateFrame(a.updateOf(id, cancelled)))
		return
	}
	a.log.Debug("cancel for an unknown command", "id", id)
}

var outcomeState = map[journal.Outcome]commonv1.CommandState{
	journal.OutcomeSucceeded: commonv1.CommandState_COMMAND_STATE_SUCCEEDED,
	journal.OutcomeFailed:    commonv1.CommandState_COMMAND_STATE_FAILED,
	journal.OutcomeRejected:  commonv1.CommandState_COMMAND_STATE_REJECTED,
	journal.OutcomeCancelled: commonv1.CommandState_COMMAND_STATE_CANCELLED,
}

var rejectReason = map[string]commonv1.CommandRejectReason{
	string(dispatch.RejectUnsupported):     commonv1.CommandRejectReason_COMMAND_REJECT_REASON_UNSUPPORTED,
	string(dispatch.RejectBadSignature):    commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BAD_SIGNATURE,
	string(dispatch.RejectExpired):         commonv1.CommandRejectReason_COMMAND_REJECT_REASON_EXPIRED,
	string(dispatch.RejectStaleGeneration): commonv1.CommandRejectReason_COMMAND_REJECT_REASON_STALE_GENERATION,
	string(dispatch.RejectBusy):            commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BUSY,
}

// updateOf is the CommandUpdate that reports (or replays) a journaled result. Attested results are
// signed by the node key: purpose command-update, parts [command_id, uint32_be(state),
// sha256(result)].
func (a *Agent) updateOf(id string, r journal.Result) *agentv1.CommandUpdate {
	u := &agentv1.CommandUpdate{
		CommandId: id,
		State:     outcomeState[r.Outcome],
		Result:    r.Payload,
		BootId:    r.BootID,
		Rebooted:  r.Rebooted,
	}
	if u.BootId == "" {
		u.BootId = a.bootID
	}
	switch r.Outcome {
	case journal.OutcomeRejected:
		u.RejectReason = rejectReason[r.Reason]
	case journal.OutcomeFailed:
		code := r.Reason
		if code == "" {
			code = "internal"
		}
		u.Error = &agentv1.CommandError{Code: code, Message: r.Message}
	}
	if r.Attested {
		var state [4]byte
		binary.BigEndian.PutUint32(state[:], uint32(u.State))
		digest := sha256.Sum256(u.Result)
		sig, err := pki.SignNodeStatement(a.currentKey(), pki.SigningInput(pki.PurposeCommandUpdate, []byte(id), state[:], digest[:]))
		if err == nil {
			u.NodeSig = sig
		} else {
			a.log.Error("sign an attested result", "id", id, "error", err.Error())
		}
	}
	return u
}

func updateFrame(u *agentv1.CommandUpdate) *agentv1.AgentFrame {
	return &agentv1.AgentFrame{Msg: &agentv1.AgentFrame_Update{Update: u}}
}

// rebootedPayload is the result of a self-terminating command completed by the reboot it caused.
func (a *Agent) rebootedPayload(c journal.Command) []byte {
	if c.Kind != "node.reboot" {
		return nil
	}
	b, err := proto.Marshal(&agentv1.NodeRebootResult{PreviousBootId: c.BootID})
	if err != nil {
		return nil
	}
	return b
}

// currentKey is the node key; renewal swaps it. Callers may hold a.mu (the key is read without it).
func (a *Agent) currentKey() *ecdsa.PrivateKey { return a.key.Load() }
