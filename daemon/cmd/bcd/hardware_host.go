//go:build !fakehw

package main

import "github.com/better-compute/better-compute/daemon/internal/inventory"

// hardwareBackend names the inventory source this binary was built with.
const hardwareBackend = "host"

// collectInventory reads the host's inventory from sysfs, netlink and NVML.
//
// TODO(v0.1): implement the collectors of docs/research/prior-art.md §4 in internal/inventory.
func collectInventory() (*inventory.NodeInventory, error) {
	return nil, errNotImplemented("host inventory collection (sysfs, netlink, NVML)", "v0.1")
}
