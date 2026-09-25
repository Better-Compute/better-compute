package agent

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/pki"
)

// Secrets (§6 "Secrets") and workload tokens (§12.2, v0.5) are fetched over the session: a
// node-signed request with a one-time key, answered with a JWE to it (the gateway only relays
// ciphertext). Requests wait at most requestTimeout; an answer on a later session is never matched.

// ErrUnavailable reports a request that could not be sent or answered in time.
var ErrUnavailable = errors.New("agent: unavailable")

const requestTimeout = 10 * time.Second

type pendingSecret struct {
	req *agentv1.SecretRequest
	eph *ecdsa.PrivateKey
	out chan *agentv1.SecretResponse
}

type pendingWorkload struct {
	req *agentv1.WorkloadTokenRequest
	eph *ecdsa.PrivateKey
	out chan *agentv1.WorkloadTokenResponse
}

// RequestSecret fetches one secret for current work (a workflow step or an allocation).
func (a *Agent) RequestSecret(ctx context.Context, ref string, bind pki.SecretBinding) ([]byte, error) {
	req, eph, err := pki.NewSecretRequest(a.currentKey(), ref, bind)
	if err != nil {
		return nil, err
	}
	p := &pendingSecret{req: req, eph: eph, out: make(chan *agentv1.SecretResponse, 1)}
	a.mu.Lock()
	if a.secrets == nil {
		a.secrets = map[string]*pendingSecret{}
	}
	a.secrets[req.GetRequestId()] = p
	sent := a.sendLocked(&agentv1.AgentFrame{Msg: &agentv1.AgentFrame_SecretRequest{SecretRequest: req}})
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.secrets, req.GetRequestId())
		a.mu.Unlock()
	}()
	if !sent {
		return nil, ErrUnavailable
	}
	select {
	case resp := <-p.out:
		return pki.OpenSecretResponse(resp, eph, req, a.serverNow())
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(requestTimeout):
		return nil, ErrUnavailable
	}
}

// RequestWorkloadToken asks the control plane for an instance's workload token (the host's IMDS).
func (a *Agent) RequestWorkloadToken(ctx context.Context, instanceID, audience string) (string, time.Time, error) {
	req, eph, err := pki.NewWorkloadTokenRequest(a.currentKey(), instanceID, audience)
	if err != nil {
		return "", time.Time{}, err
	}
	p := &pendingWorkload{req: req, eph: eph, out: make(chan *agentv1.WorkloadTokenResponse, 1)}
	a.mu.Lock()
	if a.workloads == nil {
		a.workloads = map[string]*pendingWorkload{}
	}
	a.workloads[req.GetRequestId()] = p
	sent := a.sendLocked(&agentv1.AgentFrame{Msg: &agentv1.AgentFrame_WorkloadTokenRequest{WorkloadTokenRequest: req}})
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.workloads, req.GetRequestId())
		a.mu.Unlock()
	}()
	if !sent {
		return "", time.Time{}, ErrUnavailable
	}
	select {
	case resp := <-p.out:
		token, err := pki.OpenWorkloadTokenResponse(resp, eph, req, a.serverNow())
		if err != nil {
			return "", time.Time{}, err
		}
		return token, resp.GetExpiresAt().AsTime(), nil
	case <-ctx.Done():
		return "", time.Time{}, ctx.Err()
	case <-time.After(requestTimeout):
		return "", time.Time{}, ErrUnavailable
	}
}

func (a *Agent) onSecretResponse(r *agentv1.SecretResponse) {
	a.mu.Lock()
	p := a.secrets[r.GetRequestId()]
	a.mu.Unlock()
	if p == nil {
		a.log.Debug("secret response for no pending request", "request", r.GetRequestId())
		return
	}
	select {
	case p.out <- r:
	default:
	}
}

func (a *Agent) onWorkloadTokenResponse(r *agentv1.WorkloadTokenResponse) {
	a.mu.Lock()
	p := a.workloads[r.GetRequestId()]
	a.mu.Unlock()
	if p == nil {
		a.log.Debug("workload token response for no pending request", "request", r.GetRequestId())
		return
	}
	select {
	case p.out <- r:
	default:
	}
}
