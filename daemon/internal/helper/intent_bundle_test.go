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

// joinSigner is the JoinService signing key: it signs trust bundles, and config.toml pins it.
type joinSigner struct {
	pin  []byte
	sign func(version uint64, roots ...[]byte) []byte
	// record writes root's join record: a JoinResponse for node whose trust bundle carries roots.
	record func(sys hostconfig.System, node string, version uint64, roots ...[]byte)
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
	}, record: func(sys hostconfig.System, node string, version uint64, roots ...[]byte) {
		body, _ := proto.Marshal(&agentv1.JoinResponseBody{NodeId: node, CertChain: [][]byte{{1}},
			Trust: &commonv1.TrustBundle{Version: version, CommandSigningRoots: roots}})
		sig, err := pki.SignP1363(key, pki.SigningInput(pki.PurposeJoinResponse, body))
		if err != nil {
			t.Fatal(err)
		}
		if err := WriteJoinRecord(sys, &agentv1.JoinResponse{Body: body, Sig: &commonv1.Signature{Kid: "join", Sig: sig, Chain: [][]byte{cert}}}); err != nil {
			t.Fatal(err)
		}
	}}
}

// Root's join record decides signed intent (review 2 MED): with command-signing roots in it, a
// host.unit needs a spec signed under them whatever the node sends or leaves out; a bundle the node
// presents may rotate the roots, only forward.
func TestHostUnitSignedIntentFromTheJoinRecord(t *testing.T) {
	join := newJoinSigner(t)
	root := newIntentSigner(t, "worker", time.Now().Add(time.Hour))
	next := newIntentSigner(t, "worker", time.Now().Add(time.Hour))
	sys := hostconfig.NewFakeSystem()
	s := &Server{HostSystem: sys, JoinSigningPin: join.pin}
	expect := func(err error, want string) {
		t.Helper()
		if want == "" && err != nil || want != "" && (err == nil || !strings.Contains(err.Error(), want)) {
			t.Fatalf("err = %v, want %q", err, want)
		}
	}
	ask := func(settings string, in *HostIntent) error {
		return s.checkIntent(Request{Op: "host.unit", Unit: "sysctl", Settings: json.RawMessage(settings), Intent: in})
	}
	spec := func(signer intentSigner, generation uint64, swappiness string) *HostIntent {
		in := signedSpec(t, signer, "node_a", generation, full(sysctl(`{"vm.swappiness":`+swappiness+`}`)))
		in.Roots = nil // the node names no roots: root's record does
		return in
	}

	// A join record without roots decides nothing (the node's bundle, as before).
	join.record(sys, "node_a", 1)
	expect(ask(`{"vm.swappiness":10}`, nil), "")
	// With roots: the node can no longer skip signing by sending no bundle.
	join.record(sys, "node_a", 3, root.root)
	expect(ask(`{"vm.swappiness":10}`, nil), "needs the signed spec")
	expect(ask(`{"vm.swappiness":10}`, &HostIntent{}), "needs the signed spec")
	expect(ask(`{"vm.swappiness":10}`, spec(root, 5, "10")), "")
	expect(ask(`{"vm.swappiness":11}`, spec(next, 6, "11")), "untrusted signer")
	// The node's bundles only move forward from the record's version: an older one is a rollback, a
	// newer one rotates the roots.
	older := spec(root, 6, "11")
	older.TrustBundle = join.sign(2, next.root)
	expect(ask(`{"vm.swappiness":11}`, older), "older than 3")
	rotated := spec(next, 6, "11")
	rotated.TrustBundle = join.sign(4, next.root)
	expect(ask(`{"vm.swappiness":11}`, rotated), "")
	// Rotated: leaving the bundle out does not bring the record's older roots back.
	expect(ask(`{"vm.swappiness":12}`, spec(root, 7, "12")), "current trust bundle (version 4")
	empty := spec(next, 7, "12")
	empty.TrustBundle = join.sign(5)
	expect(ask(`{"vm.swappiness":12}`, empty), "without command-signing roots")
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
