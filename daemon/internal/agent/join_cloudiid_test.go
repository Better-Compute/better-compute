package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/cloud/aws"
)

const iidDocument = `{"accountId":"123456789012","instanceId":"i-0123456789abcdef0","region":"us-east-1","pendingTime":"2026-11-05T10:00:00Z"}`

// iidIMDS is an IMDSv2 fake serving an instance identity document.
func iidIMDS(t *testing.T) (*httptest.Server, *int) {
	gets := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/latest/api/token":
			_, _ = w.Write([]byte("tok"))
		case r.Header.Get("X-aws-ec2-metadata-token") != "tok":
			w.WriteHeader(http.StatusUnauthorized)
		case r.URL.Path == "/latest/dynamic/instance-identity/document":
			gets++
			_, _ = w.Write([]byte(iidDocument))
		case r.URL.Path == "/latest/dynamic/instance-identity/signature":
			_, _ = w.Write([]byte("c2lnbmF0dXJl\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &gets
}

func ec2Root(t *testing.T, vendor string) string {
	root := t.TempDir()
	dir := filepath.Join(root, "sys", "class", "dmi", "id")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sys_vendor"), []byte(vendor+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

// cloudIidGateway checks every round is a token-less cloud-iid join carrying the IID evidence.
type cloudIidGateway struct {
	*joinService
	evidence []string
}

func (g *cloudIidGateway) Join(ctx context.Context, req *agentv1.JoinRequest) (*agentv1.JoinResponse, error) {
	if req.GetAttestor() != "cloud-iid" || len(req.GetSealedToken()) != 0 {
		g.t.Fatalf("attestor %q, sealed token %d bytes", req.GetAttestor(), len(req.GetSealedToken()))
	}
	g.evidence = append(g.evidence, string(req.GetAttestation()))
	return g.joinService.Join(ctx, req)
}

func TestJoinWithCloudIid(t *testing.T) {
	srv, gets := iidIMDS(t)
	f := joinFixture(t)
	g := &cloudIidGateway{joinService: f}
	attest := &aws.Attestor{Client: &aws.Client{Root: ec2Root(t, "Amazon EC2"), Endpoint: srv.URL}}
	state, err := Join(context.Background(), JoinOptions{
		Client: g, Attestor: aws.AttestorID, Attest: attest,
		EncryptionKey: &f.encKey.PublicKey, SignerPin: f.pin, DataDir: t.TempDir(),
		Sleep: func(context.Context, time.Duration) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if state.NodeID != f.nodeID || len(g.evidence) != 2 {
		t.Fatalf("state %v after %d rounds", state, len(g.evidence))
	}
	// The pending round and the issuing round carry the same evidence, read once.
	if g.evidence[0] != g.evidence[1] || *gets != 1 {
		t.Fatalf("evidence changed between rounds or re-read (%d reads)", *gets)
	}
	var ev struct{ Provider, Document, Signature string }
	if err := json.Unmarshal([]byte(g.evidence[0]), &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Provider != "aws" || ev.Document != iidDocument || ev.Signature != "c2lnbmF0dXJl" {
		t.Fatalf("evidence %s", g.evidence[0])
	}
}

func TestJoinWithCloudIidOffEC2SendsNothing(t *testing.T) {
	srv, gets := iidIMDS(t)
	f := joinFixture(t)
	g := &cloudIidGateway{joinService: f}
	attest := &aws.Attestor{Client: &aws.Client{Root: ec2Root(t, "QEMU"), Endpoint: srv.URL}}
	_, err := Join(context.Background(), JoinOptions{
		Client: g, Attestor: aws.AttestorID, Attest: attest,
		EncryptionKey: &f.encKey.PublicKey, SignerPin: f.pin, DataDir: t.TempDir(),
	})
	if !errors.Is(err, aws.ErrNotEC2) || *gets != 0 || len(g.evidence) != 0 {
		t.Fatalf("err %v, %d metadata reads, %d joins", err, *gets, len(g.evidence))
	}
}
