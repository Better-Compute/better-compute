package helper

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"math/big"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/proto"
)

// intentSigner is a command-signing root and a worker key under it, valid until notAfter.
type intentSigner struct {
	root  []byte
	sign  func(body []byte) []byte
	valid time.Time
}

func newIntentSigner(t *testing.T, role string, notAfter time.Time) intentSigner {
	t.Helper()
	rootKey, _ := pki.GenerateKey()
	now := time.Now()
	rootTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "command-signing root"},
		NotBefore: now.Add(-48 * time.Hour), NotAfter: now.Add(48 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	root, err := x509.CreateCertificate(rand.Reader, rootTmpl, rootTmpl, &rootKey.PublicKey, rootKey)
	if err != nil {
		t.Fatal(err)
	}
	rootCert, _ := x509.ParseCertificate(root)
	key, _ := pki.GenerateKey()
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "worker", OrganizationalUnit: []string{pki.RolePrefix + role}},
		NotBefore:    now.Add(-48 * time.Hour), NotAfter: notAfter,
		KeyUsage: x509.KeyUsageDigitalSignature,
	}
	leaf, err := x509.CreateCertificate(rand.Reader, leafTmpl, rootCert, &key.PublicKey, rootKey)
	if err != nil {
		t.Fatal(err)
	}
	return intentSigner{root: root, valid: notAfter, sign: func(body []byte) []byte {
		sig, err := pki.SignP1363(key, pki.SigningInput(pki.PurposeDesiredState, body))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := proto.Marshal(&commonv1.Signature{Kid: "worker", Sig: sig, Chain: [][]byte{leaf}})
		return raw
	}}
}

func signedSpec(t *testing.T, s intentSigner, nodeID string, generation uint64, spec *agentv1.DesiredStateBody) *HostIntent {
	t.Helper()
	spec.NodeId, spec.Generation = nodeID, generation
	body, err := proto.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	return &HostIntent{Body: body, Signature: s.sign(body), Roots: [][]byte{s.root}}
}

func full(units ...*agentv1.ConfigUnit) *agentv1.DesiredStateBody {
	return &agentv1.DesiredStateBody{Spec: &agentv1.DesiredStateBody_Full{Full: &agentv1.NodeSpec{Host: &agentv1.HostSection{Units: units}}}}
}

func sysctl(json string) *agentv1.ConfigUnit {
	return &agentv1.ConfigUnit{Unit: "sysctl", ConfigJson: json}
}

func TestHostUnitNeedsTheSignedSpec(t *testing.T) {
	signer := newIntentSigner(t, "worker", time.Now().Add(time.Hour))
	pin := sha256.Sum256(signer.root)
	now := time.Now()
	s := &Server{HostSystem: hostconfig.NewFakeSystem(), CommandRootPins: [][]byte{pin[:]}, Now: func() time.Time { return now }}
	ask := func(unit string, settings string, in *HostIntent) error {
		req := Request{Op: "host.unit", Unit: unit, Intent: in}
		if settings != "" {
			req.Settings = json.RawMessage(settings)
		}
		return s.checkIntent(req)
	}
	expect := func(err error, want string) {
		t.Helper()
		if want == "" && err != nil || want != "" && (err == nil || !strings.Contains(err.Error(), want)) {
			t.Fatalf("err = %v, want %q", err, want)
		}
	}
	g5 := signedSpec(t, signer, "node_a", 5, full(sysctl(`{"vm.swappiness":10}`)))

	expect(ask("sysctl", `{"vm.swappiness":10}`, nil), "needs the signed spec")
	expect(ask("sysctl", `{"vm.swappiness":10}`, g5), "")
	// Exactly the signed settings, a unit the body names, and cleaning only what it no longer names.
	expect(ask("sysctl", `{"vm.swappiness":0}`, g5), "not the signed spec's")
	expect(ask("hugepages", `{"pages2m":64}`, g5), "does not ask for hugepages")
	expect(ask("sysctl", "", g5), "still asks for sysctl")
	expect(ask("hugepages", "", g5), "")

	// A tampered body, a worker the roots do not vouch for, a root that is not pinned.
	tampered := *g5
	tampered.Body = append([]byte(nil), g5.Body...)
	tampered.Body[len(tampered.Body)-2] ^= 1
	if err := ask("sysctl", `{"vm.swappiness":10}`, &tampered); err == nil {
		t.Fatal("a tampered body was taken")
	}
	nodeKey := newIntentSigner(t, "node", time.Now().Add(time.Hour))
	pin2 := sha256.Sum256(nodeKey.root)
	s.CommandRootPins = append(s.CommandRootPins, pin2[:])
	expect(ask("sysctl", `{"vm.swappiness":10}`, signedSpec(t, nodeKey, "node_a", 6, full(sysctl(`{"vm.swappiness":10}`)))), "not a command-signing key")
	other := newIntentSigner(t, "worker", time.Now().Add(time.Hour))
	expect(ask("sysctl", `{"vm.swappiness":10}`, signedSpec(t, other, "node_a", 6, full(sysctl(`{"vm.swappiness":10}`)))), "not pinned")

	// Another node's spec, and an older one once a newer was applied.
	expect(ask("sysctl", `{"vm.swappiness":10}`, signedSpec(t, signer, "node_b", 9, full(sysctl(`{"vm.swappiness":10}`)))), "not this node")
	g7 := signedSpec(t, signer, "node_a", 7, full(sysctl(`{"vm.swappiness":20}`)))
	expect(ask("sysctl", `{"vm.swappiness":20}`, g7), "")
	expect(ask("sysctl", `{"vm.swappiness":10}`, g5), "older than one already applied")

	// A patch proves the host section only when it sets it.
	patch := &agentv1.DesiredStateBody{Spec: &agentv1.DesiredStateBody_Patch{Patch: &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{}}}}
	expect(ask("sysctl", `{"vm.swappiness":20}`, signedSpec(t, signer, "node_a", 8, patch)), "does not set the host section")

	// The spec stays good after its worker certificate expires (unchanged specs keep their first
	// signature); a new body under an expired certificate does not.
	now = signer.valid.Add(time.Hour)
	expect(ask("sysctl", `{"vm.swappiness":20}`, g7), "")
	expect(ask("sysctl", `{"vm.swappiness":30}`, signedSpec(t, signer, "node_a", 10, full(sysctl(`{"vm.swappiness":30}`)))), "untrusted signer")

	// Without pins there is nothing to check (an install without signed intent).
	s.CommandRootPins = nil
	expect(ask("sysctl", `{"vm.swappiness":99}`, nil), "")
}
