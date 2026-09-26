package agent

import (
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// A re-collection that changes sections (a host unit reserved hugepages) sends them, and the next
// heartbeat carries the hashes: the gateway applies the inventory once both agree, not ten
// heartbeats later.
func TestChangedSectionsHashesOnNextHeartbeat(t *testing.T) {
	h := newHarness(t, nil)
	s, _ := h.open()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		h.agent.mu.Lock()
		welcomed := h.agent.sess != nil && h.agent.sess.welcomed
		h.agent.mu.Unlock()
		if welcomed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("not welcomed")
		}
	}
	before := h.agent.inventoryHashes()["memory"]
	h.host.mu.Lock()
	h.host.inv.Memory.Hugepages = []*inventory.HugepagePool{{PageSizeBytes: 2 << 20, Total: 4096}}
	h.host.mu.Unlock()
	h.agent.refreshSections()
	if after := h.agent.inventoryHashes()["memory"]; string(after) == string(before) {
		t.Fatalf("memory hash unchanged %x (memory %+v)", after, h.host.inv.Memory)
	}
	s.next(t, "the changed memory section", func(f *agentv1.AgentFrame) bool { return f.GetInventory().GetSection() == "memory" })
	beat := func() *agentv1.Heartbeat {
		h.agent.mu.Lock()
		sess := h.agent.sess
		h.agent.mu.Unlock()
		h.agent.heartbeat(sess)
		return s.next(t, "a heartbeat", func(f *agentv1.AgentFrame) bool { return f.GetHeartbeat() != nil }).GetHeartbeat()
	}
	hb := beat()
	if want := h.agent.inventoryHashes()["memory"]; string(hb.GetInventoryHashes()["memory"]) != string(want) {
		t.Fatalf("heartbeat hashes = %x, want memory %x", hb.GetInventoryHashes()["memory"], want)
	}
	if hb := beat(); len(hb.GetInventoryHashes()) != 0 {
		t.Fatal("every heartbeat carries the hashes")
	}
}
