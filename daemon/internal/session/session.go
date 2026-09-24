// Package session is the daemon's side of the agent/v1 Session stream (PLAN.md §7.1, §7.2, §7.4,
// §7.5; proto/bettercompute/agent/v1/session.proto). One connection at a time:
//
//	dial gw.<region>:443, mTLS; the gateway serving CA is pinned by config.toml's SPKI pin
//	→ Hello{node_id, boot_id, journal_id, role, versions, capabilities, drivers, last_epoch,
//	        applied_generation, unacked_results, running_command_ids, last_event_seq,
//	        inventory_hashes, applied_spec_hash}
//	← Welcome{epoch, heartbeat, lease TTL, credits, acked_event_seq, request_sections, server_time}
//	← DesiredState when applied_generation < generation, then the non-terminal commands in seq order
//	→ unacked results and the events after acked_event_seq; the server dedupes and Acks
//
// Epoch. The gateway bumps node_sessions.session_epoch on every Hello and fences its routing and
// liveness writes with it, so a zombie gateway cannot route. The daemon records the epoch
// (journal meta last_epoch) but never fences on it: results and events are facts, accepted from
// any epoch and deduplicated by command id and by (journal_id, seq).
//
// Resume. Before answering Welcome the server completes in-flight self-terminating commands when
// boot_id or role changed, and fails in-flight non-retry-safe commands when journal_id changed
// ('journal-lost'). The journal dedupes every command the server replays (journal.Resolve).
//
// Liveness. A Heartbeat goes every Welcome heartbeat interval (10 s by default) with the free lane
// credits, and every 10th also carries the inventory section hashes; three missed heartbeats close
// the session. Reconnects back off from 1 s to 60 s with full jitter (Backoff); Drain reconnects
// after its jittered delay. Offline, the daemon keeps enforcing its last spec and journals events.
//
// TODO(v0.1): Conn over connect-go and daemon/gen, Join (sealed token, signed JoinResponse) and
// Renew with proof of possession.
package session

import (
	"context"
	"fmt"
	"math/rand"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/journal"
)

// Protocol versions this daemon speaks (Hello.proto_min, Hello.proto_max).
const (
	ProtoMin uint32 = 1
	ProtoMax uint32 = 1
)

// Liveness defaults, used when Welcome leaves a value unset.
const (
	DefaultHeartbeat    = 10 * time.Second
	DefaultLeaseTTL     = 40 * time.Second
	MissedHeartbeatsMax = 3
)

// Identity is what the daemon knows about itself after joining.
type Identity struct {
	NodeID        string
	Role          dispatch.Role
	DaemonVersion string
	Capabilities  []string
}

// Hello mirrors agent/v1 Hello; UnackedResults holds the journal entries that become
// CommandUpdates. TODO(v0.1): replace it with the daemon/gen type (and add drivers).
type Hello struct {
	NodeID            string
	BootID            string
	JournalID         string
	Role              dispatch.Role
	DaemonVersion     string
	ProtoMin          uint32
	ProtoMax          uint32
	Capabilities      []string
	LastEpoch         uint64
	AppliedGeneration uint64
	UnackedResults    []journal.Command
	RunningCommandIDs []string
	LastEventSeq      uint64
	InventoryHashes   map[string][]byte
	AppliedSpecHash   []byte
}

// Welcome mirrors agent/v1 Welcome, with the millisecond fields as durations.
type Welcome struct {
	Epoch             uint64
	SessionID         string
	GatewayID         string
	ProtocolVersion   uint32
	HeartbeatInterval time.Duration
	LeaseTTL          time.Duration
	Credits           map[dispatch.Lane]int
	// AckedEventSeq is the cumulative ack of the events of Hello.journal_id.
	AckedEventSeq   uint64
	RequestSections []string
	ServerTime      time.Time
	// UpgradeRequired restricts the session to daemon.upgrade (v0.4).
	UpgradeRequired bool
}

// Heartbeat returns the heartbeat interval, or DefaultHeartbeat when the server left it unset.
func (w Welcome) Heartbeat() time.Duration {
	if w.HeartbeatInterval > 0 {
		return w.HeartbeatInterval
	}
	return DefaultHeartbeat
}

// ClockOffset is the server time minus the local time at which Welcome arrived; the daemon adds it
// to its clock to evaluate not_after (dispatch.Env.Now).
func (w Welcome) ClockOffset(receivedAt time.Time) time.Duration {
	return w.ServerTime.Sub(receivedAt)
}

// Ack mirrors agent/v1 Ack: the events and terminal results the control plane has stored.
type Ack struct {
	JournalID  string
	EventSeq   uint64
	CommandIDs []string
}

// NewHello builds the Hello that opens a session from the journal: the results the server has not
// acked, the commands this process still has in flight, and the event and generation cursors.
func NewHello(j journal.Journal, id Identity, rt journal.Runtime, inventoryHashes map[string][]byte) (Hello, error) {
	meta, err := j.Meta()
	if err != nil {
		return Hello{}, err
	}
	if meta.NodeID != "" && meta.NodeID != id.NodeID {
		return Hello{}, fmt.Errorf("session: the journal belongs to node %s, not %s", meta.NodeID, id.NodeID)
	}
	commands, err := j.Commands()
	if err != nil {
		return Hello{}, err
	}
	spec, haveSpec, err := j.Spec()
	if err != nil {
		return Hello{}, err
	}
	h := Hello{
		NodeID:            id.NodeID,
		BootID:            rt.BootID,
		JournalID:         meta.JournalID,
		Role:              id.Role,
		DaemonVersion:     id.DaemonVersion,
		ProtoMin:          ProtoMin,
		ProtoMax:          ProtoMax,
		Capabilities:      append([]string(nil), id.Capabilities...),
		LastEpoch:         meta.LastEpoch,
		AppliedGeneration: meta.AppliedGeneration,
		LastEventSeq:      meta.EventSeq,
		InventoryHashes:   inventoryHashes,
	}
	if haveSpec {
		h.AppliedSpecHash = spec.Hash
	}
	for _, c := range commands {
		switch {
		case c.State == journal.StateDone && !c.ResultAcked:
			h.UnackedResults = append(h.UnackedResults, c)
		case c.State != journal.StateDone && c.Incarnation == rt.Incarnation:
			h.RunningCommandIDs = append(h.RunningCommandIDs, c.ID)
		}
	}
	return h, nil
}

// ApplyWelcome records the session epoch and forgets the events the server already has.
func ApplyWelcome(j journal.Journal, w Welcome) error {
	meta, err := j.Meta()
	if err != nil {
		return err
	}
	meta.LastEpoch = w.Epoch
	if err := j.SaveMeta(meta); err != nil {
		return err
	}
	return j.AckEvents(w.AckedEventSeq)
}

// ApplyAck forgets the acked events of this journal (an Ack for another journal_id acks no events)
// and stops replaying the acked results. Unknown or unfinished command ids are ignored.
func ApplyAck(j journal.Journal, a Ack) error {
	meta, err := j.Meta()
	if err != nil {
		return err
	}
	if a.JournalID == meta.JournalID {
		if err := j.AckEvents(a.EventSeq); err != nil {
			return err
		}
	}
	for _, id := range a.CommandIDs {
		c, ok, err := j.Command(id)
		if err != nil {
			return err
		}
		if !ok || c.State != journal.StateDone || c.ResultAcked {
			continue
		}
		if err := journal.AckResult(j, id); err != nil {
			return err
		}
	}
	return nil
}

// Backoff is the reconnect schedule: attempt n waits a uniformly random delay in
// [0, min(Max, Min·2ⁿ)] ("full jitter"), which spreads a reconnect storm across the window.
type Backoff struct {
	Min time.Duration
	Max time.Duration
}

// DefaultBackoff is PLAN.md §6's 1 s → 60 s.
var DefaultBackoff = Backoff{Min: time.Second, Max: time.Minute}

// Ceiling returns the upper bound of the delay before reconnect attempt n, counting from 0.
func (b Backoff) Ceiling(attempt int) time.Duration {
	d := b.Min
	for i := 0; i < attempt && d < b.Max; i++ {
		d *= 2
	}
	if d > b.Max {
		d = b.Max
	}
	return d
}

// Delay draws the delay before reconnect attempt n from r.
func (b Backoff) Delay(attempt int, r *rand.Rand) time.Duration {
	ceiling := b.Ceiling(attempt)
	if ceiling <= 0 {
		return 0
	}
	return time.Duration(r.Int63n(int64(ceiling) + 1))
}

// Conn is one established Session stream. TODO(v0.1): implemented over connect-go on daemon/gen,
// with the frames that follow the handshake.
type Conn interface {
	// Handshake sends Hello and waits for Welcome.
	Handshake(ctx context.Context, hello Hello) (Welcome, error)
	// Close ends the stream.
	Close() error
}

// Dialer opens Session streams to the gateway.
type Dialer interface {
	Dial(ctx context.Context) (Conn, error)
}
