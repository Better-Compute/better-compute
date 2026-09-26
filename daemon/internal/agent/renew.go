package agent

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/session"
	"github.com/better-compute/better-compute/daemon/internal/tpm"
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

// renewalCertifier opens the AK a certificate names (urn:bc:tpm-ak:), or nil when it names none. It
// fails when the TPM is unavailable or its AK is another (a cleared TPM: the node must join again).
func renewalCertifier(leaf *x509.Certificate) (tpm.KeyCertifier, error) {
	name, err := pki.TPMAKName(leaf)
	if err != nil || name == nil {
		return nil, err
	}
	keys, err := openTPM()
	if err != nil {
		return nil, fmt.Errorf("renewal: the certificate's node key is in the TPM, which is unavailable: %w", err)
	}
	c, err := keys.Certifier()
	if err != nil {
		return nil, fmt.Errorf("renewal: %w", err)
	}
	got, err := tpm.Name(c.AKPublic())
	if err != nil || !bytes.Equal(got, name) {
		c.Close()
		// The AK is an endorsement-hierarchy primary: a TPM2_Clear keeps it (and loses the node key, which
		// LoadState reports). Another AK is another TPM, or one whose endorsement seed was changed.
		return nil, errors.New("renewal: this TPM's attestation key is not the one the certificate names (another TPM, " +
			"or its endorsement seed changed): the certificate cannot be renewed here; join again: bcd join --reset --yes, then bcd join")
	}
	return c, nil
}

// certifiedKey makes the next node key in the TPM, where the AK can certify it.
func certifiedKey() (crypto.Signer, []byte, error) {
	keys, err := openTPM()
	if err != nil {
		return nil, nil, err
	}
	key, record, err := newKeyIn(keys)
	if err != nil {
		return nil, nil, fmt.Errorf("renewal: the next node key in the TPM: %w", err)
	}
	return key, record, nil
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
	currentLeaf, err := state.Leaf()
	if err != nil {
		return err
	}
	// A certificate that names the TPM's AK renews only with a next key that AK certifies; the control
	// plane refuses anything else, so a TPM that cannot is an error here, never a file key.
	certifier, err := renewalCertifier(currentLeaf)
	if err != nil {
		return err
	}
	var next crypto.Signer
	var record []byte
	if certifier != nil {
		defer certifier.Close()
		next, record, err = certifiedKey()
	} else {
		// The next key: in the TPM when the host has one (a node with a file key moves into the TPM here).
		next, record, err = newNodeKey(a.log)
	}
	if err != nil {
		return err
	}
	promoted := false
	defer func() {
		if !promoted {
			closeKey(next)
		}
	}()
	nextPath := filepath.Join(a.o.DataDir, NextKeyFile)
	if err := saveNodeKey(nextPath, record); err != nil {
		return err
	}
	req, err := pki.RenewRequest(state.NodeID, current, next, state.Chain, now)
	if err != nil {
		return err
	}
	if certifier != nil {
		digest := sha256.Sum256(req.GetCsr())
		key := next.(tpm.Key)
		info, signature, err := certifier.CertifyNodeKey(key, digest[:])
		if err != nil {
			return fmt.Errorf("renewal: the TPM's attestation key certifying the next key: %w", err)
		}
		req.KeyAttestation = &agentv1.TpmKeyAttestation{
			AkPublic:    certifier.AKPublic(),
			KeyPublic:   key.PublicArea(),
			CertifyInfo: info,
			Signature:   signature,
		}
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
	nextPub, err := pki.NodePublic(next)
	if err != nil {
		return err
	}
	if pub, ok := leaf.PublicKey.(*ecdsa.PublicKey); !ok || !pub.Equal(nextPub) {
		return errors.New("renewal: the certificate does not certify the new key")
	}
	renewed.TrustVersion = state.TrustVersion
	renewed.TrustRoots = state.TrustRoots
	renewed.TrustBundle = state.TrustBundle
	renewed.ServerTime = state.ServerTime
	// The next key must be on disk before the certificate that names it: whatever removed it during
	// the request (a LoadState elsewhere discards a node.key.next the certificate does not match), a
	// stored certificate without its key would leave the node without an identity.
	if err := saveNodeKey(nextPath, record); err != nil {
		return err
	}
	if err := SaveState(a.o.DataDir, renewed); err != nil {
		return err
	}
	if err := os.Rename(nextPath, filepath.Join(a.o.DataDir, KeyFile)); err != nil {
		return err
	}
	a.mu.Lock()
	a.state = renewed
	a.mu.Unlock()
	a.storeKey(next)
	promoted = true
	// A TPM key's handle is unloaded once nothing can still be signing with it (a handshake, a
	// statement started just before).
	time.AfterFunc(5*time.Minute, func() { closeKey(current) })
	a.log.Info("certificate renewed", "notAfter", renewed.NotAfter.Format(time.RFC3339), "key", NodeKeyKind(next))
	if a.o.OnRenewed != nil {
		a.o.OnRenewed(renewed, next)
	}
	return nil
}
