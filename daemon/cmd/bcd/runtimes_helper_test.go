package main

import (
	"io"
	"log/slog"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

func TestAnUnprivilegedNodeOffersNoCloudHypervisor(t *testing.T) {
	libvirt, ch := &runtime.Libvirt{}, &runtime.CloudHypervisor{}
	all := []runtime.Runtime{libvirt, ch}
	got := withoutRootRuntimes(all, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if len(got) != 1 || got[0] != libvirt || len(all) != 2 || all[1] != ch {
		t.Fatalf("runtimes = %v (input %v)", got, all)
	}
}
