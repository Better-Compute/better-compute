package main

import (
	"io"
	"log/slog"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// An unprivileged node drives libvirt and cloud-hypervisor through bcd helper.
func TestAnUnprivilegedNodesRuntimes(t *testing.T) {
	libvirt, ch := &runtime.Libvirt{}, &runtime.CloudHypervisor{}
	got := forHelper([]runtime.Runtime{libvirt, ch}, helper.Client{Socket: "/run/bcd/helper.sock"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if len(got) != 2 || libvirt.Hypervisor == nil || ch.Privileged == nil {
		t.Fatalf("runtimes = %v", got)
	}
}
