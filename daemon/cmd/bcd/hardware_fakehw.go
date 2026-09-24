//go:build fakehw

package main

import (
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// hardwareBackend names the inventory source this binary was built with.
const hardwareBackend = "fakehw"

// collectInventory returns the fake HGX H100 node for seed 0.
func collectInventory() (*inventory.NodeInventory, error) {
	return fakehw.Inventory(0), nil
}
