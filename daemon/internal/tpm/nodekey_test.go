package tpm_test

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"math/big"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/tpm"
	"github.com/better-compute/better-compute/daemon/internal/tpm/tpmsim"
)

// The node's own signing key in the TPM: a crypto.Signer (CSRs, TLS, node statements), derived
// again from its unique, and certified by the AK as a key this TPM holds.
func TestNodeKey(t *testing.T) {
	sim, err := tpmsim.New()
	if err != nil {
		t.Fatal(err)
	}
	a, err := tpm.NewAttestor(sim)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	unique := bytes.Repeat([]byte{7}, tpm.NodeKeyUniqueSize)
	k, err := a.NodeKey(unique)
	if err != nil {
		t.Fatal(err)
	}
	defer k.Close()
	pub := k.Public().(*ecdsa.PublicKey)

	// Signs SHA-256 and SHA-384 digests (TLS may ask for either), as an ECDSA key's ASN.1 signature.
	d256 := sha256.Sum256([]byte("node statement"))
	d384 := sha512.Sum384([]byte("tls 1.2 handshake"))
	for _, digest := range [][]byte{d256[:], d384[:]} {
		sig, err := k.Sign(rand.Reader, digest, crypto.SHA256)
		if err != nil || !ecdsa.VerifyASN1(pub, digest, sig) {
			t.Fatalf("%d-byte digest: %v", len(digest), err)
		}
	}
	// A CSR signed through it, as agent.Join makes one.
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "node"}}, k)
	if err != nil {
		t.Fatal(err)
	}
	if csr, err := x509.ParseCertificateRequest(der); err != nil || csr.CheckSignature() != nil {
		t.Fatalf("CSR: %v", err)
	}

	// The same unique derives the same key (after a restart); another unique another key.
	again, err := tpm.LoadNodeKey(sim, unique)
	if err != nil || !again.Public().(*ecdsa.PublicKey).Equal(pub) {
		t.Fatalf("reload: %v", err)
	}
	again.Close()
	other, err := tpm.LoadNodeKey(sim, bytes.Repeat([]byte{8}, tpm.NodeKeyUniqueSize))
	if err != nil || other.Public().(*ecdsa.PublicKey).Equal(pub) {
		t.Fatalf("another unique: %v", err)
	}
	other.Close()
	if _, err := tpm.LoadNodeKey(sim, []byte("short")); err == nil {
		t.Fatal("a short unique was taken")
	}

	// The AK certifies it: over the qualifying data, naming exactly this key's public area.
	qualifying := sha256.Sum256([]byte("csr"))
	attest, signature, err := a.CertifyNodeKey(k, qualifying[:])
	if err != nil {
		t.Fatal(err)
	}
	extra, name, err := tpm.ParseCertify(attest)
	want, _ := tpm.Name(k.PublicArea())
	if err != nil || !bytes.Equal(extra, qualifying[:]) || !bytes.Equal(name, want) {
		t.Fatalf("certification: %x %x %v", extra, name, err)
	}
	ak, _, err := tpm.ECCPublic(a.AKPublic())
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(attest)
	if !verifyTPMSignature(ak, digest[:], signature) {
		t.Fatal("the certification is not the AK's")
	}
	if _, attrs, _ := tpm.ECCPublic(k.PublicArea()); attrs != tpm.NodeKeyAttributes {
		t.Fatalf("attributes %#x", attrs)
	}
	// A key loaded through another connection is not certified by this attestor.
	elsewhere, _ := tpm.LoadNodeKey(sim, unique)
	if _, _, err := a.CertifyNodeKey(elsewhere, qualifying[:]); err == nil {
		t.Fatal("a key of another connection was certified")
	}
	elsewhere.Close()
	if _, err := k.Sign(rand.Reader, d256[:], crypto.SHA256); err != nil {
		t.Fatal(err)
	}
	k.Close()
	if _, err := k.Sign(rand.Reader, d256[:], crypto.SHA256); err == nil {
		t.Fatal("a closed key signed")
	}
}

// verifyTPMSignature checks a TPMT_SIGNATURE (ECDSA) over digest.
func verifyTPMSignature(pub *ecdsa.PublicKey, digest, signature []byte) bool {
	if len(signature) < 4 || binary.BigEndian.Uint16(signature) != tpm.AlgECDSA {
		return false
	}
	r := &tpm.Reader{B: signature[4:]}
	rb, sb := r.B2B(), r.B2B()
	return r.Err == nil && ecdsa.Verify(pub, digest, new(big.Int).SetBytes(rb), new(big.Int).SetBytes(sb))
}
