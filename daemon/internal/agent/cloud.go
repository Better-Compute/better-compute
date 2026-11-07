package agent

import (
	"context"
	"crypto/sha256"
	"fmt"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
	"google.golang.org/protobuf/proto"
)

// Cloud is the cloud instance this node is (cloud/aws.Client on EC2; AWS program A6). nil off a
// cloud: then nothing here runs and no metadata service is contacted.
type Cloud interface {
	// Section reads the "cloud" inventory section (instance, type, zone, lifecycle, EFA devices).
	Section(ctx context.Context) (*agentv1.CloudSection, error)
	// WatchInterruptions blocks until ctx ends, calling notify on every change of the cloud's notice
	// that it takes the instance back (nil: withdrawn). It returns at once for an instance the cloud
	// does not interrupt (section.lifecycle is not "spot").
	WatchInterruptions(ctx context.Context, section *agentv1.CloudSection, notify func(*Interruption))
}

// Interruption is a cloud's notice that it takes the instance back (an EC2 spot instance-action).
type Interruption struct {
	// Action is what the cloud does: "terminate", "stop" or "hibernate", or "unknown" for a notice
	// that does not say (still an interruption).
	Action string
	// Deadline is when.
	Deadline time.Time
}

// InterruptionCondition is the node condition of a pending interruption, true while the notice
// stands: reason "<action>:<RFC 3339 deadline>". The control plane makes the node NoSchedule
// (gateway daemonNodeConditions) and records a changed notice; that is all. Draining the node's
// reservations is AWS program A4's interruption-warning path (taint aws.spot/interruption), not this
// condition.
const InterruptionCondition = "SpotInterruption"

// cloudSectionName is the inventory section the cloud instance is reported in.
const cloudSectionName = "cloud"

// maxCloudRetry caps the wait between metadata reads while the section is missing.
const maxCloudRetry = 5 * time.Minute

// loadCloud reads the cloud section once (before the first collection, so it is in the first
// Hello) and starts the interruption watch; false when the metadata did not answer.
func (a *Agent) loadCloud(ctx context.Context) bool {
	read, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	section, err := a.o.Cloud.Section(read)
	if err != nil {
		a.log.Warn("cloud instance metadata unavailable; retrying", "error", err.Error())
		return false
	}
	a.invMu.Lock()
	a.cloud = section
	a.invMu.Unlock()
	a.log.Info("cloud instance", "provider", section.GetProvider(), "instance", section.GetInstanceId(),
		"type", section.GetInstanceType(), "zone", section.GetZone(), "lifecycle", section.GetLifecycle())
	go a.o.Cloud.WatchInterruptions(ctx, proto.Clone(section).(*agentv1.CloudSection), a.onInterruption)
	return true
}

// onInterruption keeps the interruption condition and re-sends the status with it.
func (a *Agent) onInterruption(n *Interruption) {
	var c *agentv1.Condition
	if n != nil {
		deadline := n.Deadline.UTC().Format(time.RFC3339)
		c = &agentv1.Condition{
			Type:    InterruptionCondition,
			Status:  agentv1.ConditionStatus_CONDITION_STATUS_TRUE,
			Reason:  n.Action + ":" + deadline,
			Message: fmt.Sprintf("the cloud will %s this instance at %s", n.Action, deadline),
		}
		a.log.Warn("the cloud is taking this instance back", "action", n.Action, "deadline", deadline)
	} else {
		a.log.Info("the cloud withdrew its interruption notice")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.interruption = c
	if a.lastStatus != nil {
		a.lastStatus = proto.Clone(a.lastStatus).(*agentv1.StatusReport)
		a.lastStatus.Conditions = append(withoutType(a.lastStatus.Conditions, InterruptionCondition), a.interruptionLocked()...)
		a.sendStatusLocked()
	}
}

// interruptionLocked is the interruption condition for a status (under mu).
func (a *Agent) interruptionLocked() []*agentv1.Condition {
	if a.interruption == nil {
		return nil
	}
	return []*agentv1.Condition{proto.Clone(a.interruption).(*agentv1.Condition)}
}

func withoutType(conditions []*agentv1.Condition, kind string) []*agentv1.Condition {
	out := conditions[:0:0]
	for _, c := range conditions {
		if c.GetType() != kind {
			out = append(out, c)
		}
	}
	return out
}

// cloudLoop retries the cloud section (CloudRetry, doubling to 5 min) until it is read, then
// re-collects so the changed hashes and the section go out.
func (a *Agent) cloudLoop(ctx context.Context) {
	wait := a.o.CloudRetry
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if a.loadCloud(ctx) {
			a.requestRescan()
			return
		}
		wait = min(wait*2, maxCloudRetry)
	}
}

// cloudSectionLocked encodes the cloud section (under invMu); false when there is none.
func (a *Agent) cloudSectionLocked() (inventory.Section, bool, error) {
	if a.cloud == nil {
		return inventory.Section{}, false, nil
	}
	content, err := marshal(a.cloud)
	if err != nil {
		return inventory.Section{}, false, err
	}
	sum := sha256.Sum256(content)
	return inventory.Section{Name: cloudSectionName, Content: content, Sha256: sum[:]}, true, nil
}
