//go:build !fakehw

package main

import (
	"context"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/nvml"
)

// gpuSampler reads the GPUs through nvidia-smi for the OTLP export.
func gpuSampler() agent.GPUSampler {
	return func(ctx context.Context) (*nvml.Snapshot, error) { return nvml.SMI{}.Snapshot(ctx) }
}
