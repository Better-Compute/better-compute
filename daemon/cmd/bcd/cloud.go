package main

import "github.com/better-compute/better-compute/daemon/internal/cloud/aws"

// cloudIMDS is the EC2 instance metadata client (AWS program A6): the real host's DMI and the fixed
// endpoint. Tests replace it with one on a fake root and an httptest IMDS; nothing else does.
var cloudIMDS = func() *aws.Client { return &aws.Client{Root: "/"} }
