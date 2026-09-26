package main

import (
	"io"
	"log/slog"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// An unprivileged node offers no cloud-hypervisor, and drives libvirt through bcd helper.
func TestAnUnprivilegedNodesRuntimes(t *testing.T) {
	libvirt, ch := &runtime.Libvirt{}, &runtime.CloudHypervisor{}
	all := []runtime.Runtime{libvirt, ch}
	hv := helperHypervisor{helper.Client{Socket: "/run/bcd/helper.sock"}}
	got := forHelper(all, hv, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if len(got) != 1 || got[0] != libvirt || len(all) != 2 || all[1] != ch {
		t.Fatalf("runtimes = %v (input %v)", got, all)
	}
	if libvirt.Hypervisor == nil {
		t.Fatal("libvirt does not go through the helper")
	}
}
