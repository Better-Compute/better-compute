package main

import "testing"

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
