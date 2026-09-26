package main

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"math/big"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/proto"
)

// Under [helper], doctor says what bcd helper binds host units to: root's signed join record, or (a
// node joined before the record) the first signed spec, a trust-on-first-use finding to close.
func TestHelperBindingChecks(t *testing.T) {
	joinKey := func() (*ecdsa.PrivateKey, []byte) {
		key, _ := pki.GenerateKey()
		tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "join"}, NotAfter: time.Now().Add(time.Hour)}
		der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
		if err != nil {
			t.Fatal(err)
		}
		return key, der
	}
	key, der := joinKey()
	digest, _ := pki.SPKISHA256(&key.PublicKey)
	dir := t.TempDir()
	cfg := &config.Config{DataDir: dir, JoinSigningKeyPin: "sha256/" + base64.StdEncoding.EncodeToString(digest)}
	cfg.Helper.Socket = "/run/bcd-helper/helper.sock"
	sys := hostconfig.NewFakeSystem()
	record := func(node string, key *ecdsa.PrivateKey, der []byte) {
		t.Helper()
		body, _ := proto.Marshal(&agentv1.JoinResponseBody{NodeId: node, CertChain: [][]byte{{1}}})
		sig, _ := pki.SignP1363(key, pki.SigningInput(pki.PurposeJoinResponse, body))
		if err := helper.WriteJoinRecord(sys, &agentv1.JoinResponse{Body: body, Sig: &commonv1.Signature{Kid: "join", Sig: sig, Chain: [][]byte{der}}}); err != nil {
			t.Fatal(err)
		}
	}
	check := func(wantStatus, wantDetail string) {
		t.Helper()
		got := helperBindingChecks(cfg, sys)
		if wantStatus == "" {
			if len(got) != 0 {
				t.Fatalf("checks %v, want none", got)
			}
			return
		}
		if len(got) != 1 || got[0].status != wantStatus || !strings.Contains(got[0].detail, wantDetail) {
			t.Fatalf("checks %v, want %s %q", got, wantStatus, wantDetail)
		}
	}

	check("", "") // not joined yet
	joinedState(t, dir, "node_a", "site_a")
	check("warn", "trust on first use")
	record("node_a", key, der)
	check("ok", "host units bind to node_a")
	record("node_b", key, der)
	check("fail", "names node_b, but this machine's identity is node_a")
	otherKey, otherDER := joinKey()
	record("node_a", otherKey, otherDER)
	check("fail", "not a JoinResponse signed by the pinned JoinService key")
	cfg.Helper.Socket = ""
	check("", "")
}
