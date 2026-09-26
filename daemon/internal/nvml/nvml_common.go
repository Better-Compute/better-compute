// Package nvml is the daemon's boundary to the NVIDIA Management Library: GPU identity, MIG,
// NVLink, topology, ECC, row remapping and XID events (PLAN.md §6, §10.1).
//
// Build tags select the implementation:
//
//   - -tags nonvml builds nvml_stub.go: no cgo, for Windows and logic tests;
//   - the default build uses nvml.go, which reads the GPUs through nvidia-smi (smi.go, no cgo);
//     a go-nvml backend may replace it once that dependency is approved.
//
// SMI itself builds everywhere, so its parsers are tested under -tags nonvml too.
package nvml

import "errors"

// ErrNotBuilt reports that this binary cannot talk to NVML.
var ErrNotBuilt = errors.New("nvml: not available in this build")

// Info is what Probe reports about the host's NVIDIA driver.
type Info struct {
	DriverVersion string
	DeviceCount   int
}
