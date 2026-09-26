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

	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/proto"
)

// joinSigner is the JoinService signing key: it signs trust bundles, and config.toml pins it.
type joinSigner struct {
	pin  []byte
	sign func(version uint64, roots ...[]byte) []byte
}

func newJoinSigner(t *testing.T) joinSigner {
	t.Helper()
	key, _ := pki.GenerateKey()
	now := time.Now()
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(9), Subject: pkix.Name{CommonName: "join signing"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour)}
	cert, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	pin, _ := pki.SPKISHA256(&key.PublicKey)
	return joinSigner{pin: pin, sign: func(version uint64, roots ...[]byte) []byte {
		body, _ := proto.Marshal(&commonv1.TrustBundle{Version: version, CommandSigningRoots: roots})
		sig, err := pki.SignP1363(key, pki.SigningInput(pki.PurposeTrustBundle, body))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := proto.Marshal(&commonv1.SignedTrustBundle{Body: body, Signature: &commonv1.Signature{Kid: "join", Sig: sig, Chain: [][]byte{cert}}})
		return raw
	}}
}

// A node pinned only by the JoinService key (no command_root_sha256): the roots come from the trust
// bundle that key signed, through a whole command-signing root rotation.
func TestHostUnitRootsFromTheSignedTrustBundle(t *testing.T) {
	join := newJoinSigner(t)
	oldRoot := newIntentSigner(t, "worker", time.Now().Add(time.Hour))
	newRoot := newIntentSigner(t, "worker", time.Now().Add(time.Hour))
	s := &Server{HostSystem: hostconfig.NewFakeSystem(), JoinSigningPin: join.pin}
	ask := func(settings string, spec *HostIntent, bundle []byte) error {
		in := &HostIntent{TrustBundle: bundle}
		if spec != nil {
			in.Body, in.Signature = spec.Body, spec.Signature
		}
		return s.checkIntent(Request{Op: "host.unit", Unit: "sysctl", Settings: json.RawMessage(settings), Intent: in})
	}
	expect := func(err error, want string) {
		t.Helper()
		if want == "" && err != nil || want != "" && (err == nil || !strings.Contains(err.Error(), want)) {
			t.Fatalf("err = %v, want %q", err, want)
		}
	}
	spec := func(signer intentSigner, generation uint64, swappiness string) *HostIntent {
		return signedSpec(t, signer, "node_a", generation, full(sysctl(`{"vm.swappiness":`+swappiness+`}`)))
	}

	// Before any bundle: an install without signed intent, nothing to check.
	if err := s.checkIntent(Request{Op: "host.unit", Unit: "sysctl", Settings: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	v1 := join.sign(1, oldRoot.root)
	expect(ask(`{"vm.swappiness":10}`, spec(oldRoot, 5, "10"), v1), "")
	// rotate-command-root: add (both published), switch (the new one signs), drop (the old one goes).
	v2 := join.sign(2, oldRoot.root, newRoot.root)
	expect(ask(`{"vm.swappiness":11}`, spec(oldRoot, 6, "11"), v2), "")
	v3 := join.sign(3, newRoot.root, oldRoot.root)
	expect(ask(`{"vm.swappiness":12}`, spec(newRoot, 7, "12"), v3), "")
	v4 := join.sign(4, newRoot.root)
	expect(ask(`{"vm.swappiness":13}`, spec(newRoot, 8, "13"), v4), "")
	expect(ask(`{"vm.swappiness":14}`, spec(oldRoot, 9, "14"), v4), "untrusted signer")
	// A replayed old bundle that still trusts the old root: a rollback.
	expect(ask(`{"vm.swappiness":14}`, spec(oldRoot, 9, "14"), v1), "older than 4")
	// Once signed, always signed: no spec, a bundle without roots, a bundle from another key.
	if err := s.checkIntent(Request{Op: "host.unit", Unit: "sysctl", Settings: json.RawMessage(`{"vm.swappiness":99}`)}); err == nil ||
		!strings.Contains(err.Error(), "specs are signed") {
		t.Fatalf("no intent after signed: %v", err)
	}
	expect(ask(`{"vm.swappiness":99}`, nil, join.sign(5)), "without command-signing roots")
	expect(ask(`{"vm.swappiness":13}`, spec(newRoot, 8, "13"), newJoinSigner(t).sign(5, newRoot.root)), "not signed by the pinned JoinService key")
	// The explicit pins, when present, decide alone (the bundle is not consulted).
	pinned := sha256Of(oldRoot.root)
	s.CommandRootPins = [][]byte{pinned}
	g := spec(newRoot, 10, "15")
	g.Roots = [][]byte{newRoot.root}
	g.TrustBundle = v4
	if err := s.checkIntent(Request{Op: "host.unit", Unit: "sysctl", Settings: json.RawMessage(`{"vm.swappiness":15}`), Intent: g}); err == nil ||
		!strings.Contains(err.Error(), "not pinned") {
		t.Fatalf("pins override: %v", err)
	}
}

func sha256Of(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}
