package pki

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// Secrets and workload tokens reach the node sealed to a one-time key (P14): the daemon sends a
// node-signed request carrying a fresh P-256 public key, and the control plane answers with a
// compact JWE to it, so a gateway relaying the answer never holds the value. Mirrors
// @better-compute/pki secrets.ts and workload-request.ts.

// JWE typ of the answers.
const (
	SecretResponseType        = "bcsecret+jwe"
	WorkloadTokenResponseType = "bcworkload+jwe"
)

// ErrRefused wraps a refused or unusable secret or token answer.
var ErrRefused = fmt.Errorf("pki: refused")

func newRequestID(prefix string) string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return prefix + "_" + hex.EncodeToString(b[:])
}

// SecretRequestSigningInput is purpose secret-request, parts
// [request_id, ref, workflow_id, step_id, allocation_id, epk].
func SecretRequestSigningInput(r *agentv1.SecretRequest) []byte {
	return SigningInput(PurposeSecretRequest, []byte(r.GetRequestId()), []byte(r.GetRef()), []byte(r.GetWorkflowId()),
		[]byte(r.GetStepId()), []byte(r.GetAllocationId()), r.GetEpk())
}

// SecretBinding is what a secret is fetched for: the current workflow step, or an allocation.
type SecretBinding struct {
	WorkflowID   string
	StepID       string
	AllocationID string
}

// NewSecretRequest builds a node-signed SecretRequest and its one-time key.
func NewSecretRequest(nodeKey crypto.Signer, ref string, bind SecretBinding) (*agentv1.SecretRequest, *ecdsa.PrivateKey, error) {
	eph, err := GenerateKey()
	if err != nil {
		return nil, nil, err
	}
	epk, err := Point(&eph.PublicKey)
	if err != nil {
		return nil, nil, err
	}
	r := &agentv1.SecretRequest{
		Ref: ref, RequestId: newRequestID("req"), WorkflowId: bind.WorkflowID, StepId: bind.StepID,
		AllocationId: bind.AllocationID, Epk: epk,
	}
	if r.NodeSig, err = SignNodeStatement(nodeKey, SecretRequestSigningInput(r)); err != nil {
		return nil, nil, err
	}
	return r, eph, nil
}

// OpenSecretResponse returns the secret value of an answer to the request (ref, request id); a
// refusal returns ErrRefused with its code.
func OpenSecretResponse(resp *agentv1.SecretResponse, eph *ecdsa.PrivateKey, req *agentv1.SecretRequest, now time.Time) ([]byte, error) {
	if resp.GetError() != "" {
		return nil, fmt.Errorf("%w: %s", ErrRefused, resp.GetError())
	}
	opened, err := OpenJWE(resp.GetJwe(), eph, SecretResponseType)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrRefused, err)
	}
	if opened.Header["ref"] != req.GetRef() || opened.Header["rid"] != req.GetRequestId() {
		return nil, fmt.Errorf("%w: the answer is for another request", ErrRefused)
	}
	if exp, present := opened.Header["exp"]; present {
		if e, ok := exp.(float64); !ok || now.After(time.Unix(int64(e), 0)) {
			return nil, fmt.Errorf("%w: the answer has expired", ErrRefused)
		}
	}
	return opened.Plaintext, nil
}

// WorkloadTokenRequestSigningInput is purpose workload-token, parts
// [request_id, instance_id, audience, epk].
func WorkloadTokenRequestSigningInput(r *agentv1.WorkloadTokenRequest) []byte {
	return SigningInput(PurposeWorkloadToken, []byte(r.GetRequestId()), []byte(r.GetInstanceId()), []byte(r.GetAudience()), r.GetEpk())
}

// NewWorkloadTokenRequest builds a node-signed WorkloadTokenRequest and its one-time key.
func NewWorkloadTokenRequest(nodeKey crypto.Signer, instanceID, audience string) (*agentv1.WorkloadTokenRequest, *ecdsa.PrivateKey, error) {
	eph, err := GenerateKey()
	if err != nil {
		return nil, nil, err
	}
	epk, err := Point(&eph.PublicKey)
	if err != nil {
		return nil, nil, err
	}
	r := &agentv1.WorkloadTokenRequest{RequestId: newRequestID("wtr"), InstanceId: instanceID, Audience: audience, Epk: epk}
	if r.NodeSig, err = SignNodeStatement(nodeKey, WorkloadTokenRequestSigningInput(r)); err != nil {
		return nil, nil, err
	}
	return r, eph, nil
}

// OpenWorkloadTokenResponse returns the workload JWT of an answer to the request; it must name the
// request and instance and be unexpired.
func OpenWorkloadTokenResponse(resp *agentv1.WorkloadTokenResponse, eph *ecdsa.PrivateKey, req *agentv1.WorkloadTokenRequest, now time.Time) (string, error) {
	if resp.GetError() != "" {
		return "", fmt.Errorf("%w: %s", ErrRefused, resp.GetError())
	}
	opened, err := OpenJWE(resp.GetJwe(), eph, WorkloadTokenResponseType)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrRefused, err)
	}
	if opened.Header["rid"] != req.GetRequestId() || opened.Header["iid"] != req.GetInstanceId() {
		return "", fmt.Errorf("%w: the answer is for another request", ErrRefused)
	}
	exp, ok := opened.Header["exp"].(float64)
	if !ok || now.After(time.Unix(int64(exp), 0)) {
		return "", fmt.Errorf("%w: the answer has expired", ErrRefused)
	}
	return string(opened.Plaintext), nil
}
