package agent

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/imds"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func vm(id string, state agentv1.InstanceDesiredState) *agentv1.InstanceSpec {
	return &agentv1.InstanceSpec{
		InstanceId: id, DesiredState: state, Runtime: "libvirt-kvm", AllocationId: "alloc_" + id, Vcpu: 2, MemoryBytes: 4 << 30,
		DiskBytes: 20 << 30, Image: &agentv1.ImageRef{Ref: "ubuntu", Url: "https://img/ubuntu.qcow2", Sha256: []byte{1, 2}, Format: "qcow2"},
		Nics: []*agentv1.InstanceNic{{Network: "br0", Mac: "52:54:00:00:00:01", Addresses: []string{"10.0.0.5/24"}}},
	}
}

func instanceStates(st *agentv1.StatusReport) map[string]agentv1.InstanceObservedState {
	out := map[string]agentv1.InstanceObservedState{}
	for _, i := range st.GetInstances() {
		out[i.GetInstanceId()] = i.GetState()
	}
	return out
}

// Review 13 H2: a restored instance's guest gets its own identity once it runs, and the status says
// which rebind ref it applied, after a bcd restart too.
func TestIdentityRebind(t *testing.T) {
	var fake *runtime.Fake
	dir := t.TempDir()
	h := newHarness(t, func(o *Options) {
		fake = &runtime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(dir, "runtime.json"), BootID: "boot-1"}
		o.Runtimes = []runtime.Runtime{fake}
	})
	s, _ := h.open()
	sbx := vm("inst_sbx", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	sbx.IdentityRebindRef = "secret://t/rebind"
	s.push(desired(1, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{sbx}}}))
	req := answerSecret(t, s, `{"v":1,"account":"sandbox","principals":"sandbox@inst_sbx\n"}`)
	if req.GetRef() != "secret://t/rebind" || req.GetAllocationId() != "alloc_inst_sbx" {
		t.Fatalf("bundle fetched as %v", req)
	}
	s.next(t, "status with the rebind applied", func(f *agentv1.AgentFrame) bool {
		for _, i := range f.GetStatus().GetInstances() {
			if i.GetInstanceId() == "inst_sbx" && i.GetIdentityReboundRef() == "secret://t/rebind" {
				return true
			}
		}
		return false
	})
	domains, _ := fake.List(context.Background())
	if len(domains) != 1 || domains[0].Principals != "sandbox@inst_sbx\n" {
		t.Fatalf("domains = %+v", domains)
	}
	if h.agent.reboundRef("inst_sbx") != "secret://t/rebind" {
		t.Fatal("the applied ref was not kept")
	}
	// Kept across restarts: a new agent over the same data directory reports it without asking again.
	h.agent.rebind = rebinds{}
	if h.agent.reboundRef("inst_sbx") != "secret://t/rebind" {
		t.Fatal("the applied ref was not persisted")
	}
}

func TestInstancesConverger(t *testing.T) {
	var fake *runtime.Fake
	h := newHarness(t, func(o *Options) {
		fake = &runtime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}
		o.Runtimes = []runtime.Runtime{fake}
	})
	s, hello := h.open()
	found := false
	for _, d := range hello.GetDrivers() {
		found = found || (d.GetId() == "libvirt-kvm" && d.GetKinds()[0] == "runtime")
	}
	if !found {
		t.Fatalf("Hello does not advertise the runtime: %v", hello.GetDrivers())
	}
	_ = fake.Leak("foreign-vm", runtime.StateRunning)

	web := vm("inst_web", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	web.UserDataRef = "secret://t/ud"
	warm := vm("inst_warm", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_PAUSED)
	odd := vm("inst_odd", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	odd.Runtime = "firecracker"
	s.push(desired(1, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web, warm, odd}}}))
	if req := answerSecret(t, s, "#cloud-config\n"); req.GetAllocationId() != "alloc_inst_web" {
		t.Fatalf("user data fetched for %v", req)
	}
	status := s.next(t, "status with instances", func(f *agentv1.AgentFrame) bool {
		return f.GetStatus() != nil && len(f.GetStatus().GetInstances()) >= 4
	}).GetStatus()
	got := instanceStates(status)
	if !status.GetInstancesComplete() || got["inst_web"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING ||
		got["inst_warm"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_PAUSED ||
		got["inst_odd"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_ERROR ||
		got["foreign-vm"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING {
		t.Fatalf("instances = %v", status.GetInstances())
	}
	domains, _ := fake.List(context.Background())
	for _, d := range domains {
		if d.ID == "inst_web" && (d.UserData != "#cloud-config\n" || d.Boots != 1) {
			t.Fatalf("web = %+v", d)
		}
	}

	// Dropped from the spec: removed. The foreign domain stays, untouched.
	s.push(desired(2, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web}}}))
	status = s.next(t, "status after removal", func(f *agentv1.AgentFrame) bool {
		return f.GetStatus().GetAppliedGeneration() == 2
	}).GetStatus()
	got = instanceStates(status)
	if _, still := got["inst_warm"]; still || got["foreign-vm"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING {
		t.Fatalf("after removal = %v", status.GetInstances())
	}

	// A host reboot stops the VMs; the converger starts the ones that should run.
	fake.BootID = "boot-2"
	s.push(desired(3, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web}}}))
	status = s.next(t, "status after reboot", func(f *agentv1.AgentFrame) bool {
		return f.GetStatus().GetAppliedGeneration() == 3
	}).GetStatus()
	if instanceStates(status)["inst_web"] != agentv1.InstanceObservedState_INSTANCE_OBSERVED_STATE_RUNNING {
		t.Fatalf("after reboot = %v", status.GetInstances())
	}
	domains, _ = fake.List(context.Background())
	for _, d := range domains {
		if d.ID == "inst_web" && d.Boots != 2 {
			t.Fatalf("web booted %d times", d.Boots)
		}
	}
}

func TestIMDSMintsForTheCallingInstance(t *testing.T) {
	var fake *runtime.Fake
	h := newHarness(t, func(o *Options) {
		fake = &runtime.Fake{RuntimeName: "libvirt-kvm", Path: filepath.Join(t.TempDir(), "runtime.json"), BootID: "boot-1"}
		o.Runtimes = []runtime.Runtime{fake}
	})
	s, _ := h.open()
	web := vm("inst_web", agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING)
	web.Nics[0].Addresses = []string{"10.0.0.5/24"}
	s.push(desired(1, &agentv1.NodeSpec{Instances: &agentv1.InstancesSection{Instances: []*agentv1.InstanceSpec{web}}}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return len(f.GetStatus().GetInstances()) == 1 })
	// The instance's requests arrive from its address on the bridge.
	from := "10.0.0.5:40000"
	service := h.agent.IMDS()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.RemoteAddr = from
		service.ServeHTTP(w, r)
	}))
	defer srv.Close()
	// A host-local caller is not an instance.
	from = "127.0.0.1:40000"
	probe, _ := http.NewRequest(http.MethodPut, srv.URL+"/latest/api/token", nil)
	probe.Header.Set(imds.SessionTTLHeader, "60")
	if resp, err := http.DefaultClient.Do(probe); err != nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("a loopback caller: %v %v", err, resp)
	}
	from = "10.0.0.5:40000"
	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/latest/api/token", nil)
	req.Header.Set(imds.SessionTTLHeader, "60")
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("session: %v %v", err, resp)
	}
	session, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	type got struct {
		code int
		body string
	}
	out := make(chan got, 1)
	go func() {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+"/latest/identity-token?audience=sts", nil)
		req.Header.Set(imds.SessionHeader, string(session))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			out <- got{0, err.Error()}
			return
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		out <- got{resp.StatusCode, string(b)}
	}()
	wreq := s.next(t, "WorkloadTokenRequest", func(f *agentv1.AgentFrame) bool { return f.GetWorkloadTokenRequest() != nil }).GetWorkloadTokenRequest()
	if wreq.GetInstanceId() != "inst_web" || wreq.GetAudience() != "sts" {
		t.Fatalf("request = %v", wreq)
	}
	epk, _ := pki.PublicKeyFromPoint(wreq.GetEpk())
	exp := time.Now().Add(5 * time.Minute)
	jwe, _ := pki.SealJWE([]byte("eyJ.workload"), epk, map[string]any{"typ": pki.WorkloadTokenResponseType, "rid": wreq.GetRequestId(), "iid": "inst_web", "exp": exp.Unix()})
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_WorkloadToken{WorkloadToken: &agentv1.WorkloadTokenResponse{
		RequestId: wreq.GetRequestId(), Jwe: jwe, ExpiresAt: timestamppb.New(exp)}}})
	if r := <-out; r.code != 200 || r.body != "eyJ.workload" {
		t.Fatalf("identity token = %+v", r)
	}
}
