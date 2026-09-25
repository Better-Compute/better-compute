package main

import "strings"

// pciAddress normalizes an NVML bus id ("00000000:3B:00.0") to libvirt's form ("0000:3b:00.0").
func pciAddress(busID string) (string, bool) {
	parts := strings.Split(strings.ToLower(busID), ":")
	if len(parts) != 3 || len(parts[0]) < 4 {
		return "", false
	}
	return parts[0][len(parts[0])-4:] + ":" + parts[1] + ":" + parts[2], true
}
