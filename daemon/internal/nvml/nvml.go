//go:build !nonvml

package nvml

import "fmt"

// Probe initializes NVML and reports the driver version and the GPU count.
//
// TODO(v0.1): implement it with github.com/NVIDIA/go-nvml (nvml.Init, SystemGetDriverVersion,
// DeviceGetCount) once a Go toolchain can add the module and its go.sum entries; the dependency
// cannot be added without one.
func Probe() (Info, error) {
	return Info{}, fmt.Errorf("%w: NVIDIA/go-nvml is wired in v0.1", ErrNotBuilt)
}
