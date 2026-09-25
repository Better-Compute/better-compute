package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	sitev1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/site/v1"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func siteHarness(t *testing.T) *harness {
	return newHarness(t, func(o *Options) { o.State.Role = "site" })
}

// answerSecrets answers every SecretRequest with value (sealed to its one-time key).
func answerSecret(t *testing.T, s *fakeStream, value string) *agentv1.SecretRequest {
	t.Helper()
	req := s.next(t, "SecretRequest", func(f *agentv1.AgentFrame) bool { return f.GetSecretRequest() != nil }).GetSecretRequest()
	epk, _ := pki.PublicKeyFromPoint(req.GetEpk())
	jwe, _ := pki.SealJWE([]byte(value), epk, map[string]any{"typ": pki.SecretResponseType, "ref": req.GetRef(), "rid": req.GetRequestId()})
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Secret{Secret: &agentv1.SecretResponse{Ref: req.GetRef(), RequestId: req.GetRequestId(), Jwe: jwe}}})
	return req
}

func TestSiteBMCAndBootEntries(t *testing.T) {
	h := siteHarness(t)
	s, _ := h.open()

	// A BMC nobody answers: the command succeeds, the result says ok=false with a code.
	bmc := body("b1", "bmc.query", &sitev1.BmcOperationRequest{
		Driver: "redfish", Address: "https://127.0.0.1:1", CredentialsRef: "secret://t/bmc", Operation: "power.getPower",
	})
	bmc.WorkflowId, bmc.StepId = "wf_1", "power"
	s.push(command(bmc))
	if req := answerSecret(t, s, `{"username":"admin","password":"pw"}`); req.GetWorkflowId() != "wf_1" {
		t.Fatalf("credentials fetched for %v", req)
	}
	done := s.update(t, "b1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	res := &sitev1.BmcOperationResult{}
	_ = proto.Unmarshal(done.GetResult(), res)
	if res.GetOk() || res.GetErrorCode() != "unreachable" {
		t.Fatalf("bmc = %v", res)
	}
	s.push(command(body("b2", "bmc.query", &sitev1.BmcOperationRequest{Driver: "ipmi", Address: "10.0.0.1", Operation: "power.getPower"})))
	done = s.update(t, "b2", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	_ = proto.Unmarshal(done.GetResult(), res)
	if res.GetErrorCode() != "unsupported-driver" {
		t.Fatalf("ipmi = %v", res)
	}

	// Boot entries persist and lapse; cleanUp drops a workflow's.
	entry := &sitev1.ProxyDhcpEntry{Mac: "B8:3F:D2:00:00:01", WorkflowId: "wf_1", NotAfter: timestamppb.New(time.Now().Add(time.Hour))}
	s.push(command(body("p1", "boot.prepareRamdisk", entry)))
	s.update(t, "p1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	if e := h.agent.boot.Get("b8:3f:d2:00:00:01", time.Now()); e == nil || e.GetWorkflowId() != "wf_1" {
		t.Fatalf("entry = %v", e)
	}
	if again := newBootEntries(h.agent.o.DataDir); again.Get("b8:3f:d2:00:00:01", time.Now()) == nil {
		t.Fatal("the entry was not persisted")
	}
	if h.agent.boot.Get("b8:3f:d2:00:00:01", time.Now().Add(2*time.Hour)) != nil {
		t.Fatal("a lapsed entry answered")
	}
	s.push(command(body("c1", "boot.cleanUp", &sitev1.BootCleanUpRequest{WorkflowId: "wf_1"})))
	s.update(t, "c1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	if h.agent.boot.Get("b8:3f:d2:00:00:01", time.Now()) != nil {
		t.Fatal("cleanUp left the entry")
	}
	if _, err := os.Stat(filepath.Join(h.agent.o.DataDir, "boot-entries.json")); err != nil {
		t.Fatal(err)
	}
	// The site kinds are the site's only.
	if _, ok := h.agent.reg.Lookup("bmc.power", "node"); ok {
		t.Fatal("bmc.power allowed on a node")
	}
}

// An operation runs only under its own kind (the kind decides signing and retry safety), and a
// firmware image reaches a BMC only through the verified site cache.
func TestBMCOperationsKeepToTheirKind(t *testing.T) {
	h := siteHarness(t)
	s, _ := h.open()
	for i, c := range []struct{ kind, op string }{
		{"bmc.query", "power.setPower"},
		{"bmc.query", "raid.applyLayout"},
		{"bmc.boot", "firmware.update"},
		{"bmc.power", "management.rotateCredential"},
	} {
		id := "k" + string(rune('0'+i))
		s.push(command(body(id, c.kind, &sitev1.BmcOperationRequest{Driver: "redfish", Address: "10.0.0.1", CredentialsRef: "secret://t/bmc", Operation: c.op})))
		if u := s.update(t, id, commonv1.CommandState_COMMAND_STATE_FAILED); u.GetError().GetCode() != "invalid-payload" {
			t.Fatalf("%s under %s = %v", c.op, c.kind, u)
		}
	}

	// firmware.update without a boot server (no cache to serve from) is refused, never forwarded.
	fw := &sitev1.BmcOperationRequest{Driver: "redfish", Address: "https://127.0.0.1:1", CredentialsRef: "secret://t/bmc", Operation: "firmware.update",
		ArgsJson: `{"component":"BIOS","url":"https://images.example/bios.bin","sha256":"` + strings.Repeat("ab", 32) + `"}`}
	s.push(command(body("f1", "bmc.firmware", fw)))
	answerSecret(t, s, `{"username":"admin","password":"pw"}`)
	res := &sitev1.BmcOperationResult{}
	_ = proto.Unmarshal(s.update(t, "f1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED).GetResult(), res)
	if res.GetOk() || res.GetErrorCode() != "image-unverified" {
		t.Fatalf("firmware without a cache = %v", res)
	}

	// With a boot server: the image is pulled and verified first, and a wrong digest never reaches
	// the BMC.
	image := []byte("firmware image")
	sum := sha256.Sum256(image)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(image) }))
	defer upstream.Close()
	h.agent.BootHandler(BootConfig{URL: "http://10.0.0.2:8080"})
	cached, err := h.agent.verifiedFirmware(context.Background(), upstream.URL+"/bios.bin", hex.EncodeToString(sum[:]))
	if err != nil || cached != "http://10.0.0.2:8080/cache/"+hex.EncodeToString(sum[:]) || !h.agent.cache.has(hex.EncodeToString(sum[:])) {
		t.Fatalf("verified firmware = %q, %v", cached, err)
	}
	if _, err := h.agent.verifiedFirmware(context.Background(), upstream.URL+"/bios.bin", strings.Repeat("cd", 32)); err == nil {
		t.Fatal("an image with another digest was cached")
	}
}

func TestHTTPProxyRefusesTargetsOutsideTheSite(t *testing.T) {
	h := siteHarness(t)
	s, _ := h.open()
	for i, target := range []string{"http://127.0.0.1:8080/", "http://169.254.169.254/latest/meta-data", "https://8.8.8.8/", "ftp://10.0.0.1/"} {
		id := "x" + string(rune('0'+i))
		s.push(command(body(id, "site.httpProxy", &sitev1.HttpProxyRequest{TargetNodeId: "node_1", Url: target})))
		if u := s.update(t, id, commonv1.CommandState_COMMAND_STATE_FAILED); u.GetError().GetCode() != "forbidden-target" {
			t.Fatalf("%s = %v", target, u)
		}
	}
	// A BMC is never a proxy target: a host this agent drove as a BMC, or a Redfish path.
	h.agent.rememberBMC("https://10.0.0.9:8443/redfish/v1/Systems/1")
	for i, target := range []string{"https://10.0.0.9/anything", "http://10.0.0.8/redfish/v1/Systems/1/Actions/ComputerSystem.Reset", "http://10.0.0.8/a/../REDFISH/v1"} {
		id := "b" + string(rune('0'+i))
		s.push(command(body(id, "site.httpProxy", &sitev1.HttpProxyRequest{TargetNodeId: "node_1", Url: target, Method: "POST"})))
		if u := s.update(t, id, commonv1.CommandState_COMMAND_STATE_FAILED); u.GetError().GetCode() != "forbidden-target" {
			t.Fatalf("%s = %v", target, u)
		}
	}
	if !h.agent.knownBMC("10.0.0.9") || h.agent.knownBMC("10.0.0.10") {
		t.Fatal("remembered BMC hosts")
	}
	if k, _ := h.agent.reg.Lookup("site.httpProxy", "site"); !k.Destructive {
		t.Fatal("site.httpProxy is not destructive")
	}
	for _, ip := range []string{"10.20.0.7", "192.168.1.2", "fd00::1", "100.64.3.4"} {
		if !siteAddress(net.ParseIP(ip)) {
			t.Errorf("%s is a site address", ip)
		}
	}
}

func TestParseCredentialForms(t *testing.T) {
	if c := parseCredential([]byte(`{"username":"root","password":"p"}`), "x"); c.Username != "root" || c.Password != "p" {
		t.Fatalf("json = %+v", c)
	}
	if c := parseCredential([]byte("bare-pw\n"), "admin"); c.Username != "admin" || c.Password != "bare-pw" {
		t.Fatalf("bare = %+v", c)
	}
}
