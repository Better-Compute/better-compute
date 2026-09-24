package dispatch

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// Lane is a command lane (agent/v1 Lane). Lanes keep slow provisioning and bulk work from starving
// control commands.
type Lane uint8

// Lanes, in the order of the proto enum.
const (
	LaneControl Lane = iota + 1
	LaneProvision
	LaneBulk
)

func (l Lane) String() string {
	switch l {
	case LaneControl:
		return "control"
	case LaneProvision:
		return "provision"
	case LaneBulk:
		return "bulk"
	}
	return fmt.Sprintf("Lane(%d)", uint8(l))
}

func (l Lane) valid() bool { return l >= LaneControl && l <= LaneBulk }

// ErrUnknownLane reports a lane the daemon has no pool for.
var ErrUnknownLane = errors.New("dispatch: unknown lane")

// LaneConfig sizes one lane: Credits bounds the commands admitted at once (running or waiting for
// a worker), Workers bounds the ones running.
type LaneConfig struct {
	Credits int
	Workers int
}

// DefaultLanes returns the server credits of PLAN.md §7.5 and the daemon worker pools of §6.
func DefaultLanes() map[Lane]LaneConfig {
	return map[Lane]LaneConfig{
		LaneControl:   {Credits: 8, Workers: 4},
		LaneProvision: {Credits: 4, Workers: 2},
		LaneBulk:      {Credits: 2, Workers: 1},
	}
}

// Lanes holds the credits and worker pool of every lane.
type Lanes struct {
	lanes map[Lane]*lane
}

type lane struct {
	credits *Semaphore
	workers *Semaphore
}

// NewLanes builds the lanes described by config. Every lane needs 0 < workers <= credits.
func NewLanes(config map[Lane]LaneConfig) (*Lanes, error) {
	l := &Lanes{lanes: make(map[Lane]*lane, len(config))}
	for id, c := range config {
		if !id.valid() {
			return nil, fmt.Errorf("%w %s", ErrUnknownLane, id)
		}
		if c.Workers <= 0 || c.Workers > c.Credits {
			return nil, fmt.Errorf("dispatch: lane %s needs 0 < workers (%d) <= credits (%d)", id, c.Workers, c.Credits)
		}
		l.lanes[id] = &lane{credits: NewSemaphore(c.Credits), workers: NewSemaphore(c.Workers)}
	}
	return l, nil
}

// Admit takes one credit on the lane, held from acceptance until the result is journaled. ok is
// false when the lane is full: the command is answered BUSY. release is idempotent.
func (l *Lanes) Admit(id Lane) (release func(), ok bool, err error) {
	ln, err := l.lane(id)
	if err != nil {
		return nil, false, err
	}
	if !ln.credits.TryAcquire() {
		return nil, false, nil
	}
	return once(ln.credits.Release), true, nil
}

// Work blocks until one of the lane's workers is free or ctx is done. release is idempotent.
func (l *Lanes) Work(ctx context.Context, id Lane) (release func(), err error) {
	ln, err := l.lane(id)
	if err != nil {
		return nil, err
	}
	if err := ln.workers.Acquire(ctx); err != nil {
		return nil, err
	}
	return once(ln.workers.Release), nil
}

// InUse reports the credits and workers taken on a lane, for status and metrics.
func (l *Lanes) InUse(id Lane) (credits, workers int) {
	ln, ok := l.lanes[id]
	if !ok {
		return 0, 0
	}
	return ln.credits.InUse(), ln.workers.InUse()
}

func (l *Lanes) lane(id Lane) (*lane, error) {
	ln, ok := l.lanes[id]
	if !ok {
		return nil, fmt.Errorf("%w %s", ErrUnknownLane, id)
	}
	return ln, nil
}

func once(f func()) func() {
	var o sync.Once
	return func() { o.Do(f) }
}

// Semaphore is a counting semaphore whose Acquire honours a context.
type Semaphore struct {
	slots chan struct{}
}

// NewSemaphore returns a semaphore with n slots; n must be positive.
func NewSemaphore(n int) *Semaphore {
	if n <= 0 {
		panic("dispatch: a semaphore needs at least one slot")
	}
	return &Semaphore{slots: make(chan struct{}, n)}
}

// TryAcquire takes a slot if one is free.
func (s *Semaphore) TryAcquire() bool {
	select {
	case s.slots <- struct{}{}:
		return true
	default:
		return false
	}
}

// Acquire waits for a slot until ctx is done.
func (s *Semaphore) Acquire(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case s.slots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Release frees a slot. Releasing more than was acquired panics.
func (s *Semaphore) Release() {
	select {
	case <-s.slots:
	default:
		panic("dispatch: semaphore released more often than acquired")
	}
}

// Cap returns the number of slots.
func (s *Semaphore) Cap() int { return cap(s.slots) }

// InUse returns the number of slots taken.
func (s *Semaphore) InUse() int { return len(s.slots) }

// KeyedMutex serializes work per resource key (a GPU UUID, a disk, an allocation), so two lanes
// never act on the same device at once. Keys are forgotten when nobody holds or waits for them.
type KeyedMutex struct {
	mu    sync.Mutex
	locks map[string]*keyedLock
}

type keyedLock struct {
	held chan struct{}
	refs int
}

// Lock waits until key is free or ctx is done. unlock is idempotent.
func (k *KeyedMutex) Lock(ctx context.Context, key string) (unlock func(), err error) {
	k.mu.Lock()
	if k.locks == nil {
		k.locks = make(map[string]*keyedLock)
	}
	l := k.locks[key]
	if l == nil {
		l = &keyedLock{held: make(chan struct{}, 1)}
		k.locks[key] = l
	}
	l.refs++
	k.mu.Unlock()

	select {
	case l.held <- struct{}{}:
		return once(func() {
			<-l.held
			k.forget(key, l)
		}), nil
	case <-ctx.Done():
		k.forget(key, l)
		return nil, ctx.Err()
	}
}

// forget drops one reference to key's lock and the lock itself once unused.
func (k *KeyedMutex) forget(key string, l *keyedLock) {
	k.mu.Lock()
	defer k.mu.Unlock()
	l.refs--
	if l.refs == 0 {
		delete(k.locks, key)
	}
}
