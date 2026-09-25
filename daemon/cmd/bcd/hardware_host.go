//go:build !fakehw

package main

import (
	"os/exec"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// hardwareBackend names the inventory source this binary was built with.
const hardwareBackend = "host"

// devBuild refuses dev-only configuration in production builds.
const devBuild = false

// collectInventory reads the host's inventory from procfs and sysfs (inventory.Collector).
func collectInventory() (*inventory.NodeInventory, error) {
	return inventory.Collector{}.Collect()
}

// newHost is the machine bcd runs on; a reboot goes through systemd so units stop cleanly.
func newHost(string) (agent.Host, error) {
	return &agent.RealHost{
		Collect:    collectInventory,
		RebootFunc: func(string) error { return exec.Command("systemctl", "reboot").Run() },
	}, nil
}
