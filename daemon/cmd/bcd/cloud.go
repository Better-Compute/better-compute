package main

import (
	"context"
	"fmt"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/cloud/aws"
)

// cloudIMDS is the EC2 instance metadata client (AWS program A6): the real host's DMI and the fixed
// endpoint. Tests replace it with one on a fake root and an httptest IMDS; nothing else does.
var cloudIMDS = func() *aws.Client { return &aws.Client{Root: "/"} }

// spotInterval is how often a spot instance polls its interruption notice (tests shorten it).
var spotInterval = aws.DefaultSpotInterval

// cloudHost is the cloud instance a node is: EC2 when the DMI says so, else nil (and then no
// metadata request is ever made).
func cloudHost() agent.Cloud {
	c := cloudIMDS()
	if !aws.OnEC2(c.Root) {
		return nil
	}
	return ec2Host{c}
}

// cloudMetadata are the addresses of the cloud's own metadata service when this host is a cloud
// instance (EC2), which no instance tap may reach (agent.Options.CloudMetadata); nil elsewhere.
func cloudMetadata() []string {
	if !aws.OnEC2(cloudIMDS().Root) {
		return nil
	}
	return aws.MetadataAddrs()
}

// guestIMDSConflict refuses bcd's guest metadata service ([imds] listen) on EC2's own metadata
// address on an EC2 host: bound there it makes that address local, so the host's cloud section, spot
// watch and cloud-iid join would read bcd's service instead of AWS's and never see a spot notice.
func guestIMDSConflict(listen string) error {
	if listen == "" || !aws.IsMetadataAddr(listen) || !aws.OnEC2(cloudIMDS().Root) {
		return nil
	}
	return fmt.Errorf("[imds] listen %q is EC2's own instance metadata service on this EC2 host; "+
		"bcd needs it for the cloud section and spot notices: serve the instances' metadata on another "+
		"address (e.g. the host's address on the instances' bridge)", listen)
}

// ec2Host is agent.Cloud on EC2: the "cloud" section, and the spot instance-action as the agent's
// interruption notice.
type ec2Host struct{ *aws.Client }

func (h ec2Host) WatchInterruptions(ctx context.Context, section *agentv1.CloudSection, notify func(*agent.Interruption)) {
	if section.GetLifecycle() != "spot" {
		return
	}
	h.WatchSpot(ctx, spotInterval, func(n *aws.SpotNotice) {
		if n == nil {
			notify(nil)
			return
		}
		notify(&agent.Interruption{Action: n.Action, Deadline: n.Time})
	})
}
