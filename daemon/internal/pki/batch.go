package pki

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
)

// Destructive-batch quorum (PLAN.md §13, v1.0): operators approve a batch of destructive commands
// as a Merkle scope of (subject, kind) leaves; a daemon runs a batched destructive command only with
// k-of-n approver signatures over the scope and an inclusion proof of its own leaf.
//
//	leaf = H(0x00 ‖ lp(batch_id) ‖ lp(subject) ‖ lp(kind)),  node = H(0x01 ‖ left ‖ right)
//
// with lp(x) = uint32_be(len(x)) ‖ x and an odd node promoted unchanged to the next level.

func lp(b []byte) []byte {
	out := make([]byte, 4, 4+len(b))
	binary.BigEndian.PutUint32(out, uint32(len(b)))
	return append(out, b...)
}

// BatchLeaf is the scope leaf of one (subject, kind) in a batch.
func BatchLeaf(batchID, subject, kind string) []byte {
	h := sha256.New()
	h.Write([]byte{0x00})
	h.Write(lp([]byte(batchID)))
	h.Write(lp([]byte(subject)))
	h.Write(lp([]byte(kind)))
	return h.Sum(nil)
}

func batchNode(left, right []byte) []byte {
	h := sha256.New()
	h.Write([]byte{0x01})
	h.Write(left)
	h.Write(right)
	return h.Sum(nil)
}

// VerifyBatchProof walks from the leaf at index up to root in a tree of size leaves. Siblings are
// given from the leaf level up; a node promoted unchanged (the last of an odd level) consumes none.
// Every sibling must be used.
func VerifyBatchProof(leaf []byte, index, size uint32, siblings [][]byte, root []byte) bool {
	if size == 0 || index >= size {
		return false
	}
	hash, i, n, next := leaf, index, size, 0
	for n > 1 {
		switch {
		case i%2 == 1:
			if next >= len(siblings) || len(siblings[next]) != sha256.Size {
				return false
			}
			hash = batchNode(siblings[next], hash)
			next++
		case i+1 < n:
			if next >= len(siblings) || len(siblings[next]) != sha256.Size {
				return false
			}
			hash = batchNode(hash, siblings[next])
			next++
		}
		i, n = i/2, (n+1)/2
	}
	return next == len(siblings) && bytes.Equal(hash, root)
}

// ApproverKid is the kid an approver key is named by: base64url (no padding) SHA-256 of its SPKI.
func ApproverKid(spkiDER []byte) string {
	sum := sha256.Sum256(spkiDER)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// BatchApprovalInput is what approvers sign: purpose "batch-approval", parts [batch_id, scope_root,
// uint32_be(scope_size), int64_be(not_after.seconds) ‖ int32_be(not_after.nanos)].
func BatchApprovalInput(a *agentv1.BatchApproval) []byte {
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], a.GetScopeSize())
	var until [12]byte
	binary.BigEndian.PutUint64(until[:8], uint64(a.GetNotAfter().GetSeconds()))
	binary.BigEndian.PutUint32(until[8:], uint32(a.GetNotAfter().GetNanos()))
	return SigningInput(PurposeBatchApproval, []byte(a.GetBatchId()), a.GetScopeRoot(), size[:], until[:])
}

// QuorumThreshold is the number of distinct approver signatures a batch of size leaves needs: the
// first tier whose max_scope_size covers it, else approver_threshold; never fewer than one.
func QuorumThreshold(b *commonv1.TrustBundle, size uint32) int {
	threshold := b.GetApproverThreshold()
	for _, tier := range b.GetQuorumTiers() {
		if size <= tier.GetMaxScopeSize() {
			threshold = tier.GetThreshold()
			break
		}
	}
	return max(int(threshold), 1)
}

// VerifyBatchApproval checks an approval against the bundle's approver keys at server time now: not
// expired, and signed by at least QuorumThreshold distinct approver keys (a signature's kid must be
// the SHA-256 of an approver key's SPKI; duplicates and unknown kids count for nothing).
func VerifyBatchApproval(a *agentv1.BatchApproval, b *commonv1.TrustBundle, now time.Time) error {
	if a == nil || a.GetBatchId() == "" || len(a.GetScopeRoot()) != sha256.Size || a.GetScopeSize() == 0 {
		return errors.New("pki: no batch approval")
	}
	if a.GetNotAfter() == nil || !now.Before(a.GetNotAfter().AsTime()) {
		return errors.New("pki: the batch approval expired")
	}
	keys := map[string]*ecdsa.PublicKey{}
	for _, k := range b.GetApproverKeys() {
		pub, err := x509.ParsePKIXPublicKey(k.GetSpkiDer())
		if err != nil {
			continue
		}
		if ec, ok := pub.(*ecdsa.PublicKey); ok && ApproverKid(k.GetSpkiDer()) == k.GetKid() {
			keys[k.GetKid()] = ec
		}
	}
	input := BatchApprovalInput(a)
	valid := map[string]bool{}
	for _, sig := range a.GetSignatures() {
		key := keys[sig.GetKid()]
		if key != nil && !valid[sig.GetKid()] && VerifyP1363(key, input, sig.GetSig()) {
			valid[sig.GetKid()] = true
		}
	}
	if need := QuorumThreshold(b, a.GetScopeSize()); len(valid) < need {
		return fmt.Errorf("pki: the batch approval has %d of the %d approver signatures it needs", len(valid), need)
	}
	return nil
}
