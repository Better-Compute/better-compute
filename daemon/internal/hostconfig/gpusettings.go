package hostconfig

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// GPUSettings is the `gpu-settings` unit: per-GPU knobs every GPU of the host shares.
//
//   - powerLimitWatts caps each GPU's board power (nvidia-smi -pl). The driver forgets it when it
//     reloads, so it is applied again whenever it drifts. A limit outside a GPU's range is terminal;
//   - ecc turns ECC on or off. The mode changes at the GPU's next reset: until then the unit reports
//     that the node needs a reboot, and it never reboots.
type GPUSettings struct{}

type gpuSettingsSettings struct {
	PowerLimitWatts *float64 `json:"powerLimitWatts"`
	ECC             *bool    `json:"ecc"`
}

func (GPUSettings) Name() string { return "gpu-settings" }

// gpuState is what nvidia-smi reports for one GPU.
type gpuState struct {
	index                    string
	powerLimit, minPL, maxPL float64
	eccCurrent, eccPending   string // Enabled, Disabled, [N/A]
}

func queryGPUs(ctx context.Context, sys System) ([]gpuState, error) {
	out, err := sys.Run(ctx, Cmd{Name: "nvidia-smi", Args: []string{
		"--query-gpu=index,power.limit,power.min_limit,power.max_limit,ecc.mode.current,ecc.mode.pending",
		"--format=csv,noheader,nounits",
	}})
	if err != nil {
		return nil, err
	}
	num := func(s string) float64 {
		v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if err != nil {
			return math.NaN() // [N/A]: a GPU without power management
		}
		return v
	}
	var gpus []gpuState
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Split(line, ",")
		if len(f) != 6 {
			continue
		}
		gpus = append(gpus, gpuState{
			index: strings.TrimSpace(f[0]), powerLimit: num(f[1]), minPL: num(f[2]), maxPL: num(f[3]),
			eccCurrent: strings.TrimSpace(f[4]), eccPending: strings.TrimSpace(f[5]),
		})
	}
	return gpus, nil
}

func (g GPUSettings) Plan(ctx context.Context, sys System, settings json.RawMessage) ([]converge.Action, error) {
	var s gpuSettingsSettings
	if err := decode(g.Name(), settings, &s); err != nil {
		return nil, err
	}
	if s.PowerLimitWatts == nil && s.ECC == nil {
		return nil, nil
	}
	if s.PowerLimitWatts != nil && (*s.PowerLimitWatts <= 0 || *s.PowerLimitWatts > 10_000) {
		return nil, converge.Terminal(fmt.Errorf("gpu-settings.powerLimitWatts: %v is not a power limit", *s.PowerLimitWatts))
	}
	gpus, err := queryGPUs(ctx, sys)
	if err != nil {
		return nil, err
	}
	var actions []converge.Action
	var pendingECC []string
	for _, gpu := range gpus {
		if want := s.PowerLimitWatts; want != nil && !math.IsNaN(gpu.powerLimit) {
			if *want < gpu.minPL || *want > gpu.maxPL {
				return nil, converge.Terminal(fmt.Errorf("gpu-settings.powerLimitWatts: GPU %s takes %.0f to %.0f W, not %.0f", gpu.index, gpu.minPL, gpu.maxPL, *want))
			}
			if math.Abs(gpu.powerLimit-*want) >= 1 {
				actions = append(actions, run(sys, Cmd{Name: "nvidia-smi", Args: []string{"-i", gpu.index, "-pl", strconv.FormatFloat(*want, 'f', -1, 64)}}))
			}
		}
		if s.ECC != nil && (gpu.eccCurrent == "Enabled" || gpu.eccCurrent == "Disabled") {
			want := map[bool]string{true: "Enabled", false: "Disabled"}[*s.ECC]
			if gpu.eccPending != want {
				actions = append(actions, run(sys, Cmd{Name: "nvidia-smi", Args: []string{"-i", gpu.index, "-e", map[bool]string{true: "1", false: "0"}[*s.ECC]}}))
			}
			if gpu.eccCurrent != want {
				pendingECC = append(pendingECC, gpu.index)
			}
		}
	}
	if len(pendingECC) > 0 {
		actions = append(actions, fail(needsReboot("gpu-settings: the ECC mode of GPU(s) %s changes at their next reset: reboot the node", strings.Join(pendingECC, ", "))))
	}
	return actions, nil
}
