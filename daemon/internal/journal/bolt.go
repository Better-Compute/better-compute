package journal

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"
)

// Bolt is the production journal: one bbolt file (default /var/lib/bcd/journal.db). Every write is a
// bbolt transaction, committed and fsynced before the method returns, which the command rules rely
// on. Events are also indexed in memory (at most MaxEvents) to enforce the caps without scans.
//
// A missing file is a new journal with a fresh journal_id; a file that does not open (corruption) is
// renamed aside and replaced, which the server sees as a journal loss.
type Bolt struct {
	mu         sync.Mutex
	db         *bolt.DB
	maxEvents  int
	maxBytes   int
	meta       Meta
	events     []Event
	eventBytes int
	dropped    uint64
}

var _ Journal = (*Bolt)(nil)

var (
	bucketMeta     = []byte("meta")
	bucketCommands = []byte("commands")
	bucketEvents   = []byte("events")
	bucketTickets  = []byte("tickets")
	keyMeta        = []byte("meta")
	keySpec        = []byte("spec")
	keyCerts       = []byte("certs")
	keyDropped     = []byte("dropped")
)

// BoltOptions bound a Bolt journal. Zero values select the PLAN.md §6 caps.
type BoltOptions struct {
	MaxEvents int
	MaxBytes  int
}

// OpenBolt opens or creates the journal at path. A journal that fails to open is renamed to
// <path>.corrupt-<unix> and a new one starts (a journal loss).
func OpenBolt(path string, opts BoltOptions) (*Bolt, error) {
	if opts.MaxEvents <= 0 || opts.MaxEvents > DefaultMaxEvents {
		opts.MaxEvents = DefaultMaxEvents
	}
	if opts.MaxBytes <= 0 || opts.MaxBytes > DefaultMaxBytes {
		opts.MaxBytes = DefaultMaxBytes
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 5 * time.Second})
	if err != nil && !errors.Is(err, bolt.ErrTimeout) {
		aside := fmt.Sprintf("%s.corrupt-%d", path, time.Now().Unix())
		if renameErr := os.Rename(path, aside); renameErr != nil {
			return nil, fmt.Errorf("journal: %w (and moving it aside failed: %v)", err, renameErr)
		}
		db, err = bolt.Open(path, 0o600, &bolt.Options{Timeout: 5 * time.Second})
	}
	if err != nil {
		return nil, fmt.Errorf("journal: %w", err)
	}
	b := &Bolt{db: db, maxEvents: opts.MaxEvents, maxBytes: opts.MaxBytes}
	if err := b.load(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return b, nil
}

func (b *Bolt) load() error {
	return b.db.Update(func(tx *bolt.Tx) error {
		for _, name := range [][]byte{bucketMeta, bucketCommands, bucketEvents, bucketTickets} {
			if _, err := tx.CreateBucketIfNotExists(name); err != nil {
				return err
			}
		}
		meta := tx.Bucket(bucketMeta)
		if raw := meta.Get(keyMeta); raw != nil {
			if err := json.Unmarshal(raw, &b.meta); err != nil {
				return fmt.Errorf("journal: meta: %w", err)
			}
		} else {
			b.meta = Meta{JournalID: NewID("jrn")}
			if err := putJSON(meta, keyMeta, b.meta); err != nil {
				return err
			}
		}
		if raw := meta.Get(keyDropped); len(raw) == 8 {
			b.dropped = binary.BigEndian.Uint64(raw)
		}
		return tx.Bucket(bucketEvents).ForEach(func(_, v []byte) error {
			var e Event
			if err := json.Unmarshal(v, &e); err != nil {
				return fmt.Errorf("journal: event: %w", err)
			}
			b.events = append(b.events, e)
			b.eventBytes += eventSize(e)
			return nil
		})
	})
}

func putJSON(bucket *bolt.Bucket, key []byte, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return bucket.Put(key, raw)
}

func seqKey(seq uint64) []byte {
	k := make([]byte, 8)
	binary.BigEndian.PutUint64(k, seq)
	return k
}

func (b *Bolt) Meta() (Meta, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.meta, nil
}

func (b *Bolt) SaveMeta(meta Meta) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	next := b.meta
	next.NodeID = meta.NodeID
	next.LastEpoch = meta.LastEpoch
	next.AppliedGeneration = meta.AppliedGeneration
	if meta.ServerTime.After(next.ServerTime) {
		next.ServerTime = meta.ServerTime
	}
	if err := b.db.Update(func(tx *bolt.Tx) error {
		return putJSON(tx.Bucket(bucketMeta), keyMeta, next)
	}); err != nil {
		return err
	}
	b.meta = next
	return nil
}

func (b *Bolt) Command(id string) (Command, bool, error) {
	var c Command
	found := false
	err := b.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketCommands).Get([]byte(id))
		if raw == nil {
			return nil
		}
		found = true
		return json.Unmarshal(raw, &c)
	})
	return c, found, err
}

func (b *Bolt) PutCommand(c Command) error {
	if c.ID == "" {
		return errors.New("journal: a command needs an id")
	}
	return b.db.Update(func(tx *bolt.Tx) error {
		return putJSON(tx.Bucket(bucketCommands), []byte(c.ID), c)
	})
}

func (b *Bolt) DeleteCommand(id string) error {
	return b.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketCommands).Delete([]byte(id))
	})
}

func (b *Bolt) Commands() ([]Command, error) {
	var out []Command
	err := b.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketCommands).ForEach(func(_, v []byte) error {
			var c Command
			if err := json.Unmarshal(v, &c); err != nil {
				return err
			}
			out = append(out, c)
			return nil
		})
	})
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, err
}

func (b *Bolt) AppendEvent(e Event) (Event, error) {
	switch e.Class {
	case ClassMetric, ClassTransition, ClassResult:
	default:
		return Event{}, fmt.Errorf("journal: unknown event class %d", e.Class)
	}
	size := eventSize(e)
	b.mu.Lock()
	defer b.mu.Unlock()
	// Plan the metric drops first; nothing changes unless the write commits.
	var drop []int
	bytes, count := b.eventBytes, len(b.events)
	fits := func() bool { return count < b.maxEvents && bytes+size <= b.maxBytes }
	for i := 0; size <= b.maxBytes && !fits() && i < len(b.events); i++ {
		if b.events[i].Class == ClassMetric {
			drop = append(drop, i)
			bytes -= eventSize(b.events[i])
			count--
		}
	}
	if !fits() {
		if e.Class == ClassMetric {
			b.dropped++
			_ = b.db.Update(func(tx *bolt.Tx) error {
				return tx.Bucket(bucketMeta).Put(keyDropped, seqKey(b.dropped))
			})
		}
		return Event{}, ErrFull
	}
	next := b.meta
	next.EventSeq++
	e.Seq = next.EventSeq
	e.Payload = cloneBytes(e.Payload)
	dropped := b.dropped + uint64(len(drop))
	err := b.db.Update(func(tx *bolt.Tx) error {
		events := tx.Bucket(bucketEvents)
		for _, i := range drop {
			if err := events.Delete(seqKey(b.events[i].Seq)); err != nil {
				return err
			}
		}
		if err := putJSON(events, seqKey(e.Seq), e); err != nil {
			return err
		}
		if len(drop) > 0 {
			if err := tx.Bucket(bucketMeta).Put(keyDropped, seqKey(dropped)); err != nil {
				return err
			}
		}
		return putJSON(tx.Bucket(bucketMeta), keyMeta, next)
	})
	if err != nil {
		return Event{}, err
	}
	for k := len(drop) - 1; k >= 0; k-- {
		i := drop[k]
		b.events = append(b.events[:i], b.events[i+1:]...)
	}
	b.events = append(b.events, e)
	b.eventBytes = bytes + size
	b.dropped = dropped
	b.meta = next
	return e.clone(), nil
}

func (b *Bolt) AckEvents(upTo uint64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	cut := 0
	for cut < len(b.events) && b.events[cut].Seq <= upTo {
		cut++
	}
	if cut == 0 {
		return nil
	}
	err := b.db.Update(func(tx *bolt.Tx) error {
		events := tx.Bucket(bucketEvents)
		for _, e := range b.events[:cut] {
			if err := events.Delete(seqKey(e.Seq)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, e := range b.events[:cut] {
		b.eventBytes -= eventSize(e)
	}
	b.events = append([]Event(nil), b.events[cut:]...)
	return nil
}

func (b *Bolt) UnackedEvents() ([]Event, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Event, len(b.events))
	for i, e := range b.events {
		out[i] = e.clone()
	}
	return out, nil
}

func (b *Bolt) EventStats() (EventStats, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return EventStats{Count: len(b.events), Bytes: b.eventBytes, DroppedMetrics: b.dropped}, nil
}

func (b *Bolt) Spec() (Spec, bool, error) {
	var s Spec
	found := false
	err := b.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketMeta).Get(keySpec)
		if raw == nil {
			return nil
		}
		found = true
		return json.Unmarshal(raw, &s)
	})
	return s, found, err
}

func (b *Bolt) SaveSpec(s Spec) error {
	return b.db.Update(func(tx *bolt.Tx) error {
		meta := tx.Bucket(bucketMeta)
		if raw := meta.Get(keySpec); raw != nil {
			var current Spec
			if err := json.Unmarshal(raw, &current); err == nil && s.Generation < current.Generation {
				return ErrStaleSpec
			}
		}
		return putJSON(meta, keySpec, s)
	})
}

func (b *Bolt) Certs() (Certs, bool, error) {
	var c Certs
	found := false
	err := b.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketMeta).Get(keyCerts)
		if raw == nil {
			return nil
		}
		found = true
		return json.Unmarshal(raw, &c)
	})
	return c, found, err
}

func (b *Bolt) SaveCerts(c Certs) error {
	return b.db.Update(func(tx *bolt.Tx) error {
		return putJSON(tx.Bucket(bucketMeta), keyCerts, c)
	})
}

func (b *Bolt) RememberTicket(jti string, expiresAt, now time.Time) (bool, error) {
	fresh := false
	err := b.db.Update(func(tx *bolt.Tx) error {
		tickets := tx.Bucket(bucketTickets)
		var expired [][]byte
		n := 0
		_ = tickets.ForEach(func(k, v []byte) error {
			if len(v) == 8 && int64(binary.BigEndian.Uint64(v)) <= now.UnixNano() {
				expired = append(expired, append([]byte(nil), k...))
			} else {
				n++
			}
			return nil
		})
		for _, k := range expired {
			if err := tickets.Delete(k); err != nil {
				return err
			}
		}
		if !expiresAt.After(now) || tickets.Get([]byte(jti)) != nil {
			return nil
		}
		if n >= maxTickets {
			return ErrFull
		}
		fresh = true
		return tickets.Put([]byte(jti), seqKey(uint64(expiresAt.UnixNano())))
	})
	if err != nil {
		return false, err
	}
	return fresh, nil
}

// Close closes the file.
func (b *Bolt) Close() error { return b.db.Close() }
