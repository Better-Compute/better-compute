// Package nvml is the daemon's boundary to the NVIDIA Management Library: GPU identity, MIG,
// NVLink, topology, ECC, row remapping and XID events (PLAN.md §6, §10.1).
//
// Build tags select the implementation:
//
//   - -tags nonvml builds nvml_stub.go: no cgo, for Windows and logic tests;
//   - the default build uses nvml.go, which will dlopen libnvidia-ml through NVIDIA/go-nvml (cgo),
//     so release builds need a C cross-compiler (see .goreleaser.yaml).
//
// Both builds return ErrNotBuilt until v0.1.
package nvml

import "errors"

// ErrNotBuilt reports that this binary cannot talk to NVML.
var ErrNotBuilt = errors.New("nvml: not available in this build")

// Info is what Probe reports about the host's NVIDIA driver.
type Info struct {
	DriverVersion string
	DeviceCount   int
}
