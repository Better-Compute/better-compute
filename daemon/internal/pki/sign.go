// Package pki is bcd's side of better-compute's PKI (PLAN.md §3.3, §6, §13), byte-compatible with
// @better-compute/pki: P-256 node keys, the purpose-framed ES256 signatures of every signed message
// (signing inputs pinned by packages/protocol/golden/signing.json), the compact JWE that seals join
// tokens and carries secrets, CSRs, JoinResponse verification and Renew proofs of possession.
package pki

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/binary"
	"errors"
	"math/big"

	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
)

// Signing purposes (packages/protocol/src/signing.ts). The purpose is part of the signed bytes, so
// a signature never verifies for another purpose.
const (
	PurposeCommand            = "command"
	PurposeDesiredState       = "desired-state"
	PurposeJoinResponse       = "join-response"
	PurposeTrustBundle        = "trust-bundle"
	PurposeAttestedReport     = "attested-report"
	PurposeCommandUpdate      = "command-update"
	PurposeSecretRequest      = "secret-request"
	PurposeRenewPop           = "renew-pop"
	PurposeDiscoveryAssertion = "discovery-assertion"
	PurposeX509Pop            = "x509pop"
	PurposeWorkloadToken      = "workload-token"
	PurposeBatchApproval      = "batch-approval"
	PurposeApproverSet        = "approver-set"
)

const signingPrefix = "bettercompute.v1/"

// SigningInput returns the exact bytes an ES256 signature covers:
// "bettercompute.v1/" ‖ purpose ‖ 0x00 ‖ (uint32_be(len) ‖ part)*.
func SigningInput(purpose string, parts ...[]byte) []byte {
	n := len(signingPrefix) + len(purpose) + 1
	for _, p := range parts {
		n += 4 + len(p)
	}
	out := make([]byte, 0, n)
	out = append(out, signingPrefix...)
	out = append(out, purpose...)
	out = append(out, 0)
	for _, p := range parts {
		out = binary.BigEndian.AppendUint32(out, uint32(len(p)))
		out = append(out, p...)
	}
	return out
}

// SignP1363 signs SHA-256(input) with a P-256 key and returns the raw 64-byte r ‖ s form (IEEE
// P1363 / JWS). The key is a file key (*ecdsa.PrivateKey) or any P-256 crypto.Signer (a node key in
// the TPM): the signature is the same either way.
func SignP1363(key crypto.Signer, input []byte) ([]byte, error) {
	digest := sha256.Sum256(input)
	var r, s *big.Int
	if k, ok := key.(*ecdsa.PrivateKey); ok {
		var err error
		if r, s, err = ecdsa.Sign(rand.Reader, k, digest[:]); err != nil {
			return nil, err
		}
	} else {
		der, err := key.Sign(rand.Reader, digest[:], crypto.SHA256)
		if err != nil {
			return nil, err
		}
		var sig struct{ R, S *big.Int }
		if rest, err := asn1.Unmarshal(der, &sig); err != nil || len(rest) > 0 || sig.R == nil || sig.S == nil {
			return nil, errors.New("pki: the key's signature is not ECDSA")
		}
		r, s = sig.R, sig.S
	}
	if r.BitLen() > 256 || s.BitLen() > 256 {
		return nil, errors.New("pki: not a P-256 signature")
	}
	out := make([]byte, 64)
	r.FillBytes(out[:32])
	s.FillBytes(out[32:])
	return out, nil
}

// NodePublic is a node key's public half: P-256, whatever holds the private one.
func NodePublic(key crypto.Signer) (*ecdsa.PublicKey, error) {
	pub, ok := key.Public().(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		return nil, errors.New("pki: the node key is not P-256")
	}
	return pub, nil
}

// VerifyP1363 verifies a raw r ‖ s signature over SHA-256(input). It never panics on hostile input.
func VerifyP1363(pub *ecdsa.PublicKey, input, sig []byte) bool {
	if pub == nil || len(sig) != 64 {
		return false
	}
	digest := sha256.Sum256(input)
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	return ecdsa.Verify(pub, digest[:], r, s)
}

// Trust is how a verifier knows a signer: its public key, or an SPKI pin (the SHA-256 of its
// SubjectPublicKeyInfo) that the key in Signature.chain[0] must match.
type Trust struct {
	PublicKey *ecdsa.PublicKey
	Pin       []byte
}

// VerifySignature verifies sig for purpose over parts under trust. With a pin, the key comes from
// sig.chain[0] and must match it. It returns false on any mismatch and never panics.
func VerifySignature(purpose string, parts [][]byte, sig *commonv1.Signature, trust Trust) bool {
	if sig == nil {
		return false
	}
	key := trust.PublicKey
	if key == nil {
		if len(sig.GetChain()) == 0 || len(trust.Pin) == 0 {
			return false
		}
		cert, err := x509.ParseCertificate(sig.GetChain()[0])
		if err != nil {
			return false
		}
		pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
		if !ok || !MatchesPin(pub, trust.Pin) {
			return false
		}
		key = pub
	}
	return VerifyP1363(key, SigningInput(purpose, parts...), sig.GetSig())
}

// SignNodeStatement signs framed input with a node key: the Signature a daemon attaches, with
// kid = base64url(SHA-256(SPKI)) so the verifier finds the key in node_certs.
func SignNodeStatement(key crypto.Signer, input []byte) (*commonv1.Signature, error) {
	pub, err := NodePublic(key)
	if err != nil {
		return nil, err
	}
	sig, err := SignP1363(key, input)
	if err != nil {
		return nil, err
	}
	kid, err := KeyID(pub)
	if err != nil {
		return nil, err
	}
	return &commonv1.Signature{Kid: kid, Sig: sig}, nil
}

// ErrBadSignature is returned when a signature does not verify.
var ErrBadSignature = errors.New("pki: bad signature")
