package pki

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const testTrustDomain = "compute.acme.test"

// packages/protocol/golden/batch-scope.json: the leaves (bound and unbound), proofs and root
// @better-compute/protocol builds for a 3-leaf batch (one promoted odd node).
func TestBatchScopeGolden(t *testing.T) {
	data, err := os.ReadFile("../../../packages/protocol/golden/batch-scope.json")
	if err != nil {
		t.Skipf("goldens not available: %v", err)
	}
	var golden struct {
		BatchID string `json:"batchId"`
		Root    string `json:"root"`
		Leaves  []struct {
			Index         uint32   `json:"index"`
			Subject       string   `json:"subject"`
			Kind          string   `json:"kind"`
			PayloadSha256 string   `json:"payloadSha256"`
			Hash          string   `json:"hash"`
			Siblings      []string `json:"siblings"`
		} `json:"leaves"`
	}
	if err := json.Unmarshal(data, &golden); err != nil {
		t.Fatal(err)
	}
	root := unhex(t, golden.Root)
	size := uint32(len(golden.Leaves))
	for _, l := range golden.Leaves {
		payload := unhex(t, l.PayloadSha256)
		leaf := BatchLeaf(golden.BatchID, l.Subject, l.Kind, payload)
		if hex.EncodeToString(leaf) != l.Hash {
			t.Fatalf("leaf %d = %x, golden %s", l.Index, leaf, l.Hash)
		}
		siblings := make([][]byte, len(l.Siblings))
		for i, s := range l.Siblings {
			siblings[i] = unhex(t, s)
		}
		if !VerifyBatchProof(leaf, l.Index, size, siblings, root) {
			t.Fatalf("leaf %d does not prove into the root", l.Index)
		}
		// Anything else does not: another index, another kind, another payload binding, a dropped or
		// extra sibling. (The size comes from the signed approval, never from the command.)
		other := []byte{}
		if len(payload) == 0 {
			other = bytes.Repeat([]byte{1}, 32)
		}
		if VerifyBatchProof(leaf, (l.Index+1)%size, size, siblings, root) ||
			VerifyBatchProof(BatchLeaf(golden.BatchID, l.Subject, "gpu.reset", payload), l.Index, size, siblings, root) ||
			VerifyBatchProof(BatchLeaf(golden.BatchID, l.Subject, l.Kind, other), l.Index, size, siblings, root) ||
			VerifyBatchProof(leaf, l.Index, size, siblings[:len(siblings)-1], root) ||
			VerifyBatchProof(leaf, l.Index, size, append(append([][]byte{}, siblings...), root), root) {
			t.Fatalf("leaf %d proves more than it should", l.Index)
		}
	}
}

func approverKeyFor(t *testing.T, k *ecdsa.PrivateKey) *commonv1.ApproverKey {
	t.Helper()
	der, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
	return &commonv1.ApproverKey{Kid: ApproverKid(der), SpkiDer: der}
}

func TestBatchApproval(t *testing.T) {
	// The signing input matches the golden framing (signing.json "batch-approval").
	a := &agentv1.BatchApproval{
		BatchId:   "batch_01k5w000000000000000000001",
		ScopeRoot: bytes.Repeat([]byte{0xab}, 32),
		ScopeSize: 412,
		NotAfter:  &timestamppb.Timestamp{Seconds: 0x6ab3bf40, Nanos: 500},
	}
	if data, err := os.ReadFile("../../../packages/protocol/golden/signing.json"); err == nil {
		var vectors []struct {
			Name  string `json:"name"`
			Input string `json:"input"`
		}
		_ = json.Unmarshal(data, &vectors)
		for _, v := range vectors {
			if v.Name == "batch-approval" && hex.EncodeToString(BatchApprovalInput(a, testTrustDomain)) != v.Input {
				t.Fatalf("batch-approval input = %x\ngolden              %s", BatchApprovalInput(a, testTrustDomain), v.Input)
			}
		}
	}

	now := time.Unix(0x6ab3bf40, 0).Add(-time.Hour)
	var keys []*commonv1.ApproverKey
	var sigs []*commonv1.Signature
	for i := 0; i < 3; i++ {
		k, _ := GenerateKey()
		key := approverKeyFor(t, k)
		keys = append(keys, key)
		sig, _ := SignP1363(k, BatchApprovalInput(a, testTrustDomain))
		sigs = append(sigs, &commonv1.Signature{Kid: key.Kid, Sig: sig})
	}
	bundle := &commonv1.TrustBundle{ApproverKeys: keys, ApproverThreshold: 2,
		QuorumTiers: []*commonv1.QuorumTier{{MaxScopeSize: 10, Threshold: 1}, {MaxScopeSize: 1000, Threshold: 3}}}

	// 412 leaves fall in the second tier: three distinct approvers.
	a.Signatures = sigs[:2]
	if err := VerifyBatchApproval(a, bundle, now, testTrustDomain); err == nil {
		t.Fatal("two signatures passed a three-approver tier")
	}
	a.Signatures = []*commonv1.Signature{sigs[0], sigs[0], sigs[1], sigs[1]}
	if err := VerifyBatchApproval(a, bundle, now, testTrustDomain); err == nil {
		t.Fatal("duplicate signatures counted twice")
	}
	a.Signatures = sigs
	if err := VerifyBatchApproval(a, bundle, now, testTrustDomain); err != nil {
		t.Fatal(err)
	}
	// Signed for this deployment only: another trust domain (or none) admits nothing.
	if VerifyBatchApproval(a, bundle, now, "compute.staging.test") == nil || VerifyBatchApproval(a, bundle, now, "") == nil {
		t.Fatal("an approval crossed deployments")
	}
	if err := VerifyBatchApproval(a, bundle, time.Unix(0x6ab3bf40, 500), testTrustDomain); err == nil {
		t.Fatal("an expired approval passed")
	}
	// A signature over other bytes, or by a key whose kid is not its SPKI hash, counts for nothing.
	other := proto.Clone(a).(*agentv1.BatchApproval)
	other.ScopeSize = 411
	if err := VerifyBatchApproval(other, bundle, now, testTrustDomain); err == nil {
		t.Fatal("signatures over another scope size were accepted")
	}
	mislabelled := proto.Clone(bundle).(*commonv1.TrustBundle)
	mislabelled.ApproverKeys[2].Kid = keys[0].Kid
	if err := VerifyBatchApproval(a, mislabelled, now, testTrustDomain); err == nil {
		t.Fatal("a mislabelled approver key counted")
	}
	// Past every tier: approver_threshold.
	if QuorumThreshold(bundle, 5000) != 2 || QuorumThreshold(bundle, 3) != 1 {
		t.Fatal("quorum thresholds")
	}
	// No threshold for the batch's size admits nothing, however many sign.
	if err := VerifyBatchApproval(a, &commonv1.TrustBundle{ApproverKeys: keys}, now, testTrustDomain); err == nil {
		t.Fatal("a zero threshold admitted a batch")
	}
}

// testdata/quorum.json (scripts/daemon-quorum-fixture.mjs): an approver set's canonical bytes and
// signing input as @better-compute/protocol builds them.
func TestApproverSetInputMatchesTheProtocol(t *testing.T) {
	data, err := os.ReadFile("testdata/quorum.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Version string `json:"version"`
		Keys    []struct {
			Kid     string `json:"kid"`
			SpkiDer string `json:"spkiDer"`
		} `json:"keys"`
		ApproverThreshold uint32 `json:"approverThreshold"`
		QuorumTiers       []struct {
			MaxScopeSize uint32 `json:"maxScopeSize"`
			Threshold    uint32 `json:"threshold"`
		} `json:"quorumTiers"`
		UnbatchedDestructivePerHour uint32 `json:"unbatchedDestructivePerHour"`
		ApproverSetInput            string `json:"approverSetInput"`
		SigningInput                string `json:"signingInput"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	version, _ := strconv.ParseUint(f.Version, 10, 64)
	b := &commonv1.TrustBundle{Version: version, ApproverThreshold: f.ApproverThreshold, UnbatchedDestructivePerHour: f.UnbatchedDestructivePerHour}
	for _, k := range f.Keys {
		b.ApproverKeys = append(b.ApproverKeys, &commonv1.ApproverKey{Kid: k.Kid, SpkiDer: unhex(t, k.SpkiDer)})
	}
	for _, tier := range f.QuorumTiers {
		b.QuorumTiers = append(b.QuorumTiers, &commonv1.QuorumTier{MaxScopeSize: tier.MaxScopeSize, Threshold: tier.Threshold})
	}
	if got := hex.EncodeToString(ApproverSetInput(b)); got != f.ApproverSetInput {
		t.Fatalf("approver set input = %s\nprotocol             %s", got, f.ApproverSetInput)
	}
	if got := hex.EncodeToString(ApproverSetSigningInput(b)); got != f.SigningInput {
		t.Fatalf("approver set signing input = %s\nprotocol                     %s", got, f.SigningInput)
	}
}

// Once approvers exist, the quorum changes only with k of the CURRENT approvers' signatures over the
// new set; a daemon without approvers takes the first set as it comes.
func TestApproverSetChanges(t *testing.T) {
	var privs []*ecdsa.PrivateKey
	var keys []*commonv1.ApproverKey
	for i := 0; i < 3; i++ {
		k, _ := GenerateKey()
		privs = append(privs, k)
		keys = append(keys, approverKeyFor(t, k))
	}
	current := &commonv1.TrustBundle{Version: 4, ApproverKeys: keys, ApproverThreshold: 2}
	if VerifyApproverSet(nil, current) != nil || VerifyApproverSet(&commonv1.TrustBundle{}, current) != nil {
		t.Fatal("a first approver set was refused")
	}
	same := proto.Clone(current).(*commonv1.TrustBundle)
	same.Version, same.CommandSigningRoots = 5, [][]byte{{1}}
	if err := VerifyApproverSet(current, same); err != nil {
		t.Fatalf("a roots-only change was refused: %v", err)
	}
	outsider, _ := GenerateKey()
	next := &commonv1.TrustBundle{Version: 5, ApproverKeys: []*commonv1.ApproverKey{approverKeyFor(t, outsider)}, ApproverThreshold: 1}
	sign := func(b *commonv1.TrustBundle, by ...*ecdsa.PrivateKey) {
		b.ApproverSetSignatures = nil
		for _, k := range by {
			sig, _ := SignP1363(k, ApproverSetSigningInput(b))
			b.ApproverSetSignatures = append(b.ApproverSetSignatures, &commonv1.Signature{Kid: approverKeyFor(t, k).Kid, Sig: sig})
		}
	}
	sign(next, outsider)
	if VerifyApproverSet(current, next) == nil {
		t.Fatal("the new set's own key changed the set")
	}
	sign(next, privs[0], privs[0])
	if VerifyApproverSet(current, next) == nil {
		t.Fatal("one approver, twice, changed the set")
	}
	sign(next, privs[0], privs[2])
	if err := VerifyApproverSet(current, next); err != nil {
		t.Fatalf("two current approvers could not change the set: %v", err)
	}
	// The signatures bind the version: replayed onto another version they count for nothing.
	replay := proto.Clone(next).(*commonv1.TrustBundle)
	replay.Version = 6
	if VerifyApproverSet(current, replay) == nil {
		t.Fatal("approver-set signatures were replayed onto another version")
	}
	// Removing every approver is a change like any other.
	drop := &commonv1.TrustBundle{Version: 5}
	if VerifyApproverSet(current, drop) == nil {
		t.Fatal("the approvers were dropped without their signatures")
	}
	sign(drop, privs[1], privs[2])
	if err := VerifyApproverSet(current, drop); err != nil {
		t.Fatalf("the approvers could not stand down: %v", err)
	}
}
