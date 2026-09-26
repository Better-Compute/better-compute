package agent

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/url"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/tpm"
	"github.com/better-compute/better-compute/daemon/internal/tpm/tpmsim"
)

// checkKeyAttestation is the control plane's renew check (packages/pki verifyTpmKeyAttestation): the AK
// the certificate names certified the CSR's key, over sha256(csr), as a key its TPM made and holds.
func checkKeyAttestation(req *agentv1.RenewRequest, akName []byte) error {
	ka := req.GetKeyAttestation()
	if ka == nil {
		return fmt.Errorf("no key attestation")
	}
	name, err := tpm.Name(ka.GetAkPublic())
	if err != nil || !bytes.Equal(name, akName) {
		return fmt.Errorf("another AK: %v", err)
	}
	akPub, _, err := tpm.ECCPublic(ka.GetAkPublic())
	if err != nil {
		return err
	}
	r := &tpm.Reader{B: ka.GetSignature()}
	if r.U16() != tpm.AlgECDSA {
		return fmt.Errorf("not an ECDSA signature")
	}
	r.U16()
	sr, ss := r.B2B(), r.B2B()
	digest := sha256.Sum256(ka.GetCertifyInfo())
	if r.Err != nil || !ecdsa.Verify(akPub, digest[:], new(big.Int).SetBytes(sr), new(big.Int).SetBytes(ss)) {
		return fmt.Errorf("the certification is not the AK's")
	}
	extra, certified, err := tpm.ParseCertify(ka.GetCertifyInfo())
	if err != nil {
		return err
	}
	csrSum := sha256.Sum256(req.GetCsr())
	keyName, _ := tpm.Name(ka.GetKeyPublic())
	if !bytes.Equal(extra, csrSum[:]) || !bytes.Equal(certified, keyName) {
		return fmt.Errorf("the certification is of another key or CSR")
	}
	keyPub, attrs, err := tpm.ECCPublic(ka.GetKeyPublic())
	csr, _ := x509.ParseCertificateRequest(req.GetCsr())
	if err != nil || attrs != tpm.NodeKeyAttributes || csr == nil || !keyPub.Equal(csr.PublicKey) {
		return fmt.Errorf("the certified key is not the CSR's TPM-held key")
	}
	return nil
}

// A certificate naming the TPM's AK (urn:bc:tpm-ak:) renews with a next key made in the TPM and certified
// by that AK over the CSR; a missing TPM or another TPM's AK is an error, never a file key.
func TestRenewCertifiedByTheAK(t *testing.T) {
	sim, err := tpmsim.New()
	if err != nil {
		t.Fatal(err)
	}
	useTPM(t, sim)
	a, err := tpm.NewAttestor(sim)
	if err != nil {
		t.Fatal(err)
	}
	akName, _ := tpm.Name(a.AKPublic())
	a.Close()
	statement, _ := url.Parse(fmt.Sprintf("urn:bc:tpm-ak:%x:%x", akName[:2], akName[2:]))
	f := joinFixture(t)
	f.statements = []*url.URL{statement}
	dir := t.TempDir()
	if _, err := Join(context.Background(), JoinOptions{
		Client: f, Token: "bcjt_join_01k5w0000000000000000000000." + strings.Repeat("A", 43),
		EncryptionKey: &f.encKey.PublicKey, SignerPin: f.pin, DataDir: dir,
		Sleep: func(context.Context, time.Duration) error { return nil },
	}); err != nil {
		t.Fatal(err)
	}
	agentFor := func(renewed *[][]byte) *Agent {
		t.Helper()
		state, key, err := LoadState(dir)
		if err != nil {
			t.Fatal(err)
		}
		if leaf, _ := state.Leaf(); leaf != nil {
			if name, err := pki.TPMAKName(leaf); err != nil || !bytes.Equal(name, akName) {
				t.Fatalf("the certificate's AK: %x, %v", name, err)
			}
		}
		ag, err := New(Options{
			State: state, Key: key, DataDir: dir, Journal: journal.NewMemory(state.NodeID, journal.MemoryOptions{}),
			Host: &fakeHost{boot: "boot-1", root: t.TempDir(), inv: fakehw.Inventory(1)}, Dial: newGateway(t).dial,
			Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
			Renewer: renewerFunc(func(_ context.Context, req *agentv1.RenewRequest) (*agentv1.RenewResponse, error) {
				if err := checkKeyAttestation(req, akName); err != nil {
					t.Fatalf("the renewal's key attestation: %v", err)
				}
				*renewed = append(*renewed, req.GetCsr())
				return &agentv1.RenewResponse{CertChain: [][]byte{f.leaf(req.GetCsr())}}, nil
			}),
		})
		if err != nil {
			t.Fatal(err)
		}
		return ag
	}

	// Twice: the renewed certificate names the AK too.
	var renewed [][]byte
	for i := 0; i < 2; i++ {
		if err := agentFor(&renewed).renewOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
		if kind, _ := signsWith(t, dir); kind != "tpm" {
			t.Fatalf("renewal %d: a %s key", i, kind)
		}
	}
	if len(renewed) != 2 {
		t.Fatalf("%d renewals reached the control plane", len(renewed))
	}

	// The TPM gone: a loud failure, no renewal request, no file key.
	ag := agentFor(&renewed)
	TPM = nil
	resetTPM()
	if err := ag.renewOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("without the TPM: %v", err)
	}
	// Another TPM (a cleared one: another AK): refused before any request.
	other, err := tpmsim.New()
	if err != nil {
		t.Fatal(err)
	}
	useTPM(t, other)
	if err := ag.renewOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "not the one the certificate names") {
		t.Fatalf("another TPM: %v", err)
	}
	if len(renewed) != 2 {
		t.Fatal("a renewal without the AK reached the control plane")
	}
}

// signsWith loads the node key and reports what holds it.
func signsWith(t *testing.T, dir string) (string, *ecdsa.PublicKey) {
	t.Helper()
	state, key, err := LoadState(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer closeKey(key)
	leaf, _ := state.Leaf()
	return NodeKeyKind(key), leaf.PublicKey.(*ecdsa.PublicKey)
}
