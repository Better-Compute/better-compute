package agent

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"os"
	"path/filepath"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/session"
	"github.com/better-compute/better-compute/daemon/internal/transport"
)

// Joiner sends a JoinRequest (transport.Client in production).
type Joiner interface {
	Join(ctx context.Context, req *agentv1.JoinRequest) (*agentv1.JoinResponse, error)
}

// JoinOptions configure Join.
type JoinOptions struct {
	Client Joiner
	// Token is the join token ("bcjt_<id>.<secret>"), read from BCD_JOIN_TOKEN or stdin. It is sealed
	// to EncryptionKey and never stored.
	Token string
	// EncryptionKey is the JoinService encryption key (/etc/bcd/join-encryption.jwk), already
	// checked against join_encryption_key_pin.
	EncryptionKey *ecdsa.PublicKey
	// SignerPin is join_signing_key_pin: the JoinResponse must be signed by that key.
	SignerPin []byte
	// NodeCARoots, when known, must certify the issued certificate.
	NodeCARoots [][]byte
	Role        commonv1.AgentRole
	// Attestor verifies the join ("join-token" by default; "discovery" for a PXE ramdisk, whose
	// Attestation is the site agent's SignedDiscoveryAssertion).
	Attestor    string
	Attestation []byte
	Claims      *agentv1.HardwareClaims
	Version     string
	// DataDir receives the key and the identity.
	DataDir string
	// Attempts bounds the retries of retryable failures (default 20).
	Attempts int
	Backoff  session.Backoff
	Log      *slog.Logger
	// Now and Sleep default to the real clock.
	Now   func() time.Time
	Sleep func(ctx context.Context, d time.Duration) error
}

// ErrChallenge reports a join deferral this daemon cannot answer yet (an attestor challenge, v0.5).
var ErrChallenge = errors.New("agent: the join needs an attestor challenge this daemon does not answer")

// Join enrolls the node (PLAN.md §3.3): a fresh P-256 key and CSR, the token sealed to the pinned
// JoinService key and bound to the CSR, the JoinResponse verified against the pinned signer. A
// pending deferral (operator approval) is retried with the same CSR after retry_after. On success
// the key and the identity are written to DataDir, and a journal of an earlier identity is moved
// aside (its commands belong to another node id).
func Join(ctx context.Context, o JoinOptions) (*State, error) {
	if _, ok := pki.ParseJoinToken(o.Token); !ok {
		return nil, errors.New("agent: that is not a join token (bcjt_...)")
	}
	if o.EncryptionKey == nil || len(o.SignerPin) == 0 {
		return nil, errors.New("agent: join needs the JoinService encryption key and signing pin")
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Sleep == nil {
		o.Sleep = sleepCtx
	}
	if o.Attempts <= 0 {
		o.Attempts = 20
	}
	if o.Backoff.Max == 0 {
		o.Backoff = session.DefaultBackoff
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.Attestor == "" {
		o.Attestor = "join-token"
	}
	if o.Role == commonv1.AgentRole_AGENT_ROLE_UNSPECIFIED {
		o.Role = commonv1.AgentRole_AGENT_ROLE_NODE
	}
	key, err := pki.GenerateKey()
	if err != nil {
		return nil, err
	}
	csr, err := pki.CreateCSR(key)
	if err != nil {
		return nil, err
	}
	rng := rand.New(rand.NewSource(o.Now().UnixNano()))
	failures := 0
	for {
		sealed, err := pki.SealJoinToken(o.Token, o.EncryptionKey, csr, o.Now())
		if err != nil {
			return nil, err
		}
		resp, err := o.Client.Join(ctx, &agentv1.JoinRequest{
			SealedToken:   sealed,
			Csr:           csr,
			Claims:        o.Claims,
			Attestor:      o.Attestor,
			Attestation:   o.Attestation,
			DaemonVersion: o.Version,
			Role:          o.Role,
		})
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if !transport.Retryable(err) || failures+1 >= o.Attempts {
				return nil, fmt.Errorf("agent: join: %w", err)
			}
			delay := o.Backoff.Delay(failures, rng)
			failures++
			if pushback, ok := transport.Pushback(err); ok {
				// The gateway says when (grpc-retry-pushback-ms, scaled to the herd): exactly then.
				delay = pushback
			}
			o.Log.Warn("join failed, retrying", "error", err.Error(), "in", delay.String())
			if err := o.Sleep(ctx, delay); err != nil {
				return nil, err
			}
			continue
		}
		out, err := pki.OpenJoinResponse(resp, pki.VerifyJoinOptions{
			SignerPin:   o.SignerPin,
			CSR:         csr,
			NodeCARoots: o.NodeCARoots,
			Now:         o.Now(),
		})
		if err != nil {
			return nil, err
		}
		switch {
		case out.Challenge != nil:
			return nil, fmt.Errorf("%w (%s)", ErrChallenge, out.Challenge.GetAttestor())
		case out.Pending:
			wait := out.RetryAfter
			if wait < time.Second {
				wait = time.Second
			}
			o.Log.Info("join is pending approval", "request", out.RequestID, "retryAfter", wait.String())
			if err := o.Sleep(ctx, wait); err != nil {
				return nil, err
			}
			continue
		}
		return persistJoin(o, key, out.Body)
	}
}

func persistJoin(o JoinOptions, key *ecdsa.PrivateKey, body *agentv1.JoinResponseBody) (*State, error) {
	state, err := stateFromLeaf(body.GetCertChain())
	if err != nil {
		return nil, err
	}
	if state.NodeID != body.GetNodeId() {
		return nil, fmt.Errorf("agent: the certificate names node %s, the response %s", state.NodeID, body.GetNodeId())
	}
	if t := body.GetTrust(); t != nil {
		state.TrustVersion = t.GetVersion()
		state.TrustRoots = t.GetCommandSigningRoots()
	}
	if err := os.MkdirAll(o.DataDir, 0o700); err != nil {
		return nil, err
	}
	if old, _, err := LoadState(o.DataDir); err == nil && old.NodeID != state.NodeID {
		journal := filepath.Join(o.DataDir, JournalFile)
		if _, err := os.Stat(journal); err == nil {
			aside := fmt.Sprintf("%s.%s-%d", journal, old.NodeID, o.Now().Unix())
			if err := os.Rename(journal, aside); err != nil {
				return nil, fmt.Errorf("agent: move the journal of %s aside: %w", old.NodeID, err)
			}
		}
	}
	_ = os.Remove(filepath.Join(o.DataDir, NextKeyFile))
	if err := pki.SavePrivateKey(filepath.Join(o.DataDir, KeyFile), key); err != nil {
		return nil, err
	}
	if err := SaveState(o.DataDir, state); err != nil {
		return nil, err
	}
	return state, nil
}

// JournalFile is the bbolt journal in the data directory.
const JournalFile = "journal.db"

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
