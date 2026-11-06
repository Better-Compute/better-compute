package agent

import (
	"context"
	"crypto/sha256"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// Cloud is the cloud instance this node is (cloud/aws.Client on EC2; AWS program A6). nil off a
// cloud: then nothing here runs and no metadata service is contacted.
type Cloud interface {
	// Section reads the "cloud" inventory section (instance, type, zone, lifecycle, EFA devices).
	Section(ctx context.Context) (*agentv1.CloudSection, error)
}

// cloudSectionName is the inventory section the cloud instance is reported in.
const cloudSectionName = "cloud"

// maxCloudRetry caps the wait between metadata reads while the section is missing.
const maxCloudRetry = 5 * time.Minute

// loadCloud reads the cloud section once (before the first collection, so it is in the first
// Hello); false when the metadata did not answer.
func (a *Agent) loadCloud(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	section, err := a.o.Cloud.Section(ctx)
	if err != nil {
		a.log.Warn("cloud instance metadata unavailable; retrying", "error", err.Error())
		return false
	}
	a.invMu.Lock()
	a.cloud = section
	a.invMu.Unlock()
	a.log.Info("cloud instance", "provider", section.GetProvider(), "instance", section.GetInstanceId(),
		"type", section.GetInstanceType(), "zone", section.GetZone(), "lifecycle", section.GetLifecycle())
	return true
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
