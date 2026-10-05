//go:build !linux

package inventory

// NVMeHealth: the NVMe admin ioctl is Linux's.
func NVMeHealth(string) *SmartStatus { return nil }
