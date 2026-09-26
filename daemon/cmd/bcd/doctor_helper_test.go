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
	// roots: the command-signing roots the JoinResponse's trust bundle carried.
	record := func(node string, key *ecdsa.PrivateKey, der []byte, roots ...[]byte) {
		t.Helper()
		body, _ := proto.Marshal(&agentv1.JoinResponseBody{NodeId: node, CertChain: [][]byte{{1}},
			Trust: &commonv1.TrustBundle{Version: 1, CommandSigningRoots: roots}})
		sig, _ := pki.SignP1363(key, pki.SigningInput(pki.PurposeJoinResponse, body))
		if err := helper.WriteJoinRecord(sys, &agentv1.JoinResponse{Body: body, Sig: &commonv1.Signature{Kid: "join", Sig: sig, Chain: [][]byte{der}}}); err != nil {
			t.Fatal(err)
		}
	}
	// check: each want is "<status> <part of its detail>", in order.
	check := func(wants ...string) {
		t.Helper()
		got := helperBindingChecks(cfg, sys)
		ok := len(got) == len(wants)
		for i := 0; ok && i < len(wants); i++ {
			status, detail, _ := strings.Cut(wants[i], " ")
			ok = got[i].status == status && strings.Contains(got[i].detail, detail)
		}
		if !ok {
			t.Fatalf("checks %v, want %q", got, wants)
		}
	}
	unsigned := "fail applies host units unsigned unless the node itself presents a trust bundle"
	root := []byte("a command-signing root")

	check() // not joined yet
	joinedState(t, dir, "node_a", "site_a")
	check("warn trust on first use", unsigned)
	record("node_a", key, der, root)
	check("ok host units bind to node_a")
	// Signed intent is root's decision: without the record's roots, only the install's pins make it.
	record("node_a", key, der)
	check("ok host units bind to node_a", unsigned)
	cfg.CommandRootSHA256 = strings.Repeat("ab", 32)
	check("ok host units bind to node_a")
	cfg.CommandRootSHA256 = ""
	record("node_b", key, der, root)
	check("fail names node_b, but this machine's identity is node_a")
	otherKey, otherDER := joinKey()
	record("node_a", otherKey, otherDER, root)
	check("fail not a JoinResponse signed by the pinned JoinService key")
	cfg.Helper.Socket = ""
	check()
}
