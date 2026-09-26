package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"io"
	"log/slog"
	"os"
	"path/filepath"
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

// useTPM gives node keys a software TPM for the test.
func useTPM(t *testing.T, sim *tpmsim.Sim) {
	t.Helper()
	TPM = func() (tpm.Transport, error) { return sim, nil }
	resetTPM()
	t.Cleanup(func() { TPM = nil; resetTPM() })
}

// renewerFunc is a Renewer from a function.
type renewerFunc func(context.Context, *agentv1.RenewRequest) (*agentv1.RenewResponse, error)

func (f renewerFunc) Renew(ctx context.Context, req *agentv1.RenewRequest) (*agentv1.RenewResponse, error) {
	return f(ctx, req)
}

// The node key in the TPM: the join makes it there (the data directory holds only its record), every
// load derives it again, it signs node statements the certificate's key verifies, renewal makes the
// next one there too (and moves a file key into the TPM), and without the TPM it does not load.
func TestNodeKeyInTheTPM(t *testing.T) {
	sim, err := tpmsim.New()
	if err != nil {
		t.Fatal(err)
	}
	f := joinFixture(t)
	join := func(dir string) {
		t.Helper()
		if _, err := Join(context.Background(), JoinOptions{
			Client: f, Token: "bcjt_join_01k5w0000000000000000000000." + strings.Repeat("A", 43),
			EncryptionKey: &f.encKey.PublicKey, SignerPin: f.pin, DataDir: dir,
			Sleep: func(context.Context, time.Duration) error { return nil },
		}); err != nil {
			t.Fatal(err)
		}
		f.calls = 0 // the next join is deferred once again
	}
	renew := func(dir string) {
		t.Helper()
		state, key, err := LoadState(dir)
		if err != nil {
			t.Fatal(err)
		}
		leaf, _ := state.Leaf()
		a, err := New(Options{
			State: state, Key: key, DataDir: dir, Journal: journal.NewMemory(state.NodeID, journal.MemoryOptions{}),
			Host: &fakeHost{boot: "boot-1", root: t.TempDir(), inv: fakehw.Inventory(1)}, Dial: newGateway(t).dial,
			Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
			Renewer: renewerFunc(func(_ context.Context, req *agentv1.RenewRequest) (*agentv1.RenewResponse, error) {
				// The proof of possession is the current key's, as the gateway checks it.
				if len(req.GetPopSig()) != 64 || !pki.VerifyP1363(leaf.PublicKey.(*ecdsa.PublicKey),
					pki.SigningInput(pki.PurposeRenewPop, sha(req.GetCsr()), []byte(state.NodeID), popTime(req)), req.GetPopSig()) {
					t.Fatal("the renew proof is not the current key's")
				}
				return &agentv1.RenewResponse{CertChain: [][]byte{f.leaf(req.GetCsr())}}, nil
			}),
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := a.renewOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	signs := func(dir string) (string, *ecdsa.PublicKey) {
		t.Helper()
		state, key, err := LoadState(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer closeKey(key)
		leaf, _ := state.Leaf()
		pub := leaf.PublicKey.(*ecdsa.PublicKey)
		input := pki.SigningInput(pki.PurposeAttestedReport, []byte("report"))
		sig, err := pki.SignNodeStatement(key, input)
		kid, _ := pki.KeyID(pub)
		if err != nil || !pki.VerifyP1363(pub, input, sig.GetSig()) || sig.GetKid() != kid {
			t.Fatalf("a node statement: %v", err)
		}
		return NodeKeyKind(key), pub
	}

	useTPM(t, sim)
	dir := t.TempDir()
	join(dir)
	if raw, _ := os.ReadFile(filepath.Join(dir, KeyFile)); !strings.Contains(string(raw), tpmKeyBlock) || strings.Contains(string(raw), "PRIVATE KEY") {
		t.Fatalf("node.key:\n%s", raw)
	}
	kind, joined := signs(dir)
	if kind != "tpm" {
		t.Fatalf("key kind %q", kind)
	}
	renew(dir)
	kind, renewed := signs(dir)
	if kind != "tpm" || renewed.Equal(joined) {
		t.Fatalf("after renewal: %q, same key %v", kind, renewed.Equal(joined))
	}
	if _, err := os.Stat(filepath.Join(dir, NextKeyFile)); !os.IsNotExist(err) {
		t.Fatal("node.key.next stayed")
	}

	// A node that joined with a file key moves into the TPM at its next renewal.
	TPM = nil
	resetTPM()
	fileDir := t.TempDir()
	join(fileDir)
	if kind, _ := signs(fileDir); kind != "file" {
		t.Fatalf("without a TPM: %q", kind)
	}
	useTPM(t, sim)
	renew(fileDir)
	if kind, _ := signs(fileDir); kind != "tpm" {
		t.Fatalf("renewed with a TPM: %q", kind)
	}

	// Without the TPM, a key in it does not load.
	TPM = nil
	resetTPM()
	if _, _, err := LoadState(dir); err == nil || !strings.Contains(err.Error(), "TPM") {
		t.Fatalf("a TPM key without the TPM: %v", err)
	}
}

func sha(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}

// popTime is the renew proof's client time as the signing input frames it.
func popTime(req *agentv1.RenewRequest) []byte {
	ts := req.GetClientTime()
	out := make([]byte, 12)
	for i := 0; i < 8; i++ {
		out[i] = byte(uint64(ts.GetSeconds()) >> (56 - 8*i))
	}
	for i := 0; i < 4; i++ {
		out[8+i] = byte(uint32(ts.GetNanos()) >> (24 - 8*i))
	}
	return out
}
