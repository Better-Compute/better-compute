package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	sitev1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/site/v1"
	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/proto"
)

// The destructive-batch quorum (PLAN.md §13, v1.0). With approver keys in the trust bundle, a
// destructive command (the daemon's own kind table decides) carrying a batch_id runs only with a
// BatchApproval of enough distinct approver signatures for this deployment's trust domain,
// unexpired, and a proof that its own leaf (batch, subject, kind, payload digest, or the unbound
// leaf without a digest) is in the approved scope, and each leaf runs at most once per batch:
// BATCH_UNAPPROVED otherwise. One without a
// batch_id is break-glass, capped per rolling hour (unbatched_destructive_per_hour, default 0):
// UNBATCHED_LIMIT beyond it. The count survives restarts.

// intentVerdict is what the signed-intent checks say about one delivery.
type intentVerdict struct {
	badSig bool
	// quorum is BATCH_UNAPPROVED, or "".
	quorum dispatch.Rejection
	// unbatched: a destructive command without a batch id under an approver quorum (the hourly cap
	// is checked, and the command counted, at admission).
	unbatched bool
	// leaf is the batch leaf the command proved (hex), recorded once it is accepted, until the
	// approval's not_after: it runs at most once per batch.
	leaf      string
	leafUntil time.Time
}

// batchLeavesFile holds the batch leaves that ran (leaf hex → command id, until when it matters).
const batchLeavesFile = "batch-leaves.json"

type ranLeaf struct {
	Command string    `json:"command"`
	Until   time.Time `json:"until"`
}

// ranLeavesLocked reads the leaves that ran and still matter (their approval has not expired).
func (a *Agent) ranLeavesLocked(now time.Time) map[string]ranLeaf {
	ran := map[string]ranLeaf{}
	if raw, err := os.ReadFile(filepath.Join(a.o.DataDir, batchLeavesFile)); err == nil {
		_ = json.Unmarshal(raw, &ran)
	}
	for leaf, r := range ran {
		if !now.Before(r.Until) {
			delete(ran, leaf)
		}
	}
	return ran
}

// recordLeafLocked stores that a command ran a batch leaf.
func (a *Agent) recordLeafLocked(leaf, command string, until time.Time) {
	ran := a.ranLeavesLocked(a.serverNowLocked())
	ran[leaf] = ranLeaf{Command: command, Until: until}
	raw, _ := json.Marshal(ran)
	if err := pki.WriteFileAtomic(filepath.Join(a.o.DataDir, batchLeavesFile), raw, 0o600); err != nil {
		a.log.Error("store the batch leaves that ran", "error", err.Error())
	}
}

// unbatchedFile holds the unbatched destructive commands of the last hour (command id → local
// time: a gateway moving server time forward must not age them out).
const unbatchedFile = "unbatched-destructive.json"

// trustBundleLocked is the stored trust bundle (nil: none). ok is false when one is stored but
// cannot be read: the quorum then refuses every destructive command rather than switching off.
func (a *Agent) trustBundleLocked() (b *commonv1.TrustBundle, ok bool) {
	if len(a.state.TrustBundle) == 0 {
		return nil, true
	}
	b = &commonv1.TrustBundle{}
	if proto.Unmarshal(a.state.TrustBundle, b) != nil {
		return nil, false
	}
	return b, true
}

// commandSubject is what a command acts on, from its signed body: the BMC a site agent drives
// ("bmc:" + the site agent's own node id + "/" + address: BMC addresses are site-local), the node a
// site.httpProxy request reaches ("node:" + target), or the node itself.
func commandSubject(cmd dispatch.Command) (string, error) {
	switch {
	case strings.HasPrefix(cmd.Kind, "bmc."):
		req := &sitev1.BmcOperationRequest{}
		if err := payloadOf(cmd, req); err != nil || req.GetAddress() == "" {
			return "", errors.New("a BMC command without its BMC address")
		}
		return "bmc:" + cmd.NodeID + "/" + req.GetAddress(), nil
	case cmd.Kind == "site.httpProxy":
		req := &sitev1.HttpProxyRequest{}
		if err := payloadOf(cmd, req); err != nil || req.GetTargetNodeId() == "" {
			return "", errors.New("a proxy request without its target node")
		}
		return "node:" + req.GetTargetNodeId(), nil
	}
	return cmd.NodeID, nil
}

// quorumVerdict checks a destructive command's batch approval, or reports it unbatched.
func (a *Agent) quorumVerdict(c *agentv1.Command, body *agentv1.CommandBody, cmd dispatch.Command) intentVerdict {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.intentLocked(c, body, cmd)
}

// intentLocked is the quorum part of the intent verdict, with a.mu held.
func (a *Agent) intentLocked(c *agentv1.Command, body *agentv1.CommandBody, cmd dispatch.Command) intentVerdict {
	var v intentVerdict
	v.quorum, v.unbatched = a.quorumVerdictLocked(c, body, cmd, &v.leaf, &v.leafUntil)
	return v
}

// quorumVerdictLocked is quorumVerdict with a.mu held (a deferred command is checked again at
// admission: its approval may have expired meanwhile).
func (a *Agent) quorumVerdictLocked(c *agentv1.Command, body *agentv1.CommandBody, cmd dispatch.Command, leafOut *string, leafUntil *time.Time) (dispatch.Rejection, bool) {
	if k := a.kinds[body.GetKind()]; k == nil || !k.Destructive {
		return "", false
	}
	bundle, ok := a.trustBundleLocked()
	if !ok {
		a.log.Error("the stored trust bundle is unreadable; destructive commands are refused", "id", body.GetId())
		return dispatch.RejectBatchUnapproved, false
	}
	if len(bundle.GetApproverKeys()) == 0 {
		if len(a.o.ApproverSetPin) > 0 {
			// Installed with a pinned approver set it has not received yet: no destructive command
			// runs without the quorum the install named.
			a.log.Warn("the pinned approver set has not arrived; destructive commands are refused", "id", body.GetId())
			return dispatch.RejectBatchUnapproved, false
		}
		return "", false
	}
	now := a.serverNowLocked()
	if body.GetBatchId() == "" {
		return "", true
	}
	refuse := func(why string) (dispatch.Rejection, bool) {
		a.log.Warn("batch not approved for this command", "id", body.GetId(), "kind", body.GetKind(), "batch", body.GetBatchId(), "reason", why)
		return dispatch.RejectBatchUnapproved, false
	}
	approval := c.GetBatchApproval()
	if approval.GetBatchId() != body.GetBatchId() {
		return refuse("no approval of this batch")
	}
	// The trust domain is this node's own (from its join), never the message's.
	if err := pki.VerifyBatchApproval(approval, bundle, now, a.state.TrustDomain); err != nil {
		return refuse(err.Error())
	}
	subject, err := commandSubject(cmd)
	if err != nil {
		return refuse(err.Error())
	}
	// The approvers may have bound the leaf to this very payload, or left it unbound ("any payload
	// of this kind"): either proves it.
	proof := c.GetBatchProof()
	var leaf []byte
	var candidates [][]byte
	if value := body.GetPayload().GetValue(); len(value) > 0 {
		digest := sha256.Sum256(value)
		candidates = append(candidates, pki.BatchLeaf(body.GetBatchId(), subject, body.GetKind(), digest[:]))
	}
	candidates = append(candidates, pki.BatchLeaf(body.GetBatchId(), subject, body.GetKind(), nil))
	for _, l := range candidates {
		if pki.VerifyBatchProof(l, proof.GetIndex(), approval.GetScopeSize(), proof.GetSiblings(), approval.GetScopeRoot()) {
			leaf = l
			break
		}
	}
	if leaf == nil {
		return refuse("the command (" + subject + ", " + body.GetKind() + ") is not in the approved scope")
	}
	// Each leaf runs once per batch (the same command re-executed after a restart is not a second run).
	if ran, done := a.ranLeavesLocked(now)[hex.EncodeToString(leaf)]; done && ran.Command != body.GetId() {
		return refuse("this leaf of the batch already ran (command " + ran.Command + ")")
	}
	*leafOut, *leafUntil = hex.EncodeToString(leaf), approval.GetNotAfter().AsTime()
	return "", false
}

// unbatchedLocked reads the last hour's unbatched destructive commands.
func (a *Agent) unbatchedLocked(now time.Time) map[string]time.Time {
	seen := map[string]time.Time{}
	if raw, err := os.ReadFile(filepath.Join(a.o.DataDir, unbatchedFile)); err == nil {
		_ = json.Unmarshal(raw, &seen)
	}
	for id, at := range seen {
		if now.Sub(at) >= time.Hour {
			delete(seen, id)
		}
	}
	return seen
}

// unbatchedAllowedLocked reports whether one more unbatched destructive command fits the hourly
// cap (a command already counted, re-executed after a restart, always does). The hour is this
// host's own: server time, which a gateway can move, never ages the count out.
func (a *Agent) unbatchedAllowedLocked(id string) bool {
	seen := a.unbatchedLocked(time.Now())
	if _, counted := seen[id]; counted {
		return true
	}
	bundle, _ := a.trustBundleLocked()
	return len(seen) < int(bundle.GetUnbatchedDestructivePerHour())
}

// recordUnbatchedLocked counts an accepted unbatched destructive command.
func (a *Agent) recordUnbatchedLocked(id string) {
	now := time.Now()
	seen := a.unbatchedLocked(now)
	seen[id] = now
	raw, _ := json.Marshal(seen)
	if err := pki.WriteFileAtomic(filepath.Join(a.o.DataDir, unbatchedFile), raw, 0o600); err != nil {
		a.log.Error("store the unbatched destructive count", "error", err.Error())
	}
}
