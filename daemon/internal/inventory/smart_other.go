//go:build !linux || !(amd64 || arm64 || ppc64le || riscv64 || s390x || loong64)

package inventory

// NVMeHealth: the NVMe admin ioctl is read on 64-bit Linux only.
func NVMeHealth(string) *SmartStatus { return nil }
