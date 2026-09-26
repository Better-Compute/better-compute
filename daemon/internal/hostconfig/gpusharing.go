package hostconfig

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// GPUSharing is the `gpu-sharing` unit, for `mps` and `timeslice` pools (PLAN §10.6):
//
//   - mps: the MPS control daemon runs as bcd-mps.service (compute mode EXCLUSIVE_PROCESS while it
//     runs, DEFAULT after), each client limited by default to 100/replicas percent of the SMs.
//     Workloads reach it through CUDA_MPS_PIPE_DIRECTORY=/run/nvidia-mps;
//   - timeslice: the GPUs' default time slicing; the replicas are the slots the control plane and
//     the Kubernetes device plugin hand out. MPS is stopped.
//
// Removing the unit stops MPS.
type GPUSharing struct{}

// Paths of the gpu-sharing unit.
const (
	MPSService         = "bcd-mps.service"
	MPSUnitFile        = "/etc/systemd/system/" + MPSService
	MPSPipeDir         = "/run/nvidia-mps"
	MPSLogDir          = "/var/log/nvidia-mps"
	defaultMPSReplicas = 10
)

type gpuSharingSettings struct {
	Mode     string `json:"mode"`
	Replicas *int   `json:"replicas"`
}

func (GPUSharing) Name() string { return "gpu-sharing" }

func parseGPUSharing(settings json.RawMessage) (gpuSharingSettings, error) {
	var s gpuSharingSettings
	if err := decode("gpu-sharing", settings, &s); err != nil {
		return s, err
	}
	if s.Mode != "mps" && s.Mode != "timeslice" {
		return s, converge.Terminal(fmt.Errorf("gpu-sharing.mode: %q is not mps or timeslice", s.Mode))
	}
	if s.Replicas != nil && (*s.Replicas < 1 || *s.Replicas > 48) {
		return s, converge.Terminal(fmt.Errorf("gpu-sharing.replicas: 1 to 48 (MPS serves at most 48 clients per GPU)"))
	}
	return s, nil
}

// mpsUnit renders bcd-mps.service.
func mpsUnit(replicas int) []byte {
	percent := max(100/replicas, 1)
	return []byte(generatedHeader("gpu-sharing") + `[Unit]
Description=NVIDIA MPS control daemon (bcd gpu-sharing)
After=nvidia-persistenced.service

[Service]
Type=forking
Environment=CUDA_MPS_PIPE_DIRECTORY=` + MPSPipeDir + `
Environment=CUDA_MPS_LOG_DIRECTORY=` + MPSLogDir + `
ExecStartPre=nvidia-smi -c EXCLUSIVE_PROCESS
ExecStart=nvidia-cuda-mps-control -d
ExecStartPost=/bin/sh -c 'echo set_default_active_thread_percentage ` + fmt.Sprint(percent) + ` | nvidia-cuda-mps-control'
ExecStop=/bin/sh -c 'echo quit | nvidia-cuda-mps-control'
ExecStopPost=nvidia-smi -c DEFAULT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`)
}

func (g GPUSharing) Plan(ctx context.Context, sys System, settings json.RawMessage) ([]converge.Action, error) {
	s, err := parseGPUSharing(settings)
	if err != nil {
		return nil, err
	}
	if s.Mode != "mps" {
		return stopMPS(sys)
	}
	if !sys.LookPath("nvidia-cuda-mps-control") {
		return nil, fmt.Errorf("gpu-sharing: nvidia-cuda-mps-control is not installed (it ships with the driver's utilities)")
	}
	replicas := defaultMPSReplicas
	if s.Replicas != nil {
		replicas = *s.Replicas
	}
	actions, err := ensureFile(sys, MPSUnitFile, mpsUnit(replicas), 0o644)
	if err != nil {
		return nil, err
	}
	if len(actions) > 0 {
		return append(actions,
			run(sys, Cmd{Name: "systemctl", Args: []string{"daemon-reload"}}),
			run(sys, Cmd{Name: "systemctl", Args: []string{"enable", MPSService}}),
			run(sys, Cmd{Name: "systemctl", Args: []string{"restart", MPSService}})), nil
	}
	if !serviceActive(ctx, sys, MPSService) {
		actions = append(actions, enableNow(sys, MPSService))
	}
	return actions, nil
}

// stopMPS stops and removes bcd-mps.service when bcd installed it.
func stopMPS(sys System) ([]converge.Action, error) {
	remove, err := ensureAbsent(sys, MPSUnitFile)
	if err != nil || len(remove) == 0 {
		return nil, err
	}
	actions := []converge.Action{run(sys, Cmd{Name: "systemctl", Args: []string{"disable", "--now", MPSService}})}
	actions = append(actions, remove...)
	return append(actions, run(sys, Cmd{Name: "systemctl", Args: []string{"daemon-reload"}})), nil
}

func (GPUSharing) Clean(_ context.Context, sys System) ([]converge.Action, error) {
	return stopMPS(sys)
}

// Conditions reports MPSDown while an mps host's control daemon is not running: its clients fail.
func (GPUSharing) Conditions(ctx context.Context, sys System, settings json.RawMessage) []Condition {
	s, err := parseGPUSharing(settings)
	if err != nil || s.Mode != "mps" || serviceActive(ctx, sys, MPSService) {
		return nil
	}
	return []Condition{{Type: "MPSDown", Reason: "NotRunning", Message: "the MPS control daemon (" + MPSService + ") is not running"}}
}
