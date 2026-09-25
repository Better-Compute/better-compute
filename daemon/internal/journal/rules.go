package journal

import (
	"errors"
	"fmt"
	"time"
)

// This file holds the command rules of PLAN.md §6 "Command semantics" on top of any Journal.
//
// A delivered command goes through Resolve first. A new command (ActionExecute) or an interrupted
// retry-safe one (ActionReexecute) then passes the acceptance checks in package dispatch, and Accept
// makes `accepted` durable before any side effect. Self-terminating kinds call MarkRunning
// immediately before theirs; other kinds call it when they start. Complete records the result,
// which Hello replays until AckResult.
//
// "Crashed" is decided per daemon process: every process start picks a fresh Runtime.Incarnation,
// and an accepted or running entry written by another incarnation belongs to a process that no
// longer exists, so nothing is left to re-attach to.

// Runtime identifies the running daemon process to the command rules.
type Runtime struct {
	// BootID is the kernel boot id (/proc/sys/kernel/random/boot_id).
	BootID string
	// Incarnation is fresh for every daemon process start (NewID("inc")).
	Incarnation string
	// Now is the time entries are stamped with.
	Now time.Time
	// RebootedPayload, when set, gives the result body of a self-terminating command completed by
	// the reboot it caused (node.reboot: NodeRebootResult{previous_boot_id = the entry's BootID}).
	RebootedPayload func(Command) []byte
	// Restarted, when set, decides a running self-terminating command that ended its process without
	// a reboot: daemon.upgrade execs the new binary and completes through upgrade.json (PLAN.md §6
	// "Self-update"). handled=false: not such a command (the other rules apply). A nil result leaves
	// the entry running for this process to complete (the new binary waits for its Welcome).
	Restarted func(Command) (r *Result, handled bool)
}

// Delivery is what the rules need from a delivered CommandBody.
type Delivery struct {
	ID              string
	Kind            string
	RetrySafe       bool
	SelfTerminating bool
}

// Action tells the dispatcher what to do with a delivered command.
type Action uint8

const (
	// ActionExecute: the command is new. Run the acceptance checks, then Accept and execute it.
	ActionExecute Action = iota + 1
	// ActionResend: the command is done. Resend the stored result.
	ActionResend
	// ActionReattach: this process has the command accepted or running. The execution in flight
	// reports the result; do nothing else.
	ActionReattach
	// ActionReexecute: a crash interrupted a retry-safe command. Run the acceptance checks again,
	// then Accept and execute it.
	ActionReexecute
	// ActionReport: Resolve completed the command without executing it (FAILED{interrupted}, or
	// SUCCEEDED{rebooted} for a self-terminating kind whose reboot happened). Send the result.
	ActionReport
)

func (a Action) String() string {
	switch a {
	case ActionExecute:
		return "execute"
	case ActionResend:
		return "resend"
	case ActionReattach:
		return "reattach"
	case ActionReexecute:
		return "reexecute"
	case ActionReport:
		return "report"
	}
	return fmt.Sprintf("Action(%d)", uint8(a))
}

// Decision is Resolve's answer. Result is set for ActionResend and ActionReport.
type Decision struct {
	Action Action
	Result *Result
}

// Resolve applies the duplicate-delivery rules to a delivered command:
//
//   - no entry → ActionExecute;
//   - done → ActionResend with the stored result;
//   - accepted or running in this incarnation → ActionReattach;
//   - running a self-terminating kind that Runtime.Restarted decides → its result, ActionReport, or
//     ActionReattach while this process still completes it;
//   - running a self-terminating kind in an earlier incarnation and an earlier boot → the reboot
//     it caused completed it: SUCCEEDED{rebooted}, ActionReport;
//   - otherwise left by an earlier incarnation → ActionReexecute if retry-safe, else
//     FAILED{interrupted} for the controller to decide, ActionReport.
//
// Entries are judged by the flags stored when they were accepted, not by the redelivered copy.
func Resolve(j Journal, d Delivery, rt Runtime) (Decision, error) {
	c, ok, err := j.Command(d.ID)
	if err != nil {
		return Decision{}, err
	}
	switch {
	case !ok:
		return Decision{Action: ActionExecute}, nil
	case c.State == StateDone:
		return Decision{Action: ActionResend, Result: c.Result}, nil
	case c.Incarnation == rt.Incarnation:
		return Decision{Action: ActionReattach}, nil
	}
	r, reexecute, pending := interrupted(c, rt)
	if pending {
		return Decision{Action: ActionReattach}, nil
	}
	if reexecute {
		return Decision{Action: ActionReexecute}, nil
	}
	done, err := finish(j, c, r, rt.Now)
	if err != nil {
		return Decision{}, err
	}
	return Decision{Action: ActionReport, Result: done.Result}, nil
}

// Accept durably records d as accepted by this incarnation. It must return before any side effect.
func Accept(j Journal, d Delivery, rt Runtime) error {
	if d.ID == "" {
		return errors.New("journal: a command needs an id")
	}
	c, ok, err := j.Command(d.ID)
	if err != nil {
		return err
	}
	if ok && c.State == StateDone {
		return fmt.Errorf("journal: command %s is already done", d.ID)
	}
	return j.PutCommand(Command{
		ID:              d.ID,
		Kind:            d.Kind,
		RetrySafe:       d.RetrySafe,
		SelfTerminating: d.SelfTerminating,
		State:           StateAccepted,
		Incarnation:     rt.Incarnation,
		UpdatedAt:       rt.Now,
	})
}

// MarkRunning moves an accepted command to running{boot_id}. Self-terminating kinds call it
// immediately before their side effect, so a restart can tell the reboot they caused from a crash.
func MarkRunning(j Journal, id string, rt Runtime) error {
	c, ok, err := j.Command(id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	if c.State != StateAccepted {
		return fmt.Errorf("journal: command %s is %s, not accepted", id, c.State)
	}
	c.State = StateRunning
	c.BootID = rt.BootID
	c.Incarnation = rt.Incarnation
	c.UpdatedAt = rt.Now
	return j.PutCommand(c)
}

// Complete records a command's result.
func Complete(j Journal, id string, r Result, now time.Time) error {
	switch r.Outcome {
	case OutcomeSucceeded, OutcomeFailed, OutcomeRejected, OutcomeCancelled:
	default:
		return fmt.Errorf("journal: invalid outcome %q", r.Outcome)
	}
	c, ok, err := j.Command(id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	if c.State == StateDone {
		return fmt.Errorf("journal: command %s is already done", id)
	}
	_, err = finish(j, c, r, now)
	return err
}

// AckResult records that the server has a done command's result, so Hello stops replaying it.
func AckResult(j Journal, id string) error {
	c, ok, err := j.Command(id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	if c.State != StateDone {
		return fmt.Errorf("journal: command %s is %s, not done", id, c.State)
	}
	c.ResultAcked = true
	return j.PutCommand(c)
}

// Recover runs once at daemon start. It completes the entries an earlier incarnation left accepted
// or running whose outcome needs no server input (SUCCEEDED{rebooted} and FAILED{interrupted}) and
// returns them, to report in Hello.unacked_results. Retry-safe entries stay until the server
// redelivers them, so re-execution passes the acceptance checks (not_after, min_generation) again.
func Recover(j Journal, rt Runtime) ([]Command, error) {
	all, err := j.Commands()
	if err != nil {
		return nil, err
	}
	var completed []Command
	for _, c := range all {
		if c.State == StateDone || c.Incarnation == rt.Incarnation {
			continue
		}
		r, reexecute, pending := interrupted(c, rt)
		if reexecute || pending {
			continue
		}
		done, err := finish(j, c, r, rt.Now)
		if err != nil {
			return completed, err
		}
		completed = append(completed, done)
	}
	return completed, nil
}

// Sweep deletes done commands last updated before now-ttl (CommandTTL in production) and returns
// how many it removed. An accepted or running entry is swept only when an earlier incarnation left
// it (a retry-safe command Recover kept for a redelivery) and nothing redelivered it within ttl: the
// server has long expired it. Entries of the running incarnation are in flight and never swept.
func Sweep(j Journal, now time.Time, ttl time.Duration, incarnation string) (int, error) {
	all, err := j.Commands()
	if err != nil {
		return 0, err
	}
	cutoff := now.Add(-ttl)
	removed := 0
	for _, c := range all {
		if !c.UpdatedAt.Before(cutoff) || (c.State != StateDone && c.Incarnation == incarnation) {
			continue
		}
		if err := j.DeleteCommand(c.ID); err != nil {
			return removed, err
		}
		removed++
	}
	return removed, nil
}

// interrupted decides an entry an earlier incarnation left accepted or running: the result to
// report, reexecute=true for a retry-safe command, or pending=true for one this process completes
// later (Runtime.Restarted).
func interrupted(c Command, rt Runtime) (r Result, reexecute, pending bool) {
	if c.State == StateRunning && c.SelfTerminating && rt.Restarted != nil {
		if decided, handled := rt.Restarted(c); handled {
			if decided == nil {
				return Result{}, false, true
			}
			r = *decided
			if r.BootID == "" {
				r.BootID = rt.BootID
			}
			return r, false, false
		}
	}
	if c.State == StateRunning && c.SelfTerminating && c.BootID != rt.BootID {
		r := Result{Outcome: OutcomeSucceeded, Rebooted: true, BootID: rt.BootID}
		if rt.RebootedPayload != nil {
			r.Payload = rt.RebootedPayload(c)
		}
		return r, false, false
	}
	if c.RetrySafe {
		return Result{}, true, false
	}
	return Result{Outcome: OutcomeFailed, Reason: ReasonInterrupted, BootID: rt.BootID}, false, false
}

// RecordRejection journals a terminal rejection (UNSUPPORTED, EXPIRED, STALE_GENERATION,
// BAD_SIGNATURE) as a done entry with outcome rejected and the code as Reason, so a duplicate
// delivery resends the same answer and Hello replays it until acked. BUSY is never journaled.
func RecordRejection(j Journal, d Delivery, reason string, rt Runtime) (Result, error) {
	if d.ID == "" {
		return Result{}, errors.New("journal: a command needs an id")
	}
	r := Result{Outcome: OutcomeRejected, Reason: reason, BootID: rt.BootID}
	err := j.PutCommand(Command{
		ID:              d.ID,
		Kind:            d.Kind,
		RetrySafe:       d.RetrySafe,
		SelfTerminating: d.SelfTerminating,
		State:           StateDone,
		Incarnation:     rt.Incarnation,
		Result:          &r,
		UpdatedAt:       rt.Now,
	})
	return r, err
}

func finish(j Journal, c Command, r Result, now time.Time) (Command, error) {
	c.State = StateDone
	c.Result = &r
	c.ResultAcked = false
	c.UpdatedAt = now
	if err := j.PutCommand(c); err != nil {
		return Command{}, err
	}
	return c, nil
}
