package pki

import (
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"google.golang.org/protobuf/proto"
)

// testdata/interop.json is written by scripts/daemon-fixtures.mjs with @better-compute/pki, so these
// tests check the Go side against the TypeScript implementation byte for byte.
type interop struct {
	Now               int64  `json:"now"`
	NodeID            string `json:"nodeId"`
	NodeKeyPKCS8      string `json:"nodeKeyPkcs8"`
	CSR               string `json:"csr"`
	NodeCert          string `json:"nodeCert"`
	NodeCACert        string `json:"nodeCaCert"`
	SigningPin        string `json:"signingPin"`
	JoinResponse      string `json:"joinResponse"`
	JWE               string `json:"jwe"`
	JWERecipientPKCS8 string `json:"jweRecipientPkcs8"`
}

func loadInterop(t *testing.T) interop {
	t.Helper()
	data, err := os.ReadFile("testdata/interop.json")
	if err != nil {
		t.Fatal(err)
	}
	var f interop
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func pkcs8(t *testing.T, s string) *ecdsa.PrivateKey {
	t.Helper()
	k, err := x509.ParsePKCS8PrivateKey(unhex(t, s))
	if err != nil {
		t.Fatal(err)
	}
	return k.(*ecdsa.PrivateKey)
}

func pinBytes(t *testing.T, pin string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(pin, "sha256/"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// skipOldFormat skips when the fixtures still carry the 2.25.<uuid> role extension, which Go cannot
// parse (PLAN ae3134f moved the role to Subject OU); regenerate with scripts/daemon-fixtures.mjs.
func skipOldFormat(t *testing.T, f interop) {
	t.Helper()
	if _, err := x509.ParseCertificate(unhex(t, f.NodeCert)); err != nil && strings.Contains(err.Error(), "malformed extension OID") {
		t.Skip("testdata/interop.json predates the bc-role OU certificate format; run scripts/daemon-fixtures.mjs")
	}
}

func TestNodeCertificateFromTypeScript(t *testing.T) {
	f := loadInterop(t)
	skipOldFormat(t, f)
	cert, err := x509.ParseCertificate(unhex(t, f.NodeCert))
	if err != nil {
		t.Fatalf("Go cannot parse a pki-issued node certificate: %v", err)
	}
	id, err := NodeIdentity(cert)
	if err != nil {
		t.Fatal(err)
	}
	want := Identity{TrustDomain: "compute.test", SiteID: "site_go", NodeID: f.NodeID, Role: "node"}
	if id != want {
		t.Fatalf("identity = %+v, want %+v", id, want)
	}
	if err := VerifyChain([][]byte{unhex(t, f.NodeCert)}, [][]byte{unhex(t, f.NodeCACert)}, time.UnixMilli(f.Now)); err != nil {
		t.Fatal(err)
	}
}

func TestJoinResponseFromTypeScript(t *testing.T) {
	f := loadInterop(t)
	skipOldFormat(t, f)
	resp := &agentv1.JoinResponse{}
	if err := proto.Unmarshal(unhex(t, f.JoinResponse), resp); err != nil {
		t.Fatal(err)
	}
	opts := VerifyJoinOptions{
		SignerPin:   pinBytes(t, f.SigningPin),
		CSR:         unhex(t, f.CSR),
		NodeCARoots: [][]byte{unhex(t, f.NodeCACert)},
		Now:         time.UnixMilli(f.Now),
	}
	out, err := OpenJoinResponse(resp, opts)
	if err != nil {
		t.Fatal(err)
	}
	if out.Body == nil || out.Body.GetNodeId() != f.NodeID {
		t.Fatalf("outcome = %+v", out)
	}
	// Another pin, another CSR, a tampered body: all refused.
	wrongPin := append([]byte(nil), opts.SignerPin...)
	wrongPin[0] ^= 1
	if _, err := OpenJoinResponse(resp, VerifyJoinOptions{SignerPin: wrongPin, CSR: opts.CSR}); err == nil {
		t.Fatal("accepted under another pin")
	}
	key, _ := GenerateKey()
	otherCSR, _ := CreateCSR(key)
	if _, err := OpenJoinResponse(resp, VerifyJoinOptions{SignerPin: opts.SignerPin, CSR: otherCSR}); err == nil {
		t.Fatal("accepted for another CSR")
	}
	tampered := proto.Clone(resp).(*agentv1.JoinResponse)
	tampered.Body[len(tampered.Body)-1] ^= 1
	if _, err := OpenJoinResponse(tampered, opts); err == nil {
		t.Fatal("accepted a tampered body")
	}
}

func TestOpenJWESealedByTypeScript(t *testing.T) {
	f := loadInterop(t)
	opened, err := OpenJWE(f.JWE, pkcs8(t, f.JWERecipientPKCS8), "bctest+jwe")
	if err != nil {
		t.Fatal(err)
	}
	if string(opened.Plaintext) != "hello from ts" || opened.Header["rid"] != "r1" {
		t.Fatalf("opened = %q %v", opened.Plaintext, opened.Header)
	}
	if _, err := OpenJWE(f.JWE, pkcs8(t, f.JWERecipientPKCS8), "other+jwe"); err == nil {
		t.Fatal("opened under another typ")
	}
}

func TestJWERoundTrip(t *testing.T) {
	key, _ := GenerateKey()
	sealed, err := SealJWE([]byte("secret"), &key.PublicKey, map[string]any{"typ": "x+jwe"})
	if err != nil {
		t.Fatal(err)
	}
	opened, err := OpenJWE(sealed, key, "x+jwe")
	if err != nil || string(opened.Plaintext) != "secret" {
		t.Fatalf("round trip: %v %q", err, opened.Plaintext)
	}
	other, _ := GenerateKey()
	if _, err := OpenJWE(sealed, other, ""); err == nil {
		t.Fatal("opened with another key")
	}
	if _, err := SealJWE(nil, &key.PublicKey, map[string]any{"alg": "none"}); err == nil {
		t.Fatal("sealed with a reserved member")
	}
}

func TestKeyWrapRFC3394Vector(t *testing.T) {
	// RFC 3394 §4.6: 256-bit KEK, 256-bit key.
	kek, _ := hex.DecodeString("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F")
	key, _ := hex.DecodeString("00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F")
	want := "28c9f404c4b810f4cbccb35cfb87f8263f5786e2d80ed326cbc7f0e71a99f43bfb988b9b7a02dd21"
	got, err := keyWrap(kek, key)
	if err != nil || hex.EncodeToString(got) != want {
		t.Fatalf("wrap = %x, %v", got, err)
	}
	back, err := keyUnwrap(kek, got)
	if err != nil || hex.EncodeToString(back) != strings.ToLower(hex.EncodeToString(key)) {
		t.Fatalf("unwrap = %x, %v", back, err)
	}
}
