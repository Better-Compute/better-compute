package pki

import (
	"bytes"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// packages/protocol/golden/batch-scope.json: the leaves, proofs and root @better-compute/protocol
// builds for a 3-leaf batch (one promoted odd node).
func TestBatchScopeGolden(t *testing.T) {
	data, err := os.ReadFile("../../../packages/protocol/golden/batch-scope.json")
	if err != nil {
		t.Skipf("goldens not available: %v", err)
	}
	var golden struct {
		BatchID string `json:"batchId"`
		Root    string `json:"root"`
		Leaves  []struct {
			Index     uint32   `json:"index"`
			NodeID    string   `json:"nodeId"`
			Kind      string   `json:"kind"`
			LeafInput string   `json:"leafInput"`
			Hash      string   `json:"hash"`
			Siblings  []string `json:"siblings"`
		} `json:"leaves"`
	}
	if err := json.Unmarshal(data, &golden); err != nil {
		t.Fatal(err)
	}
	root := unhex(t, golden.Root)
	size := uint32(len(golden.Leaves))
	for _, l := range golden.Leaves {
		leaf := BatchLeaf(golden.BatchID, l.NodeID, l.Kind)
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
		// Anything else does not: another index, another kind, a dropped or extra sibling. (The size
		// comes from the signed approval, never from the command.)
		if VerifyBatchProof(leaf, (l.Index+1)%size, size, siblings, root) ||
			VerifyBatchProof(BatchLeaf(golden.BatchID, l.NodeID, "gpu.reset"), l.Index, size, siblings, root) ||
			VerifyBatchProof(leaf, l.Index, size, siblings[:len(siblings)-1], root) ||
			VerifyBatchProof(leaf, l.Index, size, append(append([][]byte{}, siblings...), root), root) {
			t.Fatalf("leaf %d proves more than it should", l.Index)
		}
	}
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
			if v.Name == "batch-approval" && hex.EncodeToString(BatchApprovalInput(a)) != v.Input {
				t.Fatalf("batch-approval input = %x\ngolden              %s", BatchApprovalInput(a), v.Input)
			}
		}
	}

	now := time.Unix(0x6ab3bf40, 0).Add(-time.Hour)
	var keys []*commonv1.ApproverKey
	var sigs []*commonv1.Signature
	for i := 0; i < 3; i++ {
		k, _ := GenerateKey()
		der, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
		keys = append(keys, &commonv1.ApproverKey{Kid: ApproverKid(der), SpkiDer: der})
		sig, _ := SignP1363(k, BatchApprovalInput(a))
		sigs = append(sigs, &commonv1.Signature{Kid: ApproverKid(der), Sig: sig})
	}
	bundle := &commonv1.TrustBundle{ApproverKeys: keys, ApproverThreshold: 2,
		QuorumTiers: []*commonv1.QuorumTier{{MaxScopeSize: 10, Threshold: 1}, {MaxScopeSize: 1000, Threshold: 3}}}

	// 412 leaves fall in the second tier: three distinct approvers.
	a.Signatures = sigs[:2]
	if err := VerifyBatchApproval(a, bundle, now); err == nil {
		t.Fatal("two signatures passed a three-approver tier")
	}
	a.Signatures = []*commonv1.Signature{sigs[0], sigs[0], sigs[1], sigs[1]}
	if err := VerifyBatchApproval(a, bundle, now); err == nil {
		t.Fatal("duplicate signatures counted twice")
	}
	a.Signatures = sigs
	if err := VerifyBatchApproval(a, bundle, now); err != nil {
		t.Fatal(err)
	}
	if err := VerifyBatchApproval(a, bundle, time.Unix(0x6ab3bf40, 500)); err == nil {
		t.Fatal("an expired approval passed")
	}
	// A signature over other bytes, or by a key whose kid is not its SPKI hash, counts for nothing.
	other := *a
	other.ScopeSize = 411
	if err := VerifyBatchApproval(&other, bundle, now); err == nil {
		t.Fatal("signatures over another scope size were accepted")
	}
	bundle.ApproverKeys[2].Kid = keys[0].Kid
	if err := VerifyBatchApproval(a, bundle, now); err == nil {
		t.Fatal("a mislabelled approver key counted")
	}
	// Past every tier: approver_threshold; a zero threshold still needs one.
	if QuorumThreshold(bundle, 5000) != 2 || QuorumThreshold(&commonv1.TrustBundle{}, 1) != 1 || QuorumThreshold(bundle, 3) != 1 {
		t.Fatal("quorum thresholds")
	}
}
