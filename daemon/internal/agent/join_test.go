package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net/url"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/proto"
)

// joinService is a JoinService in Go for the join loop tests: the first request is deferred
// (pending approval), the second gets a certificate for the CSR it carries.
type joinService struct {
	t       *testing.T
	encKey  *ecdsa.PrivateKey
	signKey *ecdsa.PrivateKey
	signDER []byte
	pin     []byte
	caKey   *ecdsa.PrivateKey
	ca      *x509.Certificate
	nodeID  string
	calls   int
	csrs    [][]byte
}

func selfSigned(t *testing.T, key *ecdsa.PrivateKey, cn string, ca bool) []byte {
	t.Helper()
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: cn},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: ca, BasicConstraintsValid: ca, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func joinFixture(t *testing.T) *joinService {
	t.Helper()
	enc, _ := pki.GenerateKey()
	sign, _ := pki.GenerateKey()
	caKey, _ := pki.GenerateKey()
	ca, _ := x509.ParseCertificate(selfSigned(t, caKey, "node ca", true))
	pin, _ := pki.SPKISHA256(&sign.PublicKey)
	return &joinService{
		t: t, encKey: enc, signKey: sign, signDER: selfSigned(t, sign, "join", false), pin: pin,
		caKey: caKey, ca: ca, nodeID: "node_01k5w00000000000000000join",
	}
}

func (j *joinService) Join(_ context.Context, req *agentv1.JoinRequest) (*agentv1.JoinResponse, error) {
	j.calls++
	j.csrs = append(j.csrs, req.GetCsr())
	if _, err := pki.OpenJWE(string(req.GetSealedToken()), j.encKey, pki.SealedJoinTokenType); err != nil {
		j.t.Fatalf("the sealed token does not open: %v", err)
	}
	sum := sha256.Sum256(req.GetCsr())
	body := &agentv1.JoinResponseBody{CsrSha256: sum[:]}
	if j.calls == 1 {
		body.Deferral = &agentv1.JoinDeferral{Kind: &agentv1.JoinDeferral_Pending{Pending: &agentv1.JoinPending{RequestId: "jr_1", RetryAfterSeconds: 1}}}
	} else {
		csr, err := x509.ParseCertificateRequest(req.GetCsr())
		if err != nil {
			j.t.Fatal(err)
		}
		spiffe, _ := url.Parse("spiffe://compute.test/site/site_1/node/" + j.nodeID)
		tmpl := &x509.Certificate{
			SerialNumber: big.NewInt(7),
			Subject:      pkix.Name{OrganizationalUnit: []string{pki.RolePrefix + "node"}},
			NotBefore:    time.Now().Add(-time.Minute), NotAfter: time.Now().Add(24 * time.Hour),
			URIs:        []*url.URL{spiffe},
			KeyUsage:    x509.KeyUsageDigitalSignature,
			ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		}
		der, err := x509.CreateCertificate(rand.Reader, tmpl, j.ca, csr.PublicKey, j.caKey)
		if err != nil {
			j.t.Fatal(err)
		}
		body.NodeId = j.nodeID
		body.CertChain = [][]byte{der}
		body.TrustDomain = "compute.test"
		body.SiteId = "site_1"
		body.Role = commonv1.AgentRole_AGENT_ROLE_NODE
		body.Trust = &commonv1.TrustBundle{Version: 1}
	}
	b, _ := proto.Marshal(body)
	sig, err := pki.SignP1363(j.signKey, pki.SigningInput(pki.PurposeJoinResponse, b))
	if err != nil {
		j.t.Fatal(err)
	}
	return &agentv1.JoinResponse{Body: b, Sig: &commonv1.Signature{Kid: "join", Sig: sig, Chain: [][]byte{j.signDER}}}, nil
}
