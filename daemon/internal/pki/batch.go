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
	"sort"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
)

// Destructive-batch quorum (PLAN.md §13, v1.0): operators approve a batch of destructive commands
// as a Merkle scope of (subject, kind, payload) leaves; a daemon runs a batched destructive command
// only with k-of-n approver signatures over the scope and an inclusion proof of its own leaf.
//
//	leaf = H(0x00 ‖ lp(batch_id) ‖ lp(subject) ‖ lp(kind) ‖ lp(payload_sha256)),  node = H(0x01 ‖ left ‖ right)
//
// with lp(x) = uint32_be(len(x)) ‖ x and an odd node promoted unchanged to the next level.
// payload_sha256 is SHA-256 of the command's payload (CommandBody.payload.value), or empty for "any
// payload of this kind" (an unbound leaf).

func lp(b []byte) []byte {
	out := make([]byte, 4, 4+len(b))
	binary.BigEndian.PutUint32(out, uint32(len(b)))
	return append(out, b...)
}

// BatchLeaf is the scope leaf of one (subject, kind, payload digest) in a batch; an empty digest is
// the unbound leaf.
func BatchLeaf(batchID, subject, kind string, payloadSha256 []byte) []byte {
	h := sha256.New()
	h.Write([]byte{0x00})
	h.Write(lp([]byte(batchID)))
	h.Write(lp([]byte(subject)))
	h.Write(lp([]byte(kind)))
	h.Write(lp(payloadSha256))
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
// uint32_be(scope_size), int64_be(not_after.seconds) ‖ int32_be(not_after.nanos), trust_domain]. The
// trust domain is the verifier's own (never the message's): an approval for one deployment admits
// nothing in another.
func BatchApprovalInput(a *agentv1.BatchApproval, trustDomain string) []byte {
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], a.GetScopeSize())
	var until [12]byte
	binary.BigEndian.PutUint64(until[:8], uint64(a.GetNotAfter().GetSeconds()))
	binary.BigEndian.PutUint32(until[8:], uint32(a.GetNotAfter().GetNanos()))
	return SigningInput(PurposeBatchApproval, []byte(a.GetBatchId()), a.GetScopeRoot(), size[:], until[:], []byte(trustDomain))
}

// QuorumThreshold is the number of distinct approver signatures a batch of size leaves needs: the
// first tier whose max_scope_size covers it, else approver_threshold. Zero means the bundle names
// no threshold for it, and VerifyBatchApproval then admits nothing (as the TypeScript side does).
func QuorumThreshold(b *commonv1.TrustBundle, size uint32) int {
	threshold := b.GetApproverThreshold()
	for _, tier := range b.GetQuorumTiers() {
		if size <= tier.GetMaxScopeSize() {
			threshold = tier.GetThreshold()
			break
		}
	}
	return int(threshold)
}

// approverKeys are a bundle's approver keys whose kid is their own SPKI's hash.
func approverKeys(b *commonv1.TrustBundle) map[string]*ecdsa.PublicKey {
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
	return keys
}

// countSignatures counts the distinct approver keys with a valid signature over input.
func countSignatures(keys map[string]*ecdsa.PublicKey, sigs []*commonv1.Signature, input []byte) int {
	valid := map[string]bool{}
	for _, sig := range sigs {
		key := keys[sig.GetKid()]
		if key != nil && !valid[sig.GetKid()] && VerifyP1363(key, input, sig.GetSig()) {
			valid[sig.GetKid()] = true
		}
	}
	return len(valid)
}

// VerifyBatchApproval checks an approval against the bundle's approver keys at server time now, for
// this deployment's trust domain: not expired, and signed by at least QuorumThreshold distinct
// approver keys (a signature's kid must be the SHA-256 of an approver key's SPKI; duplicates and
// unknown kids count for nothing).
func VerifyBatchApproval(a *agentv1.BatchApproval, b *commonv1.TrustBundle, now time.Time, trustDomain string) error {
	if trustDomain == "" {
		return errors.New("pki: no trust domain to verify the batch approval for")
	}
	if a == nil || a.GetBatchId() == "" || len(a.GetScopeRoot()) != sha256.Size || a.GetScopeSize() == 0 {
		return errors.New("pki: no batch approval")
	}
	if a.GetNotAfter() == nil || !now.Before(a.GetNotAfter().AsTime()) {
		return errors.New("pki: the batch approval expired")
	}
	need := QuorumThreshold(b, a.GetScopeSize())
	if need == 0 {
		return errors.New("pki: the trust bundle sets no approver threshold for this batch size")
	}
	if got := countSignatures(approverKeys(b), a.GetSignatures(), BatchApprovalInput(a, trustDomain)); got < need {
		return fmt.Errorf("pki: the batch approval has %d of the %d approver signatures it needs", got, need)
	}
	return nil
}

// ApproverSetInput is the canonical form of a bundle's quorum fields (3-6), which approvers sign
// (hashed) to change them: uint32(n) ‖ (lp(kid) ‖ lp(spki_der))* by kid ascending ‖ uint32(threshold)
// ‖ uint32(m) ‖ (uint32(max_scope_size) ‖ uint32(threshold))* in order ‖
// uint32(unbatched_destructive_per_hour).
func ApproverSetInput(b *commonv1.TrustBundle) []byte {
	keys := append([]*commonv1.ApproverKey(nil), b.GetApproverKeys()...)
	sort.Slice(keys, func(i, j int) bool { return keys[i].GetKid() < keys[j].GetKid() })
	u32 := func(v uint32) []byte { return binary.BigEndian.AppendUint32(nil, v) }
	out := u32(uint32(len(keys)))
	for _, k := range keys {
		out = append(out, lp([]byte(k.GetKid()))...)
		out = append(out, lp(k.GetSpkiDer())...)
	}
	out = append(out, u32(b.GetApproverThreshold())...)
	out = append(out, u32(uint32(len(b.GetQuorumTiers())))...)
	for _, t := range b.GetQuorumTiers() {
		out = append(out, u32(t.GetMaxScopeSize())...)
		out = append(out, u32(t.GetThreshold())...)
	}
	return append(out, u32(b.GetUnbatchedDestructivePerHour())...)
}

// ApproverSetSigningInput is what an approver_set_signatures entry signs: purpose "approver-set",
// parts [uint64_be(version), sha256(ApproverSetInput)].
func ApproverSetSigningInput(b *commonv1.TrustBundle) []byte {
	digest := sha256.Sum256(ApproverSetInput(b))
	return SigningInput(PurposeApproverSet, binary.BigEndian.AppendUint64(nil, b.GetVersion()), digest[:])
}

// VerifyApproverSet decides whether next may replace current. A daemon without approver keys takes
// the first set as it comes (it only adds restrictions); one that holds keys accepts a change to
// any quorum field, removal included, only with approver_set_signatures by its CURRENT keys at its
// current threshold (a zero threshold accepts no change).
func VerifyApproverSet(current, next *commonv1.TrustBundle) error {
	if len(current.GetApproverKeys()) == 0 {
		return nil
	}
	if bytes.Equal(ApproverSetInput(current), ApproverSetInput(next)) {
		return nil
	}
	need := int(current.GetApproverThreshold())
	if need == 0 {
		return errors.New("pki: the approver set cannot change: the current set has no threshold")
	}
	if got := countSignatures(approverKeys(current), next.GetApproverSetSignatures(), ApproverSetSigningInput(next)); got < need {
		return fmt.Errorf("pki: the approver set changes with %d of the %d current approver signatures it needs", got, need)
	}
	return nil
}
