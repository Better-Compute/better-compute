// Package journal is the daemon's durable memory (PLAN.md §6 "Journal"):
//
//   - meta: node id, journal_id, event seq, last epoch, applied generation;
//   - commands: id → accepted | running{boot_id} | done + result, kept for 7 days (CommandTTL);
//   - unacked events: metric-like events are dropped oldest-first when the journal is full, results
//     and transitions never are;
//   - the last full spec with its hash and signature, enforced while offline;
//   - certificates, and the exec-ticket jti set.
//
// Every write must be durable (fsynced) before the method returns: the command rules in rules.go
// rely on `accepted` reaching disk before any side effect, and on self-terminating kinds persisting
// `running{boot_id}` immediately before theirs.
//
// A lost journal (ramdisk reboot, reinstall, corruption) starts over with a new journal_id; the node
// identity stays with its key. The server then fails in-flight non-retry-safe commands instead of
// replaying them (PLAN.md §7.2).
//
// The production store is bbolt, capped at 64 MiB / 10k events. TODO(v0.1): add it once a Go
// toolchain can produce go.sum for go.etcd.io/bbolt; until then Memory is the only implementation,
// used by tests and the simulator.
package journal

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"
)

// Caps from PLAN.md §6 (P12: everything is bounded).
const (
	DefaultMaxBytes  = 64 << 20
	DefaultMaxEvents = 10_000
)

// CommandTTL is how long a done command is kept to answer duplicate deliveries.
const CommandTTL = 7 * 24 * time.Hour

var (
	// ErrFull reports an event the journal cannot hold without dropping a result or transition. The
	// node stops accepting commands (they get BUSY) until Acks drain the backlog.
	ErrFull = errors.New("journal: full")

	// ErrNotFound reports an operation on a command the journal has no entry for.
	ErrNotFound = errors.New("journal: command not found")

	// ErrStaleSpec reports a spec older than the one already stored.
	ErrStaleSpec = errors.New("journal: spec generation is older than the stored spec")
)

// Journal is the §6 journal contract. Implementations are safe for concurrent use; values passed in
// and returned are copies, never shared with the store.
type Journal interface {
	// Meta returns the journal's metadata.
	Meta() (Meta, error)
	// SaveMeta stores NodeID, LastEpoch and AppliedGeneration. JournalID and EventSeq belong to the
	// journal and are ignored.
	SaveMeta(Meta) error

	// Command returns the entry for id, and false when there is none.
	Command(id string) (Command, bool, error)
	// PutCommand creates or replaces an entry, durably.
	PutCommand(Command) error
	// DeleteCommand removes an entry; removing a missing entry is not an error.
	DeleteCommand(id string) error
	// Commands returns every entry, ordered by id.
	Commands() ([]Command, error)

	// AppendEvent assigns the next seq and stores the event. When the journal is full it drops the
	// oldest metric events to make room; if that is not enough it returns ErrFull.
	AppendEvent(Event) (Event, error)
	// AckEvents forgets every event with seq <= upTo (the server's cumulative ack).
	AckEvents(upTo uint64) error
	// UnackedEvents returns the stored events in seq order.
	UnackedEvents() ([]Event, error)
	// EventStats reports the event backlog.
	EventStats() (EventStats, error)

	// Spec returns the last full spec, and false when there is none.
	Spec() (Spec, bool, error)
	// SaveSpec replaces the stored spec; an older generation returns ErrStaleSpec.
	SaveSpec(Spec) error

	// Certs returns the stored certificates, and false when there are none.
	Certs() (Certs, bool, error)
	// SaveCerts replaces the stored certificates.
	SaveCerts(Certs) error

	// RememberTicket records an exec-ticket jti until expiresAt and reports whether it was fresh:
	// false means a replay, or a ticket already expired at now. It forgets jtis expired at now.
	RememberTicket(jti string, expiresAt, now time.Time) (bool, error)

	// Close releases the store.
	Close() error
}

// Meta is the journal's metadata.
type Meta struct {
	NodeID            string
	JournalID         string
	EventSeq          uint64
	LastEpoch         uint64
	AppliedGeneration uint64
}

// State is a command entry's state.
type State string

// Command entry states.
const (
	StateAccepted State = "accepted"
	StateRunning  State = "running"
	StateDone     State = "done"
)

// Outcome is a done command's terminal outcome, as reported in CommandUpdate.
type Outcome string

// Terminal outcomes.
const (
	OutcomeSucceeded Outcome = "succeeded"
	OutcomeFailed    Outcome = "failed"
	OutcomeRejected  Outcome = "rejected"
)

// ReasonInterrupted is the failure reason for a non-retry-safe command a crash interrupted.
const ReasonInterrupted = "interrupted"

// Result is a done command's result.
type Result struct {
	Outcome Outcome
	// Reason explains a failure or rejection, such as ReasonInterrupted or EXPIRED.
	Reason string
	// Rebooted marks a self-terminating command completed by the reboot it caused.
	Rebooted bool
	// Payload is the kind-specific result body.
	Payload []byte
}

// Command is one entry of the command table.
type Command struct {
	ID   string
	Kind string
	// RetrySafe and SelfTerminating are copied from the CommandBody that was accepted.
	RetrySafe       bool
	SelfTerminating bool
	State           State
	// BootID is the boot the command started running in (StateRunning).
	BootID string
	// Incarnation is the daemon process that last wrote the entry; see Runtime.
	Incarnation string
	// Result is set once the command is done.
	Result *Result
	// ResultAcked is set once the server acknowledged the result; until then Hello replays it.
	ResultAcked bool
	UpdatedAt   time.Time
}

// EventClass decides whether an event may be dropped when the journal is full.
type EventClass uint8

// Event classes. Only metric-like events are ever dropped.
const (
	ClassMetric EventClass = iota + 1
	ClassTransition
	ClassResult
)

// Event is one journaled event, sent to the server in an EventBatch until acked.
type Event struct {
	Seq     uint64
	Class   EventClass
	Kind    string
	Payload []byte
}

// EventStats describes the event backlog.
type EventStats struct {
	Count          int
	Bytes          int
	DroppedMetrics uint64
}

// Spec is the last full desired state, as received in DesiredState.
type Spec struct {
	Generation uint64
	Hash       []byte
	Body       []byte
	Signature  []byte
}

// Certs is the node certificate chain and the command-signing trust bundle from JoinResponse.
type Certs struct {
	Chain       [][]byte
	TrustBundle [][]byte
	NotAfter    time.Time
}

// NewID returns prefix, an underscore and 32 random hex digits. It names journals ("jrn") and
// daemon incarnations ("inc").
func NewID(prefix string) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("journal: crypto/rand failed: " + err.Error())
	}
	return prefix + "_" + hex.EncodeToString(b[:])
}
