package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/config"
)

// bcd doctor fails a node user still in tss under [helper] (an install before 8870b8d).
func TestDoctorTSS(t *testing.T) {
	cfg := &config.Config{}
	member := func(in bool, err error) func(string, string) (bool, error) {
		return func(name, group string) (bool, error) {
			if name != "bcd" || group != "tss" {
				t.Fatalf("asked %s in %s", name, group)
			}
			return in, err
		}
	}
	if got := tssCheck(cfg, member(true, nil)); got != nil {
		t.Fatalf("without [helper]: %v", got)
	}
	cfg.Helper.Socket, cfg.Helper.User = "/run/bcd-helper/helper.sock", "bcd"
	if got := tssCheck(cfg, member(true, nil)); len(got) != 1 || got[0].status != "fail" || !strings.Contains(got[0].detail, "gpasswd -d bcd tss") {
		t.Fatalf("bcd in tss: %v", got)
	}
	if got := tssCheck(cfg, member(false, nil)); got != nil {
		t.Fatalf("bcd not in tss: %v", got)
	}
	if got := tssCheck(cfg, member(false, errors.New("user: unknown group tss"))); got != nil {
		t.Fatalf("no tss group: %v", got)
	}
}
