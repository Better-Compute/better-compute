package tpm_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"strconv"
	"testing"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/tpm"
	"github.com/better-compute/better-compute/daemon/internal/tpm/tpmsim"
)

var b64 = base64.RawURLEncoding

type evidence struct {
	V      int    `json:"v"`
	EK     string `json:"ek"`
	EKCert string `json:"ekCert"`
	AK     string `json:"ak"`
	Answer *struct {
		State, Secret, Quote, Signature string
		PCRs                            map[string]map[string]string
	} `json:"answer"`
}

// challengeFor is the control plane's round 1 (tpmAttestor): a credential for the AK's name, sealed
// to the EK, and the PCRs to quote.
func challengeFor(t *testing.T, e evidence, secret []byte, sels []tpm.Selection) []byte {
	t.Helper()
	ek, _ := b64.DecodeString(e.EK)
	ak, _ := b64.DecodeString(e.AK)
	name, err := tpm.Name(ak)
	if err != nil {
		t.Fatal(err)
	}
	blob, enc, err := tpmsim.MakeCredential(ek, name, secret)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"credentialBlob": b64.EncodeToString(blob), "encryptedSecret": b64.EncodeToString(enc),
		"state": "sealed-state", "pcrSelection": sels})
	return raw
}

func TestEnrollment(t *testing.T) {
	sim, err := tpmsim.New()
	if err != nil {
		t.Fatal(err)
	}
	sim.Extend(0, []byte("firmware"))
	sim.Extend(12, []byte("kernel"))
	// An EK certificate in NV, padded as NV areas often are.
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.CreateCertificate(rand.Reader, &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "ek"},
		NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour)}, &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "ek"}}, &key.PublicKey, key)
	sim.EKCert = append(append([]byte{}, der...), bytes.Repeat([]byte{0xff}, 700)...)

	a, err := tpm.NewAttestor(sim)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	raw, err := a.Evidence()
	if err != nil {
		t.Fatal(err)
	}
	var round1 evidence
	_ = json.Unmarshal(raw, &round1)
	if round1.V != 1 || round1.EK == "" || round1.AK == "" || round1.Answer != nil {
		t.Fatalf("round 1 = %s", raw)
	}
	if cert, _ := b64.DecodeString(round1.EKCert); !bytes.Equal(cert, der) {
		t.Fatalf("the EK certificate (%d bytes) is not the NV's DER (%d)", len(cert), len(der))
	}
	ekPub, _ := b64.DecodeString(round1.EK)
	if !bytes.HasPrefix(ekPub, tpm.EKTemplate()[:len(tpm.EKTemplate())-258]) {
		t.Fatal("the EK is not the default template's")
	}

	// Round 2: PCRs 0-15 (more than a PCR_Read returns at once).
	secret := bytes.Repeat([]byte{7}, 32)
	sels := []tpm.Selection{{Hash: tpm.AlgSHA256, PCRs: []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}}}
	csr := sha256.Sum256([]byte("the CSR"))
	raw, err = a.Answer(challengeFor(t, round1, secret, sels), csr[:])
	if err != nil {
		t.Fatal(err)
	}
	var round2 evidence
	_ = json.Unmarshal(raw, &round2)
	ans := round2.Answer
	if ans == nil || ans.State != "sealed-state" || round2.EK != round1.EK || round2.AK != round1.AK {
		t.Fatalf("round 2 = %s", raw)
	}
	if got, _ := b64.DecodeString(ans.Secret); !bytes.Equal(got, secret) {
		t.Fatal("the credential was not recovered")
	}
	// The quote: signed by the AK, over sha256(secret ‖ sha256(csr)), with the PCRs it reports.
	quote, _ := b64.DecodeString(ans.Quote)
	sig, _ := b64.DecodeString(ans.Signature)
	akPub, _ := b64.DecodeString(round1.AK)
	r := &tpm.Reader{B: akPub[len(akPub)-68:]}
	x, y := r.B2B(), r.B2B()
	pub := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
	sr := &tpm.Reader{B: sig}
	if sr.U16() != tpm.AlgECDSA || sr.U16() != tpm.AlgSHA256 {
		t.Fatal("not an ECDSA-SHA256 signature")
	}
	rs, ss := sr.B2B(), sr.B2B()
	digest := sha256.Sum256(quote)
	if !ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(rs), new(big.Int).SetBytes(ss)) {
		t.Fatal("the quote's signature does not verify under the AK")
	}
	qr := &tpm.Reader{B: quote}
	qr.U32()
	qr.U16()
	qr.B2B()
	nonce := sha256.Sum256(append(append([]byte{}, secret...), csr[:]...))
	if !bytes.Equal(qr.B2B(), nonce[:]) {
		t.Fatal("the quote's nonce is not sha256(secret ‖ sha256(csr))")
	}
	values := map[uint16]map[int][]byte{tpm.AlgSHA256: {}}
	for i, h := range ans.PCRs[strconv.Itoa(tpm.AlgSHA256)] {
		n, _ := strconv.Atoi(i)
		values[tpm.AlgSHA256][n], _ = hex.DecodeString(h)
	}
	if len(values[tpm.AlgSHA256]) != 16 || !bytes.Equal(values[tpm.AlgSHA256][12], sim.PCR(12)) {
		t.Fatalf("pcrs = %v", ans.PCRs)
	}
	want, _ := tpm.PCRDigest(sels, values, tpm.AlgSHA256)
	if got, _ := tpm.QuoteDigest(quote); !bytes.Equal(got, want) {
		t.Fatal("the quote's PCR digest is not the reported values'")
	}

	// A credential made for another object's name opens on no TPM.
	other := round1
	otherAK, _ := b64.DecodeString(round1.AK)
	otherAK[len(otherAK)-1] ^= 1
	other.AK = b64.EncodeToString(otherAK)
	if _, err := a.Answer(challengeFor(t, other, secret, sels), csr[:]); err == nil {
		t.Fatal("a credential for another AK was activated")
	}
}

// The simulator is one machine across restarts: the same EK and AK.
func TestSimulatorState(t *testing.T) {
	path := t.TempDir() + "/tpm.json"
	first, err := tpmsim.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	a1, _ := tpm.NewAttestor(first)
	e1, _ := a1.Evidence()
	second, err := tpmsim.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	a2, _ := tpm.NewAttestor(second)
	e2, _ := a2.Evidence()
	if !bytes.Equal(e1, e2) || bytes.Equal(first.PCR(0), make([]byte, 32)) {
		t.Fatal("the simulator's identity or boot measurements did not persist")
	}
}
