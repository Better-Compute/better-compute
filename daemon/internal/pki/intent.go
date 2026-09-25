package pki

import (
	"crypto/ecdsa"
	"crypto/x509"
	"errors"
	"fmt"
	"time"

	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"google.golang.org/protobuf/proto"
)

// Signed intent (PLAN.md §7.7, §13, P14): Command and DesiredState bodies are signed by short-lived
// worker keys whose certificates chain to a command-signing root of the daemon's TrustBundle and
// carry Subject OU "bc-role:worker". A gateway relays intent but cannot forge or alter it. The
// daemon's own kind table (never the body) decides when a signature is required; a signature that is
// present is always checked. Mirrors @better-compute/pki intent.ts.

// ErrIntentRejected wraps every reason signed intent is refused (the daemon answers BAD_SIGNATURE,
// or ignores the spec).
var ErrIntentRejected = errors.New("pki: signed intent rejected")

func denyIntent(reason string) error { return fmt.Errorf("%w: %s", ErrIntentRejected, reason) }

// RoleWorker is the certificate role of a command-signing worker key.
const RoleWorker = "worker"

// VerifyIntent checks a worker signature over body for purpose (PurposeCommand or
// PurposeDesiredState): a 64-byte r‖s signature by the leaf of sig.chain, which chains to one of
// roots at now and has role worker.
func VerifyIntent(purpose string, body []byte, sig *commonv1.Signature, roots [][]byte, now time.Time) error {
	if sig == nil {
		return denyIntent("unsigned")
	}
	if len(sig.GetSig()) != 64 || len(sig.GetChain()) == 0 {
		return denyIntent("malformed signature")
	}
	if len(roots) == 0 {
		return denyIntent("no command-signing roots")
	}
	certs := make([]*x509.Certificate, 0, len(sig.GetChain()))
	for _, der := range sig.GetChain() {
		c, err := x509.ParseCertificate(der)
		if err != nil {
			return denyIntent("unreadable signer certificate")
		}
		certs = append(certs, c)
	}
	pool := x509.NewCertPool()
	for _, der := range roots {
		c, err := x509.ParseCertificate(der)
		if err != nil {
			return denyIntent("unreadable command-signing root")
		}
		pool.AddCert(c)
	}
	inter := x509.NewCertPool()
	for _, c := range certs[1:] {
		inter.AddCert(c)
	}
	leaf := certs[0]
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:         pool,
		Intermediates: inter,
		CurrentTime:   now,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
	}); err != nil {
		return denyIntent("untrusted signer")
	}
	// Under the command-signing roots, a signer is a worker (OU=bc-role:worker).
	if CertificateRole(leaf) != RoleWorker {
		return denyIntent("not a command-signing key")
	}
	pub, ok := leaf.PublicKey.(*ecdsa.PublicKey)
	if !ok || !VerifyP1363(pub, SigningInput(purpose, body), sig.GetSig()) {
		return denyIntent("bad signature")
	}
	return nil
}

// OpenTrustBundle verifies a SignedTrustBundle from Welcome: signed (purpose trust-bundle) by the
// pinned JoinService signing key and newer than heldVersion.
func OpenTrustBundle(signed *commonv1.SignedTrustBundle, signerPin []byte, heldVersion uint64) (*commonv1.TrustBundle, error) {
	if signed == nil {
		return nil, denyIntent("no trust bundle")
	}
	if !VerifySignature(PurposeTrustBundle, [][]byte{signed.GetBody()}, signed.GetSignature(), Trust{Pin: signerPin}) {
		return nil, denyIntent("trust bundle: bad signature")
	}
	bundle := &commonv1.TrustBundle{}
	if err := proto.Unmarshal(signed.GetBody(), bundle); err != nil {
		return nil, denyIntent("trust bundle: unreadable body")
	}
	if bundle.GetVersion() <= heldVersion {
		return nil, denyIntent("trust bundle: not newer")
	}
	return bundle, nil
}
