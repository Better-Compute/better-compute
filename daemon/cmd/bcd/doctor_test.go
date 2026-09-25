package main

import (
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/selfupdate"
)

func TestConfigChecks(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	find := func(checks []doctorCheck, check, status, text string) bool {
		for _, c := range checks {
			if c.check == check && c.status == status && strings.Contains(c.detail, text) {
				return true
			}
		}
		return false
	}
	got := configChecks(cfg, "site")
	if !find(got, "update", "warn", "no [update] release_pins") || !find(got, "bmc", "warn", "bmc_networks") {
		t.Fatalf("checks = %+v", got)
	}
	cfg.Update.ReleasePins = "sha256/" + strings.Repeat("A", 43) + "="
	cfg.BMCNetworks = "10.9.0.0/16"
	_ = selfupdate.SaveRecord(cfg.DataDir, selfupdate.Record{Failed: map[string]string{"0.9.0": "did not start"}})
	got = configChecks(cfg, "site")
	if !find(got, "update", "ok", "1 release pins") || find(got, "bmc", "warn", "") || !find(got, "update", "warn", "--clear-failed") {
		t.Fatalf("checks = %+v", got)
	}
	if find(configChecks(cfg, "node"), "bmc", "warn", "") {
		t.Fatal("a node was asked for bmc_networks")
	}
}

// doctor reads the slots and records where bcd update does: [update] slots_dir when set.
func TestConfigChecksReadSlotsDir(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.Update.SlotsDir = t.TempDir()
	_ = selfupdate.SaveRecord(cfg.Update.SlotsDir, selfupdate.Record{Failed: map[string]string{"0.9.2": "not welcomed"}})
	_ = selfupdate.SavePending(cfg.Update.SlotsDir, &selfupdate.Pending{Version: "0.9.3", FromVersion: "0.9.1", State: selfupdate.StateSwapped})
	var failed, pending bool
	for _, c := range configChecks(cfg, "node") {
		failed = failed || (c.check == "update" && strings.Contains(c.detail, "0.9.2"))
		pending = pending || (c.check == "update" && strings.Contains(c.detail, "0.9.3"))
	}
	if !failed || !pending {
		t.Fatalf("doctor did not read slots_dir: failed %v, pending %v", failed, pending)
	}
}
