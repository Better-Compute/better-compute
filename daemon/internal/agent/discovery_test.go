package agent

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	sitev1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/site/v1"
	"github.com/better-compute/better-compute/daemon/internal/pxe"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func TestDiscoveryListIsCappedAndForgets(t *testing.T) {
	var d discovery
	now := time.Now()
	if !d.seen(now, "B8:3F:D2:00:00:01", "4C4C4544-0001", "x86_64-efi", "10.20.0.1") {
		t.Fatal("a new machine did not ask for a report")
	}
	if d.seen(now.Add(time.Second), "b8:3f:d2:00:00:01", "", "", "") {
		t.Fatal("a known machine asked for a report")
	}
	if d.seen(now.Add(2*time.Second), "b8:3f:d2:00:00:02", "", "bios", "") {
		t.Fatal("a second new machine within 30 s asked for a report")
	}
	list := d.list(now.Add(3 * time.Second))
	if len(list) != 2 || list[0].GetMac() != "b8:3f:d2:00:00:01" || list[0].GetCount() != 2 || list[0].GetProductUuid() != "4c4c4544-0001" ||
		list[0].GetRelay() != "10.20.0.1" || list[0].GetArch() != "x86_64-efi" || !list[0].GetFirstSeen().AsTime().Equal(now) {
		t.Fatalf("list = %v", list)
	}
	d.forget("B8:3F:D2:00:00:02")
	if len(d.list(now)) != 1 {
		t.Fatal("a prepared machine was not forgotten")
	}
	// At most discoveryCap: the oldest last-seen goes.
	for i := 0; i < discoveryCap+10; i++ {
		d.seen(now.Add(time.Duration(i+10)*time.Second), fmt.Sprintf("02:00:00:00:%02x:%02x", i/256, i%256), "", "", "")
	}
	if got := d.list(now.Add(time.Hour)); len(got) != discoveryCap || got[0].GetMac() == "b8:3f:d2:00:00:01" {
		t.Fatalf("%d machines, first %s", len(got), got[0].GetMac())
	}
	// Forgotten a day after it was last seen.
	if got := d.list(now.Add(discoveryTTL + time.Hour)); len(got) != 0 {
		t.Fatalf("%d machines a day later", len(got))
	}
	if archName(pxe.Arch(42)) != "arch-42" {
		t.Fatalf("archName(42) = %s", archName(pxe.Arch(42)))
	}
}

// An unknown machine that PXE-boots is never answered but listed in the site agent's status, and a
// prepared one that sanboots gets its ISO from the cache.
func TestUnknownMachinesAreListedAndSanbootBootsTheCachedISO(t *testing.T) {
	iso := make([]byte, 64<<10)
	_, _ = rand.Read(iso)
	digest := sha256.Sum256(iso)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(iso) }))
	defer upstream.Close()
	h := newHarness(t, func(o *Options) {
		o.State.Role = "site"
		o.ConvergeRetry = 100 * time.Millisecond
	})
	s, _ := h.open()
	s.push(desired(1, &agentv1.NodeSpec{Site: &sitev1.SiteSpec{
		Boot:        &sitev1.BootLeaseState{Active: true, Epoch: 3, TtlMs: 15_000},
		CacheImages: []*sitev1.CacheImage{{Url: upstream.URL + "/installer.iso", Sha256: digest[:], Format: "iso"}},
	}}))
	for deadline := time.Now().Add(10 * time.Second); !h.agent.cache.has(hex.EncodeToString(digest[:])); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the ISO was never cached")
		}
	}

	cfg := BootConfig{URL: "http://10.20.0.2:8080", ServerIP: net.ParseIP("10.20.0.2")}
	unknown, _ := net.ParseMAC("b8:3f:d2:00:00:77")
	if _, ok := h.agent.pxeAnswer(cfg, pxe.Request{MAC: unknown, Arch: pxe.ArchEFIx86_64, UUID: "4c4c4544-0077", Relay: net.ParseIP("10.30.0.1")}); ok {
		t.Fatal("answered an unknown machine")
	}
	st := s.next(t, "status with the discovered machine", func(f *agentv1.AgentFrame) bool {
		return len(f.GetStatus().GetDiscovered()) == 1
	}).GetStatus()
	if m := st.GetDiscovered()[0]; m.GetMac() != "b8:3f:d2:00:00:77" || m.GetProductUuid() != "4c4c4544-0077" || m.GetArch() != "x86_64-efi" || m.GetRelay() != "10.30.0.1" {
		t.Fatalf("discovered = %v", m)
	}

	// Prepared to sanboot the ISO: the script is iPXE's sanboot of the cached image, and the machine
	// is no longer unknown.
	entry := &sitev1.ProxyDhcpEntry{Mac: "b8:3f:d2:00:00:77", WorkflowId: "wf_iso", SanbootSha256: digest[:],
		NotAfter: timestamppb.New(time.Now().Add(time.Hour))}
	s.push(command(body("p1", "boot.prepareRamdisk", entry)))
	s.update(t, "p1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	if got := h.agent.discovery.list(time.Now()); len(got) != 0 {
		t.Fatalf("still discovered: %v", got)
	}
	srv := httptest.NewServer(h.agent.BootHandler(cfg))
	defer srv.Close()
	get := func(mac string) (int, string) {
		resp, err := http.Get(srv.URL + "/boot/ipxe?mac=" + mac)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	code, script := get("b8:3f:d2:00:00:77")
	if code != http.StatusOK || script != "#!ipxe\nsanboot --no-describe http://10.20.0.2:8080/cache/"+hex.EncodeToString(digest[:])+"\n" {
		t.Fatalf("sanboot script (%d):\n%s", code, script)
	}
	// An entry naming an image the site does not cache as an iso never boots, and fails the site.
	other := sha256.Sum256([]byte("not cached"))
	bad := &sitev1.ProxyDhcpEntry{Mac: "b8:3f:d2:00:00:78", SanbootSha256: other[:], NotAfter: timestamppb.New(time.Now().Add(time.Hour))}
	s.push(command(body("p2", "boot.prepareRamdisk", bad)))
	s.update(t, "p2", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	if code, script := get("b8:3f:d2:00:00:78"); code != http.StatusServiceUnavailable || strings.Contains(script, "kernel") {
		t.Fatalf("an uncached sanboot (%d):\n%s", code, script)
	}
	if problems := h.agent.sanbootProblems(time.Now()); len(problems) != 1 || !strings.Contains(problems[0], "b8:3f:d2:00:00:78") {
		t.Fatalf("problems = %v", problems)
	}
}
