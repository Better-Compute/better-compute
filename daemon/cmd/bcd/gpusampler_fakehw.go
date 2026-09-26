//go:build fakehw

package main

import (
	"context"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"github.com/better-compute/better-compute/daemon/internal/nvml"
)

// gpuSampler reads the fake machine's GPUs (fakehw.GPUSnapshot) for the OTLP export.
func gpuSampler() agent.GPUSampler {
	seed := fakeSeed()
	return func(context.Context) (*nvml.Snapshot, error) { return fakehw.GPUSnapshot(seed, time.Now()), nil }
}
