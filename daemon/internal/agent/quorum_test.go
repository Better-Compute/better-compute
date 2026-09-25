package agent

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	sitev1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/site/v1"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// scope builds a batch's Merkle scope as the control plane does (leaves sorted by hash, an odd node
// promoted) and returns its root and each leaf's proof, keyed by subject+"|"+kind.
func scope(batchID string, items [][2]string) ([]byte, map[string]*agentv1.BatchProof) {
	type leaf struct {
		hash []byte
		key  string
	}
	var leaves []leaf
	for _, it := range items {
		leaves = append(leaves, leaf{pki.BatchLeaf(batchID, it[0], it[1]), it[0] + "|" + it[1]})
	}
	sort.Slice(leaves, func(i, j int) bool { return bytes.Compare(leaves[i].hash, leaves[j].hash) < 0 })
	level := make([][]byte, len(leaves))
	proofs := map[string]*agentv1.BatchProof{}
	pos := map[string]int{}
	for i, l := range leaves {
		level[i] = l.hash
		proofs[l.key] = &agentv1.BatchProof{Index: uint32(i)}
		pos[l.key] = i
	}
	for len(level) > 1 {
		var next [][]byte
		for i := 0; i < len(level); i += 2 {
			if i+1 == len(level) {
				next = append(next, level[i])
				continue
			}
			h := sha256.New()
			h.Write([]byte{0x01})
			h.Write(level[i])
			h.Write(level[i+1])
			next = append(next, h.Sum(nil))
		}
		for key, p := range pos {
			if sib := p ^ 1; sib < len(level) {
				proofs[key].Siblings = append(proofs[key].Siblings, level[sib])
			}
			pos[key] = p / 2
		}
		level = next
	}
	return level[0], proofs
}

type approvers struct {
	keys   []*ecdsa.PrivateKey
	bundle *commonv1.TrustBundle
}

func newApprovers(t *testing.T, n int, threshold, unbatched uint32) approvers {
	t.Helper()
	a := approvers{bundle: &commonv1.TrustBundle{Version: 2, ApproverThreshold: threshold, UnbatchedDestructivePerHour: unbatched}}
	for i := 0; i < n; i++ {
		k, _ := pki.GenerateKey()
		der, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
		a.keys = append(a.keys, k)
		a.bundle.ApproverKeys = append(a.bundle.ApproverKeys, &commonv1.ApproverKey{Kid: pki.ApproverKid(der), SpkiDer: der})
	}
	return a
}

// approve signs a batch approval with the first `signers` approver keys.
func (a approvers) approve(batchID string, root []byte, size uint32, signers int) *agentv1.BatchApproval {
	approval := &agentv1.BatchApproval{BatchId: batchID, ScopeRoot: root, ScopeSize: size, NotAfter: timestamppb.New(time.Now().Add(time.Hour))}
	for _, k := range a.keys[:signers] {
		der, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
		sig, _ := pki.SignP1363(k, pki.BatchApprovalInput(approval))
		approval.Signatures = append(approval.Signatures, &commonv1.Signature{Kid: pki.ApproverKid(der), Sig: sig})
	}
	return approval
}

func batched(b *agentv1.CommandBody, approval *agentv1.BatchApproval, proof *agentv1.BatchProof) *agentv1.ServerFrame {
	raw, _ := proto.Marshal(b)
	return &agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Command{Command: &agentv1.Command{Body: raw, Attempt: 1, BatchApproval: approval, BatchProof: proof}}}
}

func TestBatchQuorum(t *testing.T) {
	quorum := newApprovers(t, 3, 2, 1)
	raw, _ := proto.Marshal(quorum.bundle)
	h := newHarness(t, func(o *Options) { o.State.TrustBundle = raw })
	s, _ := h.open()
	reset := func(id, batch string) *agentv1.CommandBody {
		b := body(id, "gpu.reset", &agentv1.GpuResetRequest{GpuUuids: []string{"GPU-missing"}})
		b.BatchId = batch
		return b
	}
	rejected := func(id string, want commonv1.CommandRejectReason) {
		t.Helper()
		if u := s.update(t, id, commonv1.CommandState_COMMAND_STATE_REJECTED); u.GetRejectReason() != want {
			t.Fatalf("%s = %v, want %v", id, u, want)
		}
	}

	root, proofs := scope("batch_1", [][2]string{{testNode, "gpu.reset"}, {"node_other", "gpu.reset"}, {testNode, "disk.wipe"}})
	mine := proofs[testNode+"|gpu.reset"]

	// Two of three approvers and this node's leaf: it runs.
	s.push(batched(reset("q1", "batch_1"), quorum.approve("batch_1", root, 3, 2), mine))
	s.update(t, "q1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	// One approver is not a quorum.
	s.push(batched(reset("q2", "batch_1"), quorum.approve("batch_1", root, 3, 1), mine))
	rejected("q2", commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BATCH_UNAPPROVED)
	// Another node's leaf, or no proof, does not admit this node.
	s.push(batched(reset("q3", "batch_1"), quorum.approve("batch_1", root, 3, 2), proofs["node_other|gpu.reset"]))
	rejected("q3", commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BATCH_UNAPPROVED)
	s.push(batched(reset("q4", "batch_1"), quorum.approve("batch_1", root, 3, 2), nil))
	rejected("q4", commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BATCH_UNAPPROVED)
	// An approval of another batch does not carry over.
	s.push(batched(reset("q5", "batch_2"), quorum.approve("batch_1", root, 3, 2), mine))
	rejected("q5", commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BATCH_UNAPPROVED)

	// Unbatched destructive commands: one per rolling hour here, counted durably.
	s.push(command(reset("u1", "")))
	s.update(t, "u1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	s.push(command(reset("u2", "")))
	rejected("u2", commonv1.CommandRejectReason_COMMAND_REJECT_REASON_UNBATCHED_LIMIT)
	if raw, err := os.ReadFile(filepath.Join(h.agent.o.DataDir, unbatchedFile)); err != nil || !bytes.Contains(raw, []byte(`"u1"`)) {
		t.Fatalf("the unbatched count was not stored: %s %v", raw, err)
	}
	// Kinds that are not destructive never need a batch.
	s.push(command(body("l1", "logs.collect", &agentv1.LogsCollectRequest{UploadUrl: "https://127.0.0.1:1/x"})))
	s.update(t, "l1", commonv1.CommandState_COMMAND_STATE_ACKED)
}

// Once approvers exist, a trust bundle signed by the JoinService key alone cannot drop them, swap
// them or weaken their quorum; other fields may change.
func TestTheQuorumIsFrozenOnceSet(t *testing.T) {
	current := newApprovers(t, 2, 2, 0).bundle
	if quorumChange(nil, current) != "" || quorumChange(&commonv1.TrustBundle{}, current) != "" {
		t.Fatal("a first quorum was refused")
	}
	same := proto.Clone(current).(*commonv1.TrustBundle)
	same.Version, same.CommandSigningRoots = 3, [][]byte{{1}}
	if why := quorumChange(current, same); why != "" {
		t.Fatalf("a roots-only change was refused: %s", why)
	}
	for name, change := range map[string]func(b *commonv1.TrustBundle){
		"dropped":   func(b *commonv1.TrustBundle) { b.ApproverKeys = nil },
		"swapped":   func(b *commonv1.TrustBundle) { b.ApproverKeys = newApprovers(t, 1, 1, 0).bundle.ApproverKeys },
		"threshold": func(b *commonv1.TrustBundle) { b.ApproverThreshold = 1 },
		"unbatched": func(b *commonv1.TrustBundle) { b.UnbatchedDestructivePerHour = 100 },
		"tiers": func(b *commonv1.TrustBundle) {
			b.QuorumTiers = []*commonv1.QuorumTier{{MaxScopeSize: 1000, Threshold: 1}}
		},
	} {
		next := proto.Clone(current).(*commonv1.TrustBundle)
		change(next)
		if quorumChange(current, next) == "" {
			t.Errorf("a bundle that %s the quorum was accepted", name)
		}
	}
}

// A stored bundle bcd cannot read never switches the quorum off.
func TestAnUnreadableBundleRefusesDestructiveCommands(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.State.TrustBundle = []byte{0xff, 0xff, 0xff} })
	s, _ := h.open()
	s.push(command(body("x1", "gpu.reset", &agentv1.GpuResetRequest{GpuUuids: []string{"GPU-missing"}})))
	if u := s.update(t, "x1", commonv1.CommandState_COMMAND_STATE_REJECTED); u.GetRejectReason() != commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BATCH_UNAPPROVED {
		t.Fatalf("x1 = %v", u)
	}
}

// A site agent's BMC command is the leaf of the BMC it drives: one approval covers exactly the
// machines it names.
func TestBatchQuorumBindsTheBMC(t *testing.T) {
	quorum := newApprovers(t, 1, 1, 0)
	raw, _ := proto.Marshal(quorum.bundle)
	h := newHarness(t, func(o *Options) { o.State.Role = "site"; o.State.TrustBundle = raw })
	s, _ := h.open()
	root, proofs := scope("batch_bmc", [][2]string{{"bmc:10.0.0.9", "bmc.power"}, {"bmc:10.0.0.10", "bmc.power"}})
	approval := quorum.approve("batch_bmc", root, 2, 1)
	power := func(id, address string) *agentv1.CommandBody {
		b := body(id, "bmc.power", &sitev1.BmcOperationRequest{Driver: "redfish", Address: address, CredentialsRef: "secret://t/bmc", Operation: "power.setPower", ArgsJson: `{"action":"off"}`})
		b.BatchId = "batch_bmc"
		return b
	}
	// The approved BMC's own proof admits it (it then fetches its credentials).
	s.push(batched(power("p1", "10.0.0.9"), approval, proofs["bmc:10.0.0.9|bmc.power"]))
	s.update(t, "p1", commonv1.CommandState_COMMAND_STATE_ACKED)
	// Another BMC with the approved one's proof: refused.
	s.push(batched(power("p2", "10.0.0.8"), approval, proofs["bmc:10.0.0.9|bmc.power"]))
	if u := s.update(t, "p2", commonv1.CommandState_COMMAND_STATE_REJECTED); u.GetRejectReason() != commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BATCH_UNAPPROVED {
		t.Fatalf("p2 = %v", u)
	}
	// No unbatched allowance (0): break-glass is off.
	unbatched := power("p3", "10.0.0.9")
	unbatched.BatchId = ""
	s.push(command(unbatched))
	if u := s.update(t, "p3", commonv1.CommandState_COMMAND_STATE_REJECTED); u.GetRejectReason() != commonv1.CommandRejectReason_COMMAND_REJECT_REASON_UNBATCHED_LIMIT {
		t.Fatalf("p3 = %v", u)
	}
}
