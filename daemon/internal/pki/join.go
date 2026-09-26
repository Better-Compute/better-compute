package pki

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// SealedJoinTokenType is the typ of a sealed join token: nothing else sealed to the JoinService key
// opens as one.
const SealedJoinTokenType = "bcjt+jwe"

var joinTokenPattern = regexp.MustCompile(`^bcjt_([a-z][a-z0-9]{0,15}_[0-9a-hjkmnp-tv-z]{26,52})\.([A-Za-z0-9_-]{43})$`)

// ParseJoinToken reports whether s is a join token (bcjt_<id>.<secret>) and returns its id.
func ParseJoinToken(s string) (id string, ok bool) {
	m := joinTokenPattern.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return "", false
	}
	return m[1], true
}

// CreateCSR returns a DER PKCS#10 request for key with an empty subject: the node's identity comes
// from the certificate the JoinService issues, never from the request.
func CreateCSR(key crypto.Signer) ([]byte, error) {
	return x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, key)
}

// SealJoinToken seals token to the JoinService encryption key as JoinRequest.sealed_token: the
// protected header binds the CSR's SHA-256 and the issue time, so the blob is useless with any
// other CSR.
func SealJoinToken(token string, encryptionKey *ecdsa.PublicKey, csr []byte, now time.Time) ([]byte, error) {
	token = strings.TrimSpace(token)
	if _, ok := ParseJoinToken(token); !ok {
		return nil, errors.New("pki: not a join token (bcjt_<id>.<secret>)")
	}
	sum := sha256.Sum256(csr)
	sealed, err := SealJWE([]byte(token), encryptionKey, map[string]any{
		"typ": SealedJoinTokenType,
		"csr": base64.RawURLEncoding.EncodeToString(sum[:]),
		"iat": now.Unix(),
	})
	if err != nil {
		return nil, err
	}
	return []byte(sealed), nil
}

// JoinOutcome is what a verified JoinResponse says: a certificate, or a signed, CSR-bound deferral.
type JoinOutcome struct {
	// Body is set when the node joined.
	Body *agentv1.JoinResponseBody
	// Pending is set for an operator approval (retry with the same CSR after RetryAfter).
	Pending    bool
	RequestID  string
	RetryAfter time.Duration
	// Challenge is set when an attestor asks a question (answered in JoinRequest.attestation).
	Challenge *agentv1.JoinChallenge
}

// VerifyJoinOptions are the daemon's pins for a JoinResponse.
type VerifyJoinOptions struct {
	// SignerPin is config.toml join_signing_key_pin (the SHA-256 of the signing key's SPKI).
	SignerPin []byte
	// CSR is the request's CSR; the response must answer it and certify its key.
	CSR []byte
	// NodeCARoots, when known, must certify the leaf at Now.
	NodeCARoots [][]byte
	Now         time.Time
}

// ErrJoinRejected wraps every reason a JoinResponse is refused.
var ErrJoinRejected = errors.New("pki: join response rejected")

func rejected(reason string) error { return fmt.Errorf("%w: %s", ErrJoinRejected, reason) }

// OpenJoinResponse checks a JoinResponse as openJoinResponse in pki does: the signature under the
// pinned key and the CSR binding first, then either the certificate checks (leaf key = CSR key, one
// SPIFFE URI SAN equal to node id, trust domain and site, the role extension equal to the body's
// role) or the deferral, which carries no identity.
func OpenJoinResponse(resp *agentv1.JoinResponse, opts VerifyJoinOptions) (JoinOutcome, error) {
	if !VerifySignature(PurposeJoinResponse, [][]byte{resp.GetBody()}, resp.GetSig(), Trust{Pin: opts.SignerPin}) {
		return JoinOutcome{}, rejected("bad signature")
	}
	body := &agentv1.JoinResponseBody{}
	if err := proto.Unmarshal(resp.GetBody(), body); err != nil {
		return JoinOutcome{}, rejected("unreadable body")
	}
	csr, err := x509.ParseCertificateRequest(opts.CSR)
	if err != nil {
		return JoinOutcome{}, fmt.Errorf("pki: own CSR: %w", err)
	}
	sum := sha256.Sum256(opts.CSR)
	if !bytes.Equal(body.GetCsrSha256(), sum[:]) {
		return JoinOutcome{}, rejected("response is for another CSR")
	}
	if d := body.GetDeferral(); d != nil && d.GetKind() != nil {
		if body.GetNodeId() != "" || len(body.GetCertChain()) > 0 {
			return JoinOutcome{}, rejected("a deferral carries no identity")
		}
		if p := d.GetPending(); p != nil {
			retry := time.Duration(p.GetRetryAfterSeconds()) * time.Second
			if retry == 0 {
				retry = 30 * time.Second
			}
			return JoinOutcome{Pending: true, RequestID: p.GetRequestId(), RetryAfter: retry}, nil
		}
		return JoinOutcome{Challenge: d.GetChallenge()}, nil
	}
	if len(body.GetCertChain()) == 0 {
		return JoinOutcome{}, rejected("empty certificate chain")
	}
	leaf, err := x509.ParseCertificate(body.GetCertChain()[0])
	if err != nil {
		return JoinOutcome{}, rejected("unreadable certificate")
	}
	csrKey, ok1 := csr.PublicKey.(*ecdsa.PublicKey)
	leafKey, ok2 := leaf.PublicKey.(*ecdsa.PublicKey)
	if !ok1 || !ok2 || !csrKey.Equal(leafKey) {
		return JoinOutcome{}, rejected("certificate is for another key")
	}
	id, err := NodeIdentity(leaf)
	if err != nil {
		return JoinOutcome{}, rejected(err.Error())
	}
	if id.NodeID != body.GetNodeId() || id.TrustDomain != body.GetTrustDomain() || id.SiteID != body.GetSiteId() {
		return JoinOutcome{}, rejected("certificate identity does not match the response")
	}
	role := id.Role
	if role == "node-tenant" {
		role = "node"
	}
	if role != wireRoleName(body.GetRole()) {
		return JoinOutcome{}, rejected("certificate role mismatch")
	}
	if len(opts.NodeCARoots) > 0 {
		if err := VerifyChain(body.GetCertChain(), opts.NodeCARoots, opts.Now); err != nil {
			return JoinOutcome{}, rejected(err.Error())
		}
	}
	return JoinOutcome{Body: body}, nil
}

func wireRoleName(role commonv1.AgentRole) string {
	switch role {
	case commonv1.AgentRole_AGENT_ROLE_NODE:
		return "node"
	case commonv1.AgentRole_AGENT_ROLE_SITE:
		return "site"
	case commonv1.AgentRole_AGENT_ROLE_RAMDISK:
		return "ramdisk"
	}
	return ""
}

// Identity is what an agent certificate says about its holder.
type Identity struct {
	TrustDomain string
	SiteID      string
	NodeID      string
	// Role is the role extension: node, site, ramdisk or node-tenant.
	Role string
}

var segmentPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
var trustDomainPattern = regexp.MustCompile(`^[a-z0-9._-]{1,255}$`)

// NodeIdentity reads the single SPIFFE URI SAN spiffe://<td>/site/<site>/node/<node> and the role
// extension of an agent certificate.
func NodeIdentity(cert *x509.Certificate) (Identity, error) {
	if len(cert.URIs) != 1 {
		return Identity{}, errors.New("certificate has no single URI SAN")
	}
	u := cert.URIs[0]
	if u.Scheme != "spiffe" || !trustDomainPattern.MatchString(u.Host) || u.RawQuery != "" || u.Fragment != "" {
		return Identity{}, errors.New("not a SPIFFE ID")
	}
	segments := strings.Split(strings.TrimPrefix(u.EscapedPath(), "/"), "/")
	if len(segments) != 4 || segments[0] != "site" || segments[2] != "node" {
		return Identity{}, errors.New("not a node SPIFFE ID")
	}
	for _, s := range segments {
		if !segmentPattern.MatchString(s) || s == "." || s == ".." {
			return Identity{}, errors.New("invalid SPIFFE path segment")
		}
	}
	id := Identity{TrustDomain: u.Host, SiteID: segments[1], NodeID: segments[3]}
	id.Role = CertificateRole(cert)
	if id.Role == "" {
		return Identity{}, errors.New("certificate has no agent role")
	}
	return id, nil
}

// RolePrefix starts the Subject organizationalUnitName that carries a certificate's role
// ("bc-role:node"). Any X.509 library reads it; the earlier role extension under the 128-bit
// 2.25.<uuid> arc is unparseable by Go's encoding/asn1 and is not accepted.
const RolePrefix = "bc-role:"

// CertificateRole returns the role in cert's Subject OU ("node", "site", "ramdisk", "node-tenant",
// "gateway", "internal", "worker"), or "" when it has none or more than one.
func CertificateRole(cert *x509.Certificate) string {
	role := ""
	for _, ou := range cert.Subject.OrganizationalUnit {
		value, ok := strings.CutPrefix(ou, RolePrefix)
		if !ok {
			continue
		}
		if role != "" {
			return ""
		}
		role = value
	}
	return role
}

// VerifyChain checks that chain (leaf first) chains to one of roots at now, for client auth.
func VerifyChain(chain [][]byte, roots [][]byte, now time.Time) error {
	if len(chain) == 0 {
		return errors.New("empty chain")
	}
	leaf, err := x509.ParseCertificate(chain[0])
	if err != nil {
		return errors.New("unreadable leaf")
	}
	pool := x509.NewCertPool()
	for _, r := range roots {
		c, err := x509.ParseCertificate(r)
		if err != nil {
			return errors.New("unreadable root")
		}
		pool.AddCert(c)
	}
	inter := x509.NewCertPool()
	for _, der := range chain[1:] {
		c, err := x509.ParseCertificate(der)
		if err != nil {
			return errors.New("unreadable intermediate")
		}
		inter.AddCert(c)
	}
	_, err = leaf.Verify(x509.VerifyOptions{
		Roots:         pool,
		Intermediates: inter,
		CurrentTime:   now,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	})
	if err != nil {
		return fmt.Errorf("chain: %w", err)
	}
	return nil
}

// RenewRequest builds a RenewRequest: a CSR for next (the current key, or a new one to rotate),
// signed as proof of possession by current over renew-pop [sha256(csr), node_id, client_time].
func RenewRequest(nodeID string, current, next crypto.Signer, chain [][]byte, now time.Time) (*agentv1.RenewRequest, error) {
	csr, err := CreateCSR(next)
	if err != nil {
		return nil, err
	}
	clientTime := timestamppb.New(now)
	sum := sha256.Sum256(csr)
	sig, err := SignP1363(current, SigningInput(PurposeRenewPop, sum[:], []byte(nodeID), timestampBytes(clientTime)))
	if err != nil {
		return nil, err
	}
	return &agentv1.RenewRequest{Csr: csr, Chain: chain, ClientTime: clientTime, PopSig: sig}, nil
}

// timestampBytes is int64_be(seconds) ‖ int32_be(nanos), the signing-input form of a Timestamp.
func timestampBytes(ts *timestamppb.Timestamp) []byte {
	out := make([]byte, 12)
	binary.BigEndian.PutUint64(out[:8], uint64(ts.GetSeconds()))
	binary.BigEndian.PutUint32(out[8:], uint32(ts.GetNanos()))
	return out
}
