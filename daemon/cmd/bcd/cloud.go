package main

import (
	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/cloud/aws"
)

// cloudIMDS is the EC2 instance metadata client (AWS program A6): the real host's DMI and the fixed
// endpoint. Tests replace it with one on a fake root and an httptest IMDS; nothing else does.
var cloudIMDS = func() *aws.Client { return &aws.Client{Root: "/"} }

// cloudHost is the cloud instance a node is: the EC2 metadata client when the DMI says EC2, else nil
// (and then no metadata request is ever made).
func cloudHost() agent.Cloud {
	c := cloudIMDS()
	if !aws.OnEC2(c.Root) {
		return nil
	}
	return c
}
