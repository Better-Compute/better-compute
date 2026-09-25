package main

import (
	"errors"
	"testing"
)

func TestDoctorToolChecks(t *testing.T) {
	look := func(have ...string) func(string) (string, error) {
		return func(name string) (string, error) {
			for _, h := range have {
				if h == name {
					return "/usr/bin/" + name, nil
				}
			}
			return "", errors.New("not found")
		}
	}
	status := func(checks []doctorCheck) map[string]string {
		out := map[string]string{}
		for _, c := range checks {
			out[c.check] = c.status
		}
		return out
	}
	if s := status(toolChecks(look())); len(s) != 1 || s["libvirt"] != "warn" {
		t.Fatalf("no libvirt = %v", s)
	}
	if s := status(toolChecks(look("virsh", "qemu-img", "xorriso", "nft"))); s["qemu-img"] != "ok" || s["seed"] != "ok" || s["nftables"] != "ok" {
		t.Fatalf("a full VPS host = %v", s)
	}
	if s := status(toolChecks(look("virsh"))); s["qemu-img"] != "fail" || s["seed"] != "fail" || s["nftables"] != "fail" {
		t.Fatalf("virsh alone = %v", s)
	}
}

func TestPCIAddress(t *testing.T) {
	for in, want := range map[string]string{"00000000:3B:00.0": "0000:3b:00.0", "0000:18:00.1": "0000:18:00.1"} {
		if got, ok := pciAddress(in); !ok || got != want {
			t.Errorf("pciAddress(%q) = %q, %v", in, got, ok)
		}
	}
	if _, ok := pciAddress("3b:00.0"); ok {
		t.Error("a bus id without a domain was accepted")
	}
}
