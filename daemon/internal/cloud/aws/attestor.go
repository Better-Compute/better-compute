package aws

import (
	"context"
	"errors"
)

// AttestorID is the control plane's attestor (packages/pki/src/attestors/cloud-iid.ts).
const AttestorID = "cloud-iid"

// ErrNoChallenge answers a challenge: cloud-iid has no challenge round.
var ErrNoChallenge = errors.New("aws: the cloud-iid attestor has no challenge round")

// Attestor is `bcd join --attestor cloud-iid` on EC2 (agent.ChallengeAttestor): the evidence is the
// signed instance identity document, read fresh from IMDSv2 for each join. The control plane admits
// each instance once, within 30 minutes of its first boot, and only into the pool that created or
// attached it (AD14); a later re-join of the same machine uses its certificate (x509pop).
type Attestor struct {
	Client *Client
	// Context bounds the metadata reads (default context.Background; each read has its own 1 s
	// timeout).
	Context context.Context
}

// Evidence is the JoinRequest.attestation.
func (a *Attestor) Evidence() ([]byte, error) {
	ctx := a.Context
	if ctx == nil {
		ctx = context.Background()
	}
	c := a.Client
	if c == nil {
		c = &Client{}
	}
	return c.Evidence(ctx)
}

// Answer refuses: a cloud-iid join is decided on the evidence alone.
func (a *Attestor) Answer(_, _ []byte) ([]byte, error) { return nil, ErrNoChallenge }
