package agent

import (
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
// BatchApproval of enough distinct approver signatures, unexpired, and a proof that its own leaf
// (batch, subject, kind) is in the approved scope: BATCH_UNAPPROVED otherwise. One without a
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

// quorumChange reports why next may not replace current: once approver keys are held, the quorum
// (approver keys, thresholds, tiers, the unbatched cap) changes only with the approvers' own
// signatures, which the trust bundle cannot carry yet, so it does not change at all. A JoinService
// key alone could otherwise drop the approvers or swap in its own.
func quorumChange(current, next *commonv1.TrustBundle) string {
	if len(current.GetApproverKeys()) == 0 {
		return ""
	}
	strip := func(b *commonv1.TrustBundle) *commonv1.TrustBundle {
		return &commonv1.TrustBundle{
			ApproverKeys: b.GetApproverKeys(), ApproverThreshold: b.GetApproverThreshold(),
			UnbatchedDestructivePerHour: b.GetUnbatchedDestructivePerHour(), QuorumTiers: b.GetQuorumTiers(),
		}
	}
	if !proto.Equal(strip(current), strip(next)) {
		return "it changes the approver quorum without the approvers' signatures"
	}
	return ""
}

// commandSubject is what a command acts on, from its signed body: the BMC a site agent drives
// ("bmc:" + address), the node a site.httpProxy request reaches ("node:" + target), or the node
// itself.
func commandSubject(cmd dispatch.Command) (string, error) {
	switch {
	case strings.HasPrefix(cmd.Kind, "bmc."):
		req := &sitev1.BmcOperationRequest{}
		if err := payloadOf(cmd, req); err != nil || req.GetAddress() == "" {
			return "", errors.New("a BMC command without its BMC address")
		}
		return "bmc:" + req.GetAddress(), nil
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
func (a *Agent) quorumVerdict(c *agentv1.Command, body *agentv1.CommandBody, cmd dispatch.Command) (dispatch.Rejection, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.quorumVerdictLocked(c, body, cmd)
}

// quorumVerdictLocked is quorumVerdict with a.mu held (a deferred command is checked again at
// admission: its approval may have expired meanwhile).
func (a *Agent) quorumVerdictLocked(c *agentv1.Command, body *agentv1.CommandBody, cmd dispatch.Command) (dispatch.Rejection, bool) {
	if k := a.kinds[body.GetKind()]; k == nil || !k.Destructive {
		return "", false
	}
	bundle, ok := a.trustBundleLocked()
	if !ok {
		a.log.Error("the stored trust bundle is unreadable; destructive commands are refused", "id", body.GetId())
		return dispatch.RejectBatchUnapproved, false
	}
	if len(bundle.GetApproverKeys()) == 0 {
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
	if err := pki.VerifyBatchApproval(approval, bundle, now); err != nil {
		return refuse(err.Error())
	}
	subject, err := commandSubject(cmd)
	if err != nil {
		return refuse(err.Error())
	}
	leaf := pki.BatchLeaf(body.GetBatchId(), subject, body.GetKind())
	proof := c.GetBatchProof()
	if !pki.VerifyBatchProof(leaf, proof.GetIndex(), approval.GetScopeSize(), proof.GetSiblings(), approval.GetScopeRoot()) {
		return refuse("the command (" + subject + ", " + body.GetKind() + ") is not in the approved scope")
	}
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
