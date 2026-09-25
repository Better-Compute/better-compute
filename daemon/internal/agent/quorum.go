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

// unbatchedFile holds the unbatched destructive commands of the last hour (command id → server time).
const unbatchedFile = "unbatched-destructive.json"

// trustBundleLocked is the stored trust bundle, or nil.
func (a *Agent) trustBundleLocked() *commonv1.TrustBundle {
	if len(a.state.TrustBundle) == 0 {
		return nil
	}
	b := &commonv1.TrustBundle{}
	if proto.Unmarshal(a.state.TrustBundle, b) != nil {
		return nil
	}
	return b
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
	bundle := a.trustBundleLocked()
	now := a.serverNowLocked()
	a.mu.Unlock()
	if len(bundle.GetApproverKeys()) == 0 {
		return "", false
	}
	if k := a.kinds[body.GetKind()]; k == nil || !k.Destructive {
		return "", false
	}
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
// cap (a command already counted, re-executed after a restart, always does).
func (a *Agent) unbatchedAllowedLocked(id string) bool {
	now := a.serverNowLocked()
	seen := a.unbatchedLocked(now)
	if _, counted := seen[id]; counted {
		return true
	}
	return len(seen) < int(a.trustBundleLocked().GetUnbatchedDestructivePerHour())
}

// recordUnbatchedLocked counts an accepted unbatched destructive command.
func (a *Agent) recordUnbatchedLocked(id string) {
	now := a.serverNowLocked()
	seen := a.unbatchedLocked(now)
	seen[id] = now
	raw, _ := json.Marshal(seen)
	if err := pki.WriteFileAtomic(filepath.Join(a.o.DataDir, unbatchedFile), raw, 0o600); err != nil {
		a.log.Error("store the unbatched destructive count", "error", err.Error())
	}
}
