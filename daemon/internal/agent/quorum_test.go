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

// testTrustDomain is the harness node's trust domain, which approvals are signed for.
const testTrustDomain = "compute.test"

// scope builds a batch's Merkle scope as the control plane does (leaves sorted by hash, an odd node
// promoted) and returns its root and each leaf's proof, keyed by subject+"|"+kind (+"|bound" for a
// leaf bound to a payload: items may carry a third element, the payload the leaf binds).
func scope(batchID string, items [][]any) ([]byte, map[string]*agentv1.BatchProof) {
	type leaf struct {
		hash []byte
		key  string
	}
	var leaves []leaf
	for _, it := range items {
		subject, kind := it[0].(string), it[1].(string)
		var digest []byte
		key := subject + "|" + kind
		if len(it) > 2 {
			value, _ := proto.Marshal(it[2].(proto.Message))
			sum := sha256.Sum256(value)
			digest, key = sum[:], key+"|bound"
		}
		leaves = append(leaves, leaf{pki.BatchLeaf(batchID, subject, kind, digest), key})
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
		sig, _ := pki.SignP1363(k, pki.BatchApprovalInput(approval, testTrustDomain))
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
	h := newHarness(t, func(o *Options) { o.State.TrustBundle, o.State.TrustDomain = raw, testTrustDomain })
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

	root, proofs := scope("batch_1", [][]any{{testNode, "gpu.reset"}, {"node_other", "gpu.reset"}, {testNode, "disk.wipe"}})
	mine := proofs[testNode+"|gpu.reset"]

	// Two of three approvers and this node's (unbound) leaf: it runs, once.
	s.push(batched(reset("q1", "batch_1"), quorum.approve("batch_1", root, 3, 2), mine))
	s.update(t, "q1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	s.push(batched(reset("q1b", "batch_1"), quorum.approve("batch_1", root, 3, 2), mine))
	rejected("q1b", commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BATCH_UNAPPROVED)

	// A leaf bound to one payload admits that payload and no other.
	bound := &agentv1.GpuResetRequest{GpuUuids: []string{"GPU-bound"}}
	broot, bproofs := scope("batch_b", [][]any{{testNode, "gpu.reset", bound}, {"node_other", "gpu.reset"}})
	exact := body("b1", "gpu.reset", bound)
	exact.BatchId = "batch_b"
	s.push(batched(exact, quorum.approve("batch_b", broot, 2, 2), bproofs[testNode+"|gpu.reset|bound"]))
	s.update(t, "b1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	swapped := body("b2", "gpu.reset", &agentv1.GpuResetRequest{GpuUuids: []string{"GPU-other"}})
	swapped.BatchId = "batch_b"
	s.push(batched(swapped, quorum.approve("batch_b", broot, 2, 2), bproofs[testNode+"|gpu.reset|bound"]))
	rejected("b2", commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BATCH_UNAPPROVED)
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
	h := newHarness(t, func(o *Options) {
		o.State.Role, o.State.TrustBundle, o.State.TrustDomain = "site", raw, testTrustDomain
	})
	s, _ := h.open()
	// BMC addresses are site-local: the subject names this site agent too.
	root, proofs := scope("batch_bmc", [][]any{{"bmc:" + testNode + "/10.0.0.9", "bmc.power"}, {"bmc:node_other_site/10.0.0.10", "bmc.power"}})
	approval := quorum.approve("batch_bmc", root, 2, 1)
	power := func(id, address string) *agentv1.CommandBody {
		b := body(id, "bmc.power", &sitev1.BmcOperationRequest{Driver: "redfish", Address: address, CredentialsRef: "secret://t/bmc", Operation: "power.setPower", ArgsJson: `{"action":"off"}`})
		b.BatchId = "batch_bmc"
		return b
	}
	// The approved BMC's own proof admits it (it then fetches its credentials).
	s.push(batched(power("p1", "10.0.0.9"), approval, proofs["bmc:"+testNode+"/10.0.0.9|bmc.power"]))
	s.update(t, "p1", commonv1.CommandState_COMMAND_STATE_ACKED)
	// Another BMC with the approved one's proof: refused.
	s.push(batched(power("p2", "10.0.0.8"), approval, proofs["bmc:"+testNode+"/10.0.0.9|bmc.power"]))
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

// welcomeWithTrust accepts the agent's next session and welcomes it with a trust bundle signed by
// join (the JoinService key the agent pins).
func welcomeWithTrust(t *testing.T, h *harness, join *signer, bundle *commonv1.TrustBundle) *fakeStream {
	t.Helper()
	s := h.gw.accept()
	s.next(t, "Hello", func(f *agentv1.AgentFrame) bool { return f.GetHello() != nil })
	body, _ := proto.Marshal(bundle)
	w := welcome()
	w.GetWelcome().Trust = &commonv1.SignedTrustBundle{Body: body, Signature: join.sign(t, pki.PurposeTrustBundle, body)}
	s.push(w)
	return s
}

// heldBundle waits until the agent holds trust bundle version, and returns it.
func heldBundle(t *testing.T, h *harness, version uint64) *commonv1.TrustBundle {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		h.agent.mu.Lock()
		b, _ := h.agent.trustBundleLocked()
		held := h.agent.state.TrustVersion
		h.agent.mu.Unlock()
		if held == version {
			return b
		}
		if time.Now().After(deadline) {
			t.Fatalf("trust version %d, want %d", held, version)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A bundle whose approver set is refused still brings its roots and version; the quorum stays.
func TestRefusedApproverSetKeepsTheQuorum(t *testing.T) {
	quorum := newApprovers(t, 3, 2, 1)
	quorum.bundle.ApproverSetEpoch = 1
	raw, _ := proto.Marshal(quorum.bundle)
	join := newSigner(t, "join")
	pin, _ := pki.SPKISHA256(&join.key.PublicKey)
	h := newHarness(t, func(o *Options) {
		o.State.TrustBundle, o.State.TrustDomain, o.State.TrustVersion = raw, testTrustDomain, 2
		o.SignerPin = pin
		o.Backoff.Min, o.Backoff.Max = time.Millisecond, 10*time.Millisecond
	})
	outsider := newApprovers(t, 1, 1, 5)
	next := proto.Clone(outsider.bundle).(*commonv1.TrustBundle)
	next.Version, next.ApproverSetEpoch, next.CommandSigningRoots = 3, 2, [][]byte{join.chain[0]}
	s := welcomeWithTrust(t, h, join, next)
	held := heldBundle(t, h, 3)
	if len(held.GetCommandSigningRoots()) != 1 || held.GetApproverSetEpoch() != 1 || len(held.GetApproverKeys()) != 3 || held.GetApproverThreshold() != 2 {
		t.Fatalf("held bundle = %v", held)
	}

	// Signed by two current approvers for this trust domain at a higher epoch: taken.
	next.Version = 4
	next.ApproverSetSignatures = nil
	for _, k := range quorum.keys[:2] {
		der, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
		sig, _ := pki.SignP1363(k, pki.ApproverSetSigningInput(next, testTrustDomain))
		next.ApproverSetSignatures = append(next.ApproverSetSignatures, &commonv1.Signature{Kid: pki.ApproverKid(der), Sig: sig})
	}
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Drain{Drain: &agentv1.Drain{ReconnectAfterMs: 1}}})
	welcomeWithTrust(t, h, join, next)
	if held := heldBundle(t, h, 4); held.GetApproverSetEpoch() != 2 || len(held.GetApproverKeys()) != 1 {
		t.Fatalf("held bundle = %v", held)
	}
}

// review 7 M2: installed with approver_set_sha256, a keyless daemon takes only that set, and runs no
// destructive command until it holds it.
func TestPinnedApproverSet(t *testing.T) {
	quorum := newApprovers(t, 2, 1, 0)
	join := newSigner(t, "join")
	pin, _ := pki.SPKISHA256(&join.key.PublicKey)
	h := newHarness(t, func(o *Options) {
		o.State.TrustDomain = testTrustDomain
		o.SignerPin = pin
		o.ApproverSetPin = pki.ApproverSetSHA256(quorum.bundle)
		o.Backoff.Min, o.Backoff.Max = time.Millisecond, 10*time.Millisecond
	})
	other := newApprovers(t, 1, 1, 9)
	other.bundle.Version = 1
	s := welcomeWithTrust(t, h, join, other.bundle)
	if held := heldBundle(t, h, 1); len(held.GetApproverKeys()) != 0 {
		t.Fatalf("an unpinned set was taken: %v", held)
	}
	s.push(command(body("x1", "gpu.reset", &agentv1.GpuResetRequest{GpuUuids: []string{"GPU-missing"}})))
	if u := s.update(t, "x1", commonv1.CommandState_COMMAND_STATE_REJECTED); u.GetRejectReason() != commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BATCH_UNAPPROVED {
		t.Fatalf("x1 = %v", u)
	}
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Drain{Drain: &agentv1.Drain{ReconnectAfterMs: 1}}})
	quorum.bundle.Version = 2
	welcomeWithTrust(t, h, join, quorum.bundle)
	if held := heldBundle(t, h, 2); len(held.GetApproverKeys()) != 2 {
		t.Fatalf("the pinned set was refused: %v", held)
	}
}

// review 9 HIGH-3(d): under a quorum, a site.httpProxy write runs only under a leaf bound to its
// payload; unbatched break-glass and "any payload" leaves cover GETs only.
func TestProxyWritesNeedABoundLeaf(t *testing.T) {
	quorum := newApprovers(t, 1, 1, 5)
	raw, _ := proto.Marshal(quorum.bundle)
	h := newHarness(t, func(o *Options) {
		o.State.Role, o.State.TrustBundle, o.State.TrustDomain = "site", raw, testTrustDomain
	})
	s, _ := h.open()
	get := &sitev1.HttpProxyRequest{TargetNodeId: "node_1", Url: "https://10.0.0.5/ready"}
	post := &sitev1.HttpProxyRequest{TargetNodeId: "node_1", Url: "https://10.0.0.5/reset", Method: "POST"}
	proxy := func(id, batch string, req *sitev1.HttpProxyRequest) *agentv1.CommandBody {
		b := body(id, "site.httpProxy", req)
		b.BatchId = batch
		return b
	}
	rejected := func(id string) {
		t.Helper()
		if u := s.update(t, id, commonv1.CommandState_COMMAND_STATE_REJECTED); u.GetRejectReason() != commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BATCH_UNAPPROVED {
			t.Fatalf("%s = %v", id, u)
		}
	}
	s.push(command(proxy("g1", "", get)))
	s.update(t, "g1", commonv1.CommandState_COMMAND_STATE_ACKED)
	s.push(command(proxy("w1", "", post)))
	rejected("w1")

	root, proofs := scope("batch_p", [][]any{{"node:node_1", "site.httpProxy"}, {"node:node_1", "site.httpProxy", post}})
	approval := quorum.approve("batch_p", root, 2, 1)
	s.push(batched(proxy("w2", "batch_p", post), approval, proofs["node:node_1|site.httpProxy"]))
	rejected("w2")
	s.push(batched(proxy("w3", "batch_p", post), approval, proofs["node:node_1|site.httpProxy|bound"]))
	s.update(t, "w3", commonv1.CommandState_COMMAND_STATE_ACKED)
	s.push(batched(proxy("g2", "batch_p", get), approval, proofs["node:node_1|site.httpProxy"]))
	s.update(t, "g2", commonv1.CommandState_COMMAND_STATE_ACKED)
}

// review 10 M5: Hello reports the held approver set's epoch and digest, so a node stuck on an old
// quorum shows up.
func TestHelloReportsTheHeldApproverSet(t *testing.T) {
	quorum := newApprovers(t, 2, 1, 0)
	quorum.bundle.ApproverSetEpoch = 3
	raw, _ := proto.Marshal(quorum.bundle)
	h := newHarness(t, func(o *Options) { o.State.TrustBundle, o.State.TrustDomain = raw, testTrustDomain })
	_, hello := h.open()
	if hello.GetApproverSetEpoch() != 3 || !bytes.Equal(hello.GetApproverSetSha256(), pki.ApproverSetSHA256(quorum.bundle)) {
		t.Fatalf("hello = epoch %d, sha %x", hello.GetApproverSetEpoch(), hello.GetApproverSetSha256())
	}
}
