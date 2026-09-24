package journal

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// eventOverhead approximates the per-event bookkeeping counted against MaxBytes.
const eventOverhead = 32

// maxTickets bounds the exec-ticket jti set; tickets live 60 s, so it holds far fewer.
const maxTickets = 10_000

// MemoryOptions bounds a Memory journal. Zero values select the PLAN.md §6 caps.
type MemoryOptions struct {
	MaxEvents int
	MaxBytes  int
}

// Memory is an in-memory Journal for tests and the simulator. It is not durable: a restarted
// process loses it, which is exactly a journal loss. To simulate a crash with the journal intact,
// keep the Memory and continue with a new Runtime.Incarnation.
type Memory struct {
	mu         sync.Mutex
	maxEvents  int
	maxBytes   int
	meta       Meta
	commands   map[string]Command
	events     []Event
	eventBytes int
	dropped    uint64
	spec       *Spec
	certs      *Certs
	tickets    map[string]time.Time
}

var _ Journal = (*Memory)(nil)

// NewMemory returns an empty journal with a fresh journal_id.
func NewMemory(nodeID string, opts MemoryOptions) *Memory {
	if opts.MaxEvents <= 0 {
		opts.MaxEvents = DefaultMaxEvents
	}
	if opts.MaxBytes <= 0 {
		opts.MaxBytes = DefaultMaxBytes
	}
	return &Memory{
		maxEvents: opts.MaxEvents,
		maxBytes:  opts.MaxBytes,
		meta:      Meta{NodeID: nodeID, JournalID: NewID("jrn")},
		commands:  map[string]Command{},
		tickets:   map[string]time.Time{},
	}
}

func (m *Memory) Meta() (Meta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.meta, nil
}

func (m *Memory) SaveMeta(meta Meta) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.meta.NodeID = meta.NodeID
	m.meta.LastEpoch = meta.LastEpoch
	m.meta.AppliedGeneration = meta.AppliedGeneration
	return nil
}

func (m *Memory) Command(id string) (Command, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.commands[id]
	if !ok {
		return Command{}, false, nil
	}
	return c.clone(), true, nil
}

func (m *Memory) PutCommand(c Command) error {
	if c.ID == "" {
		return errors.New("journal: a command needs an id")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commands[c.ID] = c.clone()
	return nil
}

func (m *Memory) DeleteCommand(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.commands, id)
	return nil
}

func (m *Memory) Commands() ([]Command, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Command, 0, len(m.commands))
	for _, c := range m.commands {
		out = append(out, c.clone())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *Memory) AppendEvent(e Event) (Event, error) {
	switch e.Class {
	case ClassMetric, ClassTransition, ClassResult:
	default:
		return Event{}, fmt.Errorf("journal: unknown event class %d", e.Class)
	}
	size := eventSize(e)
	m.mu.Lock()
	defer m.mu.Unlock()
	// Drop metrics oldest-first only when that can make room: an event larger than the whole cap
	// is refused without touching the backlog.
	for size <= m.maxBytes && !m.fits(size) {
		if !m.dropOldestMetric() {
			break
		}
	}
	if !m.fits(size) {
		if e.Class == ClassMetric {
			m.dropped++
		}
		return Event{}, ErrFull
	}
	m.meta.EventSeq++
	e.Seq = m.meta.EventSeq
	e.Payload = cloneBytes(e.Payload)
	m.events = append(m.events, e)
	m.eventBytes += size
	return e.clone(), nil
}

func (m *Memory) AckEvents(upTo uint64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	kept := make([]Event, 0, len(m.events))
	for _, e := range m.events {
		if e.Seq <= upTo {
			m.eventBytes -= eventSize(e)
			continue
		}
		kept = append(kept, e)
	}
	m.events = kept
	return nil
}

func (m *Memory) UnackedEvents() ([]Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Event, len(m.events))
	for i, e := range m.events {
		out[i] = e.clone()
	}
	return out, nil
}

func (m *Memory) EventStats() (EventStats, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return EventStats{Count: len(m.events), Bytes: m.eventBytes, DroppedMetrics: m.dropped}, nil
}

func (m *Memory) Spec() (Spec, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.spec == nil {
		return Spec{}, false, nil
	}
	return m.spec.clone(), true, nil
}

func (m *Memory) SaveSpec(s Spec) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.spec != nil && s.Generation < m.spec.Generation {
		return ErrStaleSpec
	}
	stored := s.clone()
	m.spec = &stored
	return nil
}

func (m *Memory) Certs() (Certs, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.certs == nil {
		return Certs{}, false, nil
	}
	return m.certs.clone(), true, nil
}

func (m *Memory) SaveCerts(c Certs) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	stored := c.clone()
	m.certs = &stored
	return nil
}

func (m *Memory) RememberTicket(jti string, expiresAt, now time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, exp := range m.tickets {
		if !exp.After(now) {
			delete(m.tickets, id)
		}
	}
	if !expiresAt.After(now) {
		return false, nil
	}
	if _, seen := m.tickets[jti]; seen {
		return false, nil
	}
	if len(m.tickets) >= maxTickets {
		return false, ErrFull
	}
	m.tickets[jti] = expiresAt
	return true, nil
}

func (m *Memory) Close() error { return nil }

// fits reports whether one more event of size fits under both caps. The caller holds m.mu.
func (m *Memory) fits(size int) bool {
	return len(m.events) < m.maxEvents && m.eventBytes+size <= m.maxBytes
}

// dropOldestMetric drops the oldest metric event and reports whether there was one. The caller
// holds m.mu.
func (m *Memory) dropOldestMetric() bool {
	for i, e := range m.events {
		if e.Class != ClassMetric {
			continue
		}
		m.eventBytes -= eventSize(e)
		m.events = append(m.events[:i], m.events[i+1:]...)
		m.dropped++
		return true
	}
	return false
}

func eventSize(e Event) int {
	return eventOverhead + len(e.Kind) + len(e.Payload)
}

func (c Command) clone() Command {
	if c.Result != nil {
		r := *c.Result
		r.Payload = cloneBytes(r.Payload)
		c.Result = &r
	}
	return c
}

func (e Event) clone() Event {
	e.Payload = cloneBytes(e.Payload)
	return e
}

func (s Spec) clone() Spec {
	s.Hash = cloneBytes(s.Hash)
	s.Body = cloneBytes(s.Body)
	s.Signature = cloneBytes(s.Signature)
	return s
}

func (c Certs) clone() Certs {
	c.Chain = cloneChain(c.Chain)
	c.TrustBundle = cloneChain(c.TrustBundle)
	return c
}

func cloneBytes(b []byte) []byte {
	if b == nil {
		return nil
	}
	return append([]byte{}, b...)
}

func cloneChain(chain [][]byte) [][]byte {
	if chain == nil {
		return nil
	}
	out := make([][]byte, len(chain))
	for i, der := range chain {
		out[i] = cloneBytes(der)
	}
	return out
}
