package agent

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/url"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/tpm"
	"github.com/better-compute/better-compute/daemon/internal/tpm/tpmsim"
	"github.com/better-compute/better-compute/daemon/internal/transport"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
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
	// statements are the urn:bc: URI SANs its certificates carry after the SPIFFE ID (a TPM AK).
	statements []*url.URL
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

// herdGateway refuses the first join the way a gateway sheds a herd: RESOURCE_EXHAUSTED with the
// wait it wants (grpc-retry-pushback-ms).
type herdGateway struct {
	*joinService
	refused bool
}

func (h *herdGateway) Join(ctx context.Context, req *agentv1.JoinRequest) (*agentv1.JoinResponse, error) {
	if !h.refused {
		h.refused = true
		e := connect.NewError(connect.CodeResourceExhausted, errors.New("handshake bucket empty"))
		e.Meta().Set(transport.PushbackHeader, "4321")
		return nil, e
	}
	return h.joinService.Join(ctx, req)
}

func TestJoinWaitsExactlyThePushback(t *testing.T) {
	f := joinFixture(t)
	var slept []time.Duration
	_, err := Join(context.Background(), JoinOptions{
		Client:        &herdGateway{joinService: f},
		Token:         "bcjt_join_01k5w0000000000000000000000." + strings.Repeat("A", 43),
		EncryptionKey: &f.encKey.PublicKey,
		SignerPin:     f.pin,
		DataDir:       t.TempDir(),
		Sleep: func(_ context.Context, d time.Duration) error {
			slept = append(slept, d)
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(slept) == 0 || slept[0] != 4321*time.Millisecond {
		t.Fatalf("slept %v; want the gateway's 4.321s first", slept)
	}
}

func (j *joinService) Join(_ context.Context, req *agentv1.JoinRequest) (*agentv1.JoinResponse, error) {
	j.calls++
	j.csrs = append(j.csrs, req.GetCsr())
	if _, err := pki.OpenJWE(string(req.GetSealedToken()), j.encKey, pki.SealedJoinTokenType); err != nil && len(req.GetSealedToken()) > 0 {
		j.t.Fatalf("the sealed token does not open: %v", err)
	}
	sum := sha256.Sum256(req.GetCsr())
	body := &agentv1.JoinResponseBody{CsrSha256: sum[:]}
	if j.calls == 1 {
		body.Deferral = &agentv1.JoinDeferral{Kind: &agentv1.JoinDeferral_Pending{Pending: &agentv1.JoinPending{RequestId: "jr_1", RetryAfterSeconds: 1}}}
	} else {
		body.NodeId = j.nodeID
		body.CertChain = [][]byte{j.leaf(req.GetCsr())}
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

// leaf is the node certificate the fixture's CA issues for a CSR's key (after checking its signature).
func (j *joinService) leaf(csrDER []byte) []byte {
	csr, err := x509.ParseCertificateRequest(csrDER)
	if err != nil || csr.CheckSignature() != nil {
		j.t.Fatalf("CSR: %v", err)
	}
	spiffe, _ := url.Parse("spiffe://compute.test/site/site_1/node/" + j.nodeID)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(7),
		Subject:      pkix.Name{OrganizationalUnit: []string{pki.RolePrefix + "node"}},
		NotBefore:    time.Now().Add(-time.Minute), NotAfter: time.Now().Add(24 * time.Hour),
		URIs:        append([]*url.URL{spiffe}, j.statements...),
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, j.ca, csr.PublicKey, j.caKey)
	if err != nil {
		j.t.Fatal(err)
	}
	return der
}

// tpmGateway is JoinService with the tpm attestor: round 1 gets a credential challenge for the AK
// the evidence names; round 2 must carry the activated secret, and is then issued a certificate.
type tpmGateway struct {
	*joinService
	secret []byte
	rounds int
	// tokens counts the rounds that carried a sealed join token.
	tokens int
}

func (g *tpmGateway) Join(ctx context.Context, req *agentv1.JoinRequest) (*agentv1.JoinResponse, error) {
	g.rounds++
	g.csrs = append(g.csrs, req.GetCsr())
	if req.GetAttestor() != "tpm" {
		g.t.Fatalf("round %d: attestor %q", g.rounds, req.GetAttestor())
	}
	if len(req.GetSealedToken()) != 0 {
		g.tokens++
	}
	var e struct {
		EK, AK string
		Answer *struct{ Secret string }
	}
	if err := json.Unmarshal(req.GetAttestation(), &e); err != nil {
		g.t.Fatal(err)
	}
	b64 := base64.RawURLEncoding
	if e.Answer == nil {
		ek, _ := b64.DecodeString(e.EK)
		ak, _ := b64.DecodeString(e.AK)
		name, _ := tpm.Name(ak)
		blob, enc, err := tpmsim.MakeCredential(ek, name, g.secret)
		if err != nil {
			g.t.Fatal(err)
		}
		payload, _ := json.Marshal(map[string]any{"credentialBlob": b64.EncodeToString(blob), "encryptedSecret": b64.EncodeToString(enc),
			"state": "s", "pcrSelection": []tpm.Selection{{Hash: tpm.AlgSHA256, PCRs: []int{0, 1, 2, 3, 4, 5, 6, 7}}}})
		sum := sha256.Sum256(req.GetCsr())
		body := &agentv1.JoinResponseBody{CsrSha256: sum[:], Deferral: &agentv1.JoinDeferral{Kind: &agentv1.JoinDeferral_Challenge{Challenge: &agentv1.JoinChallenge{
			Attestor: "tpm", Payload: payload, NotAfter: timestamppb.New(time.Now().Add(5 * time.Minute))}}}}
		raw, _ := proto.Marshal(body)
		sig, _ := pki.SignP1363(g.signKey, pki.SigningInput(pki.PurposeJoinResponse, raw))
		return &agentv1.JoinResponse{Body: raw, Sig: &commonv1.Signature{Kid: "join", Sig: sig, Chain: [][]byte{g.signDER}}}, nil
	}
	if got, _ := b64.DecodeString(e.Answer.Secret); !bytes.Equal(got, g.secret) {
		g.t.Fatal("round 2 does not carry the activated credential")
	}
	g.joinService.calls = 1 // issue now
	return g.joinService.Join(ctx, req)
}

// Record keeps the signed response that issued the identity (root's join record under bcd helper),
// before the identity: a failed record fails the join and leaves no identity behind.
func TestJoinRecordsTheSignedResponse(t *testing.T) {
	join := func(f *joinService, dir string, record func(*agentv1.JoinResponse) error) error {
		_, err := Join(context.Background(), JoinOptions{
			Client: f, Token: "bcjt_join_01k5w0000000000000000000000." + strings.Repeat("A", 43),
			EncryptionKey: &f.encKey.PublicKey, SignerPin: f.pin, DataDir: dir, Record: record,
			Sleep: func(context.Context, time.Duration) error { return nil },
		})
		return err
	}
	f := joinFixture(t)
	var kept []*agentv1.JoinResponse
	if err := join(f, t.TempDir(), func(r *agentv1.JoinResponse) error { kept = append(kept, r); return nil }); err != nil {
		t.Fatal(err)
	}
	body := &agentv1.JoinResponseBody{}
	if len(kept) != 1 || proto.Unmarshal(kept[0].GetBody(), body) != nil || body.GetNodeId() != f.nodeID ||
		!pki.VerifySignature(pki.PurposeJoinResponse, [][]byte{kept[0].GetBody()}, kept[0].GetSig(), pki.Trust{Pin: f.pin}) {
		t.Fatalf("kept %v", kept)
	}
	dir := t.TempDir()
	if err := join(joinFixture(t), dir, func(*agentv1.JoinResponse) error { return errors.New("disk full") }); err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Fatalf("a failed record: %v", err)
	}
	if _, _, err := LoadState(dir); !errors.Is(err, ErrNotJoined) {
		t.Fatalf("an identity was kept without its record: %v", err)
	}
}

// A tpm join (v0.5): no token; the TPM's evidence, the challenge answered with the same CSR.
func TestJoinWithTPM(t *testing.T) {
	sim, err := tpmsim.New()
	if err != nil {
		t.Fatal(err)
	}
	a, err := tpm.NewAttestor(sim)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	f := joinFixture(t)
	g := &tpmGateway{joinService: f, secret: bytes.Repeat([]byte{9}, 32)}
	state, err := Join(context.Background(), JoinOptions{
		Client: g, Attestor: "tpm", Attest: a, EncryptionKey: &f.encKey.PublicKey, SignerPin: f.pin, DataDir: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if state.NodeID != f.nodeID || g.rounds != 2 || g.tokens != 0 || !bytes.Equal(g.csrs[0], g.csrs[1]) {
		t.Fatalf("state %v after %d rounds (%d with a token)", state, g.rounds, g.tokens)
	}
	// Without an attestor that answers challenges, a challenge ends the join.
	g2 := &tpmGateway{joinService: joinFixture(t), secret: g.secret}
	ev, _ := a.Evidence()
	_, err = Join(context.Background(), JoinOptions{
		Client: g2, Attestor: "tpm", Attestation: ev, Token: "bcjt_join_01k5w0000000000000000000000." + strings.Repeat("A", 43),
		EncryptionKey: &g2.encKey.PublicKey, SignerPin: g2.pin, DataDir: t.TempDir(),
	})
	if !errors.Is(err, ErrChallenge) {
		t.Fatalf("an unanswerable challenge = %v", err)
	}
}
