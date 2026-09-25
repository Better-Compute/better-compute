package agent

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// Post-restore identity rebind (review 13 H2; runtime/rebind.go). An instance whose spec carries
// identity_rebind_ref (a memory restore) gets that bundle installed in its guest once it runs:
//   - bcd fetches the bundle with SecretRequest{allocation_id}, like user data, and hands it to the
//     runtime, which hot-adds the identity disk and waits for the guest's acknowledgement;
//   - the ref applied is kept in <data_dir>/instances-rebound.json and reported as
//     InstanceStatus.identity_rebound_ref; the control plane re-points the exec principal on it;
//   - it runs outside the converge pass (the guest may take a while), at most rebindAttempts times a
//     ref, rebindRetryAfter apart; a guest that never acknowledges (no bc-rebind unit) keeps the
//     restore refused for exec, which fails closed.
const (
	rebindAttempts   = 3
	rebindRetryAfter = 5 * time.Minute
	reboundFile      = "instances-rebound.json"
)

type rebindTry struct {
	ref string
	n   int
	at  time.Time
}

type rebinds struct {
	mu      sync.Mutex
	loaded  bool
	done    map[string]string // instance → the ref its guest applied
	running map[string]bool
	tries   map[string]rebindTry
}

func (r *rebinds) loadLocked(dataDir string) {
	if r.loaded {
		return
	}
	r.loaded, r.done, r.running, r.tries = true, map[string]string{}, map[string]bool{}, map[string]rebindTry{}
	if raw, err := os.ReadFile(filepath.Join(dataDir, reboundFile)); err == nil {
		_ = json.Unmarshal(raw, &r.done)
	}
}

func (r *rebinds) saveLocked(dataDir string) error {
	raw, _ := json.Marshal(r.done)
	file := filepath.Join(dataDir, reboundFile)
	if err := os.WriteFile(file+".tmp", raw, 0o600); err != nil {
		return err
	}
	return os.Rename(file+".tmp", file)
}

// reboundRef is the rebind ref instance id's guest applied ("" for none).
func (a *Agent) reboundRef(id string) string {
	a.rebind.mu.Lock()
	defer a.rebind.mu.Unlock()
	a.rebind.loadLocked(a.o.DataDir)
	return a.rebind.done[id]
}

// pruneRebinds forgets instances no spec names.
func (a *Agent) pruneRebinds(specs []*agentv1.InstanceSpec) {
	a.rebind.mu.Lock()
	defer a.rebind.mu.Unlock()
	a.rebind.loadLocked(a.o.DataDir)
	named := map[string]bool{}
	for _, s := range specs {
		if s.GetDesiredState() != agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_DELETED {
			named[s.GetInstanceId()] = true
		}
	}
	changed := false
	for id := range a.rebind.done {
		if !named[id] {
			delete(a.rebind.done, id)
			changed = true
		}
	}
	if changed {
		_ = a.rebind.saveLocked(a.o.DataDir)
	}
}

// maybeRebind starts the rebind of a running instance whose guest has not applied its spec's ref.
func (a *Agent) maybeRebind(r runtime.Runtime, spec *agentv1.InstanceSpec) {
	id, ref := spec.GetInstanceId(), spec.GetIdentityRebindRef()
	rb, ok := r.(runtime.Rebinder)
	if !ok || ref == "" {
		return
	}
	a.rebind.mu.Lock()
	a.rebind.loadLocked(a.o.DataDir)
	t := a.rebind.tries[id]
	if t.ref != ref {
		t = rebindTry{ref: ref}
	}
	if a.rebind.done[id] == ref || a.rebind.running[id] || t.n >= rebindAttempts || (t.n > 0 && time.Since(t.at) < rebindRetryAfter) {
		a.rebind.mu.Unlock()
		return
	}
	a.rebind.running[id] = true
	a.rebind.mu.Unlock()
	go func() {
		err := a.rebindInstance(rb, spec)
		a.rebind.mu.Lock()
		delete(a.rebind.running, id)
		if err == nil {
			a.rebind.done[id] = ref
			err = a.rebind.saveLocked(a.o.DataDir)
		} else {
			t.n, t.at = t.n+1, time.Now()
			if errors.Is(err, pki.ErrRefused) || errors.Is(err, errBadBundle) {
				t.n = rebindAttempts // nothing to retry
			}
			a.rebind.tries[id] = t
		}
		a.rebind.mu.Unlock()
		if err != nil {
			a.log.Warn("identity rebind failed", "instance", id, "attempt", t.n, "error", err.Error())
			if t.n < rebindAttempts {
				time.AfterFunc(rebindRetryAfter, a.triggerConverge)
			}
			return
		}
		a.log.Info("identity rebound", "instance", id)
		a.triggerConverge() // the next status reports it
	}()
}

var errBadBundle = errors.New("the rebind bundle is malformed")

func (a *Agent) rebindInstance(rb runtime.Rebinder, spec *agentv1.InstanceSpec) error {
	raw, err := a.RequestSecret(a.ctx, spec.GetIdentityRebindRef(), pki.SecretBinding{AllocationID: spec.GetAllocationId()})
	if err != nil {
		return err
	}
	bundle, err := runtime.ParseRebind(raw)
	for i := range raw {
		raw[i] = 0
	}
	if err != nil {
		return errors.Join(errBadBundle, err)
	}
	return rb.Rebind(a.ctx, spec.GetInstanceId(), bundle)
}
