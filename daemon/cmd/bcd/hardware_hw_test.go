package main

import (
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// hw.read is asked once per collection, and only fills what the node's own read found nothing for.
func TestWithHelperHW(t *testing.T) {
	calls := 0
	source := func() *helper.HWInfo {
		calls++
		return &helper.HWInfo{
			Dimms: []*inventory.Dimm{{Slot: "A1"}},
			NVMe:  map[string]*inventory.SmartStatus{"nvme0": {Healthy: false}, "nvme1": {Healthy: true}},
		}
	}
	local := func(ctrl string) *inventory.SmartStatus {
		if ctrl == "nvme1" {
			return &inventory.SmartStatus{Healthy: false} // root's own read, when it works, wins
		}
		return nil
	}
	c := withHelperHW(inventory.Collector{NVMeHealth: local}, source)
	if d := c.Dimms(); len(d) != 1 || d[0].Slot != "A1" {
		t.Fatalf("dimms = %+v", d)
	}
	if h := c.NVMeHealth("nvme0"); h == nil || h.Healthy {
		t.Fatalf("nvme0 = %+v", h)
	}
	if h := c.NVMeHealth("nvme1"); h == nil || h.Healthy {
		t.Fatalf("nvme1 = %+v (the local read)", h)
	}
	if c.NVMeHealth("nvme9") != nil {
		t.Fatal("a controller hw.read does not know")
	}
	if calls != 1 {
		t.Fatalf("hw.read asked %d times", calls)
	}
	// A helper that fails reads as none.
	failed := withHelperHW(inventory.Collector{}, func() *helper.HWInfo { return nil })
	if failed.Dimms() != nil || failed.NVMeHealth("nvme0") != nil {
		t.Fatal("a failed hw.read supplied something")
	}
	if c := withHelperHW(inventory.Collector{}, nil); c.Dimms != nil || c.NVMeHealth != nil {
		t.Fatal("no helper, yet hooks")
	}
}
