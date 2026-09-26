package helper

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"net"
	"path/filepath"
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/tpm"
	"github.com/better-compute/better-compute/daemon/internal/tpm/tpmsim"
)

// An unprivileged bcd node's TPM node keys through the helper (security review 3): the node derives,
// signs, certifies and releases keys by their unique, and nothing else reaches the TPM.
func TestHelperTPMKeys(t *testing.T) {
	sim, err := tpmsim.New()
	if err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(t.TempDir(), "helper.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	srv := &Server{Ops: &fakeOps{}, Root: t.TempDir(), Allowed: me, TPM: func() (tpm.Keys, error) { return tpm.DeviceKeys(sim), nil }}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = srv.Serve(ctx, ln) }()
	c := Client{Socket: sock}
	keys := TPMKeys{Client: c}

	unique := bytes.Repeat([]byte{7}, tpm.NodeKeyUniqueSize)
	key, err := keys.NodeKey(unique)
	if err != nil {
		t.Fatal(err)
	}
	// The same key root derives from that unique in the TPM itself.
	direct, err := tpm.LoadNodeKey(sim, unique)
	if err != nil {
		t.Fatal(err)
	}
	if !key.Public().(*ecdsa.PublicKey).Equal(direct.Public()) || !bytes.Equal(key.PublicArea(), direct.PublicArea()) {
		t.Fatal("the helper's node key is not the TPM's")
	}
	digest := sha256.Sum256([]byte("statement"))
	sig, err := key.Sign(nil, digest[:], nil)
	if err != nil || !ecdsa.VerifyASN1(direct.Public().(*ecdsa.PublicKey), digest[:], sig) {
		t.Fatalf("sign: %v", err)
	}

	// The AK certifies the node key over the qualifying value (a renewal's sha256(csr)).
	a, err := tpm.NewAttestor(sim)
	if err != nil {
		t.Fatal(err)
	}
	akName, _ := tpm.Name(a.AKPublic())
	a.Close()
	cert, err := keys.Certifier()
	if err != nil {
		t.Fatal(err)
	}
	if name, _ := tpm.Name(cert.AKPublic()); !bytes.Equal(name, akName) {
		t.Fatal("the helper's AK is not the TPM's")
	}
	qualifying := sha256.Sum256([]byte("csr"))
	attest, _, err := cert.CertifyNodeKey(key, qualifying[:])
	if err != nil {
		t.Fatal(err)
	}
	extra, certified, err := tpm.ParseCertify(attest)
	keyName, _ := tpm.Name(key.PublicArea())
	if err != nil || !bytes.Equal(extra, qualifying[:]) || !bytes.Equal(certified, keyName) {
		t.Fatalf("certify: %v", err)
	}

	// More keys than the helper keeps loaded: the least recently used is unloaded and derived again.
	for i := byte(0); i < maxTPMKeys+1; i++ {
		if _, err := keys.NodeKey(bytes.Repeat([]byte{i + 100}, tpm.NodeKeyUniqueSize)); err != nil {
			t.Fatal(err)
		}
	}
	if len(srv.tpm.loaded) != maxTPMKeys {
		t.Fatalf("%d keys loaded", len(srv.tpm.loaded))
	}
	if sig, err := key.Sign(nil, digest[:], nil); err != nil || !ecdsa.VerifyASN1(direct.Public().(*ecdsa.PublicKey), digest[:], sig) {
		t.Fatalf("an unloaded key: %v", err)
	}
	if err := key.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := key.Sign(nil, digest[:], nil); err != nil {
		t.Fatalf("a released key is derived again: %v", err)
	}

	// Only what node keys need, and only in their shape.
	for _, bad := range []struct {
		op  string
		req *TPMRequest
		msg string
	}{
		{"tpm.nodekey", &TPMRequest{Unique: []byte("short")}, "32 bytes"},
		{"tpm.sign", &TPMRequest{Unique: unique, Digest: make([]byte, 20)}, "SHA-256"},
		{"tpm.certify", &TPMRequest{Unique: unique, Qualifying: make([]byte, 16)}, "32 bytes"},
		{"tpm.clear", &TPMRequest{Unique: unique}, "unknown operation"},
		{"tpm.nodekey", nil, "no arguments"},
	} {
		if err := c.Do(context.Background(), Request{Op: bad.op, TPM: bad.req}); err == nil || !strings.Contains(err.Error(), bad.msg) {
			t.Fatalf("%s %+v: %v", bad.op, bad.req, err)
		}
	}
	// A helper on a host without a TPM refuses them all.
	bare, _, _ := serve(t, me)
	if _, err := (TPMKeys{Client: bare}).NodeKey(unique); err == nil || !strings.Contains(err.Error(), "no TPM") {
		t.Fatalf("without a TPM: %v", err)
	}
}
