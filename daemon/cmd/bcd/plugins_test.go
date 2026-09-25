package main

import (
	"os"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/config"
)

func TestPluginsGetTheirOwnUIDs(t *testing.T) {
	taken := map[uint32]bool{}
	a, b := pluginUID("kata", taken), pluginUID("acme-bmc", taken)
	if a == b || a < pluginUIDBase || a >= pluginUIDBase+pluginUIDCount || b < pluginUIDBase || b >= pluginUIDBase+pluginUIDCount {
		t.Fatalf("uids %d and %d", a, b)
	}
	// Stable across restarts, and a collision moves on rather than sharing.
	if again := pluginUID("kata", map[uint32]bool{}); again != a {
		t.Fatalf("kata's uid changed: %d, then %d", a, again)
	}
	if clash := pluginUID("kata", map[uint32]bool{a: true}); clash == a {
		t.Fatal("two plugins share a uid")
	}
}

func TestPrivilegedPluginsAreNamedOneByOne(t *testing.T) {
	c := config.Plugins{Sandbox: true, Privileged: "kata, firecracker"}
	if !privileged(c, "kata") || !privileged(c, "firecracker") || privileged(c, "acme-bmc") || privileged(config.Plugins{}, "") {
		t.Fatal("privileged plugins")
	}
	o, err := sandboxOptions(c, "kata", map[uint32]bool{})
	if err != nil || o.Shim != "" || o.Credential != nil {
		t.Fatalf("a privileged plugin = %+v, %v", o, err)
	}
	o, err = sandboxOptions(c, "acme-bmc", map[uint32]bool{})
	if err != nil || o.Shim == "" {
		t.Fatalf("a confined plugin = %+v, %v", o, err)
	}
	if os.Geteuid() == 0 && o.Credential == nil {
		t.Fatal("bcd as root runs a confined plugin as root")
	}
}
