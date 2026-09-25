package bcx

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	driverv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1"
)

// Supervised is a plugin kept running (PLAN.md §5.5): when its process exits, it is started again
// (its binary hashed against its pin again, sandboxed again) with backoff from 1 s to 1 min, reset
// once a run lasted a minute. Operations during a restart fail with a retryable "unavailable".
type Supervised struct {
	Name string
	// Drivers and Version are the first start's (the Hello lists them).
	Drivers []*commonv1.DriverManifest
	Version string

	start  func(context.Context) (*Plugin, error)
	log    func(msg string, args ...any)
	cur    atomic.Pointer[Plugin]
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// Supervise starts a plugin with start and keeps it running until Close.
func Supervise(ctx context.Context, name string, start func(context.Context) (*Plugin, error), log func(msg string, args ...any)) (*Supervised, error) {
	p, err := start(ctx)
	if err != nil {
		return nil, err
	}
	if log == nil {
		log = func(string, ...any) {}
	}
	s := &Supervised{Name: name, Drivers: p.Drivers, Version: p.Version, start: start, log: log}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	s.cur.Store(p)
	s.wg.Add(1)
	go s.loop(p)
	return s, nil
}

func (s *Supervised) loop(p *Plugin) {
	defer s.wg.Done()
	delay := time.Second
	for {
		started := time.Now()
		select {
		case <-s.ctx.Done():
			return
		case <-p.Done():
		}
		s.cur.Store(nil)
		p.Close()
		if time.Since(started) >= time.Minute {
			delay = time.Second
		}
		s.log("plugin exited; restarting", "plugin", s.Name, "in", delay.String())
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-time.After(delay):
			}
			delay = min(delay*2, time.Minute)
			next, err := s.start(s.ctx)
			if err != nil {
				s.log("plugin did not restart", "plugin", s.Name, "error", err.Error())
				continue
			}
			if s.ctx.Err() != nil {
				next.Close()
				return
			}
			if !sameDrivers(s.Drivers, next.Drivers) {
				s.log("plugin restarted with other drivers; the node keeps advertising the first ones until bcd restarts", "plugin", s.Name)
			}
			s.log("plugin restarted", "plugin", s.Name, "version", next.Version)
			s.cur.Store(next)
			p = next
			break
		}
	}
}

func sameDrivers(a, b []*commonv1.DriverManifest) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].GetId() != b[i].GetId() || a[i].GetVersion() != b[i].GetVersion() {
			return false
		}
	}
	return true
}

var errRestarting = &Error{Code: "unavailable", Message: "the plugin is restarting", Retryable: true}

// Invoke runs one operation on the running plugin.
func (s *Supervised) Invoke(ctx context.Context, req *driverv1.InvokeRequest, onProgress func(*driverv1.Progress)) (string, error) {
	p := s.cur.Load()
	if p == nil {
		return "", errRestarting
	}
	return p.Invoke(ctx, req, onProgress)
}

// Health asks the running plugin whether it serves.
func (s *Supervised) Health(ctx context.Context) error {
	p := s.cur.Load()
	if p == nil {
		return errRestarting
	}
	return p.Health(ctx)
}

// Close stops supervising and stops the plugin.
func (s *Supervised) Close() {
	s.cancel()
	if p := s.cur.Swap(nil); p != nil {
		p.Close()
	}
	s.wg.Wait()
}
