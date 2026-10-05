//go:build !linux

package inventory

// EthtoolFirmware: ethtool is Linux's.
func EthtoolFirmware(string) string { return "" }
