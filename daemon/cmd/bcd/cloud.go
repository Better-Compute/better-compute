package main

import (
	"context"

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
