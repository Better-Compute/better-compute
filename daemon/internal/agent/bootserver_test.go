package agent

import (
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
	"github.com/better-compute/better-compute/daemon/internal/bootparams"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/pxe"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func TestBootServerRendersARamdiskScript(t *testing.T) {
	h := siteHarness(t)
	s, _ := h.open()
	cfg := BootConfig{
		Kernel: "http://10.20.0.2:8080/ramdisk/vmlinuz", Initrd: "http://10.20.0.2:8080/ramdisk/initrd", Cmdline: "console=ttyS0",
		Join: bootparams.Params{
			Gateway: "https://gw.example.com", Site: "site_1", ServingCAPin: "sha256/A=", JoinSigningPin: "sha256/B=",
			JoinEncryptionPin: "sha256/C=", JWK: []byte(`{"kty":"EC"}`),
		},
	}
	srv := httptest.NewServer(h.agent.BootHandler(cfg))
	defer srv.Close()
	get := func(query string) (int, string) {
		resp, err := http.Get(srv.URL + "/boot/ipxe?" + query)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	// Without the boot lease nothing is served.
	if code, _ := get("mac=b8:3f:d2:00:00:01"); code != http.StatusServiceUnavailable {
		t.Fatalf("without the lease = %d", code)
	}
	spec := &agentv1.NodeSpec{Site: &sitev1.SiteSpec{Boot: &sitev1.BootLeaseState{Active: true, Epoch: 7, TtlMs: 15_000}}}
	s.push(desired(1, spec))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil })
	if code, _ := get("mac=b8:3f:d2:00:00:09"); code != http.StatusNotFound {
		t.Fatalf("unknown machine = %d", code)
	}
	entry := &sitev1.ProxyDhcpEntry{
		Mac: "B8:3F:D2:00:00:01", WorkflowId: "wf_1", DiscoveryTokenRef: "secret://t/disc",
		NotAfter: timestamppb.New(time.Now().Add(time.Hour)),
	}
	s.push(command(body("p1", "boot.prepareRamdisk", entry)))
	s.update(t, "p1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)

	type reply struct {
		code int
		body string
	}
	replies := make(chan reply, 1)
	go func() {
		code, b := get("mac=b8:3f:d2:00:00:01&uuid=4C4C4544-0001&ip=10.20.0.50")
		replies <- reply{code, b}
	}()
	if req := answerSecret(t, s, "bcjt_disc_01k5w0000000000000000000000.token"); req.GetRef() != "secret://t/disc" || req.GetWorkflowId() != "wf_1" {
		t.Fatalf("token request = %v", req)
	}
	r := <-replies
	if r.code != http.StatusOK || !strings.HasPrefix(r.body, "#!ipxe\nkernel http://10.20.0.2:8080/ramdisk/vmlinuz ") ||
		!strings.Contains(r.body, "initrd --name initrd http://10.20.0.2:8080/ramdisk/initrd") || !strings.Contains(r.body, "console=ttyS0") {
		t.Fatalf("script (%d):\n%s", r.code, r.body)
	}
	// The kernel line is what bcd ramdisk parses; the assertion is ours, under the lease epoch.
	params, err := bootparams.Parse(strings.SplitN(r.body, "\n", 3)[1])
	if err != nil || params.Token != "bcjt_disc_01k5w0000000000000000000000.token" || params.Site != "site_1" {
		t.Fatalf("params = %+v, %v", params, err)
	}
	signed := &sitev1.SignedDiscoveryAssertion{}
	_ = proto.Unmarshal(params.Assertion, signed)
	if !pki.VerifyP1363(&h.key.PublicKey, pki.SigningInput(pki.PurposeDiscoveryAssertion, signed.GetBody()), signed.GetSig().GetSig()) {
		t.Fatal("the assertion is not signed by the site agent's key")
	}
	a := &sitev1.DiscoveryAssertion{}
	_ = proto.Unmarshal(signed.GetBody(), a)
	if a.GetBootLeaseEpoch() != 7 || a.GetMac() != "b8:3f:d2:00:00:01" || a.GetIp() != "10.20.0.50" || a.GetWorkflowId() != "wf_1" ||
		a.GetSiteAgentNodeId() != testNode || a.GetProductUuid() != "4c4c4544-0001" || !a.GetNotAfter().AsTime().After(time.Now()) {
		t.Fatalf("assertion = %v", a)
	}
	// A second fetch in the same boot reuses the token (no second SecretRequest).
	if code, _ := get("mac=b8:3f:d2:00:00:01"); code != http.StatusOK {
		t.Fatalf("refetch = %d", code)
	}
	// The PXE first stage answers the prepared machine only: firmware gets the iPXE build, iPXE the chain.
	pxeCfg := cfg
	pxeCfg.URL, pxeCfg.ServerIP = "http://10.20.0.2:8080", net.ParseIP("10.20.0.2")
	mac, _ := net.ParseMAC("b8:3f:d2:00:00:01")
	if ans, ok := h.agent.pxeAnswer(pxeCfg, pxe.Request{MAC: mac, Arch: pxe.ArchEFIx86_64}); !ok || ans.Bootfile != "ipxe.efi" || !ans.NextServer.Equal(pxeCfg.ServerIP) {
		t.Fatalf("firmware answer = %+v %v", ans, ok)
	}
	if ans, _ := h.agent.pxeAnswer(pxeCfg, pxe.Request{MAC: mac, IPXE: true}); ans.Bootfile != "http://10.20.0.2:8080/boot/chain.ipxe" {
		t.Fatalf("iPXE answer = %+v", ans)
	}
	if ans, _ := h.agent.pxeAnswer(pxeCfg, pxe.Request{MAC: mac, Arch: pxe.ArchHTTPx86_64}); ans.Bootfile != "http://10.20.0.2:8080/boot/files/ipxe.efi" {
		t.Fatalf("HTTP boot answer = %+v", ans)
	}
	other, _ := net.ParseMAC("b8:3f:d2:00:00:99")
	if _, ok := h.agent.pxeAnswer(pxeCfg, pxe.Request{MAC: other}); ok {
		t.Fatal("answered an unprepared machine")
	}
	chainSrv := httptest.NewServer(h.agent.BootHandler(pxeCfg))
	defer chainSrv.Close()
	resp, _ := http.Get(chainSrv.URL + "/boot/chain.ipxe")
	chain, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(chain), "chain http://10.20.0.2:8080/boot/ipxe?mac=${net0/mac}&uuid=${uuid}") {
		t.Fatalf("chain script = %q", chain)
	}
	// Partitioned beyond the lease TTL: the agent fences itself.
	h.agent.mu.Lock()
	h.agent.lastContact = time.Now().Add(-time.Minute)
	h.agent.mu.Unlock()
	if code, _ := get("mac=b8:3f:d2:00:00:01"); code != http.StatusServiceUnavailable {
		t.Fatalf("fenced agent = %d", code)
	}
	if _, ok := h.agent.pxeAnswer(pxeCfg, pxe.Request{MAC: mac, Arch: pxe.ArchEFIx86_64}); ok {
		t.Fatal("a fenced agent answered PXE")
	}
}
