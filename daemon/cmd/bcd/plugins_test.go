package main

import (
	"os"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/config"
)

func TestPluginsGetTheirOwnUIDs(t *testing.T) {
	prev := uidInUse
	defer func() { uidInUse = prev }()
	uidInUse = func(uint32) bool { return false }
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
	// An account that already has the uid is never shared either.
	uidInUse = func(uid uint32) bool { return uid == a }
	if other := pluginUID("kata", map[uint32]bool{}); other == a {
		t.Fatal("a plugin shares a uid with an existing account")
	}
	// Clear of systemd's DynamicUser range and anything below the unassigned 31-bit block.
	if a < 0x70000000 || a > 0x7FFFFFFE {
		t.Fatalf("uid %d outside bcd's block", a)
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
