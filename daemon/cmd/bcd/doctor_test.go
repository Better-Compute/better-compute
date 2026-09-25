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
