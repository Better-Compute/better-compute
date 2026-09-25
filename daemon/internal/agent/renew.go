package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/session"
	"github.com/better-compute/better-compute/daemon/internal/transport"
)

// renewFraction is when a certificate is renewed: at 60% of its lifetime (PLAN.md §6).
const renewFraction = 0.6

// renewAt returns when the certificate should be renewed.
func renewAt(leaf *x509.Certificate) time.Time {
	life := leaf.NotAfter.Sub(leaf.NotBefore)
	return leaf.NotBefore.Add(time.Duration(float64(life) * renewFraction))
}

func (a *Agent) renewLoop(ctx context.Context) {
	failures := 0
	backoff := session.Backoff{Min: 30 * time.Second, Max: 10 * time.Minute}
	first := true
	var pushback time.Duration
	for {
		a.mu.Lock()
		state := a.state
		a.mu.Unlock()
		leaf, err := state.Leaf()
		if err != nil {
			a.log.Error("renewal: no certificate", "error", err.Error())
			return
		}
		wait := time.Until(renewAt(leaf))
		if first && a.o.RenewAfter > 0 {
			wait = a.o.RenewAfter
		}
		first = false
		if failures > 0 {
			wait = backoff.Delay(failures-1, a.rng)
			if pushback > 0 {
				// A gateway that said when to come back (6 renewals per node and hour): then.
				wait, pushback = pushback, 0
			}
		}
		if err := sleepCtx(ctx, max(wait, 0)); err != nil {
			return
		}
		if err := a.renewOnce(ctx); err != nil {
			failures++
			if d, ok := transport.Pushback(err); ok {
				pushback = d
			}
			a.log.Warn("renewal failed", "error", err.Error(), "attempt", failures,
				"expiresIn", time.Until(leaf.NotAfter).Round(time.Second).String())
			continue
		}
		failures = 0
	}
}

// renewOnce renews the certificate with a fresh key, proven by the current one. The next key is
// written before the request, and the new certificate is stored before the key is promoted, so a
// crash at any point leaves a matching key and certificate (LoadState promotes or discards).
func (a *Agent) renewOnce(ctx context.Context) error {
	a.mu.Lock()
	state := a.state
	now := a.serverNowLocked()
	a.mu.Unlock()
	current := a.currentKey()
	next, err := pki.GenerateKey()
	if err != nil {
		return err
	}
	nextPath := filepath.Join(a.o.DataDir, NextKeyFile)
	if err := pki.SavePrivateKey(nextPath, next); err != nil {
		return err
	}
	req, err := pki.RenewRequest(state.NodeID, current, next, state.Chain, now)
	if err != nil {
		return err
	}
	rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	resp, err := a.o.Renewer.Renew(rctx, req)
	if err != nil {
		return err
	}
	chain := resp.GetCertChain()
	if len(chain) == 0 {
		return errors.New("renewal: no certificate")
	}
	renewed, err := stateFromLeaf(chain)
	if err != nil {
		return fmt.Errorf("renewal: %w", err)
	}
	if renewed.NodeID != state.NodeID || renewed.SiteID != state.SiteID || renewed.TrustDomain != state.TrustDomain || renewed.Role != state.Role {
		return fmt.Errorf("renewal: the certificate is for %s/%s (%s), not %s/%s (%s)",
			renewed.SiteID, renewed.NodeID, renewed.Role, state.SiteID, state.NodeID, state.Role)
	}
	leaf, _ := renewed.Leaf()
	if pub, ok := leaf.PublicKey.(*ecdsa.PublicKey); !ok || !pub.Equal(&next.PublicKey) {
		return errors.New("renewal: the certificate does not certify the new key")
	}
	renewed.TrustVersion = state.TrustVersion
	renewed.TrustRoots = state.TrustRoots
	renewed.TrustBundle = state.TrustBundle
	renewed.ServerTime = state.ServerTime
	if err := SaveState(a.o.DataDir, renewed); err != nil {
		return err
	}
	if err := os.Rename(nextPath, filepath.Join(a.o.DataDir, KeyFile)); err != nil {
		return err
	}
	a.mu.Lock()
	a.state = renewed
	a.mu.Unlock()
	a.key.Store(next)
	a.log.Info("certificate renewed", "notAfter", renewed.NotAfter.Format(time.RFC3339))
	if a.o.OnRenewed != nil {
		a.o.OnRenewed(renewed, next)
	}
	return nil
}
