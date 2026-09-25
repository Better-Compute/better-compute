package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const testNode = "node_test1"

// ---- a gateway in memory -----------------------------------------------------------------------

type fakeStream struct {
	ctx       context.Context
	toAgent   chan *agentv1.ServerFrame
	fromAgent chan *agentv1.AgentFrame
}

func (s *fakeStream) Send(f *agentv1.AgentFrame) error {
	select {
	case s.fromAgent <- f:
		return nil
	case <-s.ctx.Done():
		return s.ctx.Err()
	}
}

func (s *fakeStream) Receive() (*agentv1.ServerFrame, error) {
	select {
	case f, ok := <-s.toAgent:
		if !ok {
			return nil, io.EOF
		}
		return f, nil
	case <-s.ctx.Done():
		return nil, s.ctx.Err()
	}
}

func (s *fakeStream) CloseRequest() error  { return nil }
func (s *fakeStream) CloseResponse() error { return nil }

type gateway struct {
	t       *testing.T
	streams chan *fakeStream
}

func newGateway(t *testing.T) *gateway {
	return &gateway{t: t, streams: make(chan *fakeStream, 4)}
}

func (g *gateway) dial(ctx context.Context) (Stream, error) {
	s := &fakeStream{ctx: ctx, toAgent: make(chan *agentv1.ServerFrame, 64), fromAgent: make(chan *agentv1.AgentFrame, 256)}
	g.streams <- s
	return s, nil
}

func (g *gateway) accept() *fakeStream {
	g.t.Helper()
	select {
	case s := <-g.streams:
		return s
	case <-time.After(5 * time.Second):
		g.t.Fatal("the agent did not dial")
		return nil
	}
}

func (s *fakeStream) push(f *agentv1.ServerFrame) { s.toAgent <- f }

// next returns the next frame the agent sent that satisfies match, skipping the others.
func (s *fakeStream) next(t *testing.T, what string, match func(*agentv1.AgentFrame) bool) *agentv1.AgentFrame {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case f := <-s.fromAgent:
			if match(f) {
				return f
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
			return nil
		}
	}
}

func (s *fakeStream) update(t *testing.T, id string, state commonv1.CommandState) *agentv1.CommandUpdate {
	t.Helper()
	return s.next(t, id+" "+state.String(), func(f *agentv1.AgentFrame) bool {
		u := f.GetUpdate()
		return u != nil && u.GetCommandId() == id && u.GetState() == state
	}).GetUpdate()
}

func welcome(sections ...string) *agentv1.ServerFrame {
	return &agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Welcome{Welcome: &agentv1.Welcome{
		Epoch: 1, SessionId: "s1", HeartbeatIntervalMs: 60_000, ServerTime: timestamppb.Now(), RequestSections: sections,
	}}}
}

// ---- a host in memory --------------------------------------------------------------------------

type fakeHost struct {
	mu      sync.Mutex
	boot    string
	root    string
	inv     *inventory.NodeInventory
	reboots []string
	onBoot  func()
}

func (h *fakeHost) BootID() (string, error) { return h.boot, nil }
func (h *fakeHost) Hostname() string        { return "fake" }
func (h *fakeHost) Inventory() (*inventory.NodeInventory, error) {
	return h.inv, nil
}
func (h *fakeHost) Reboot(reason string) error {
	h.mu.Lock()
	h.reboots = append(h.reboots, reason)
	h.mu.Unlock()
	if h.onBoot != nil {
		h.onBoot()
	}
	return nil
}
func (h *fakeHost) Path(abs string) string { return filepath.Join(h.root, filepath.FromSlash(abs)) }

type harness struct {
	t      *testing.T
	j      journal.Journal
	host   *fakeHost
	gw     *gateway
	key    *ecdsa.PrivateKey
	state  *State
	agent  *Agent
	cancel context.CancelFunc
	done   chan struct{}
}

func newHarness(t *testing.T, mutate func(*Options)) *harness {
	t.Helper()
	key, err := pki.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{
		t:     t,
		j:     journal.NewMemory(testNode, journal.MemoryOptions{}),
		host:  &fakeHost{boot: "boot-1", root: t.TempDir(), inv: fakehw.Inventory(1)},
		gw:    newGateway(t),
		key:   key,
		state: &State{NodeID: testNode, SiteID: "site_1", TrustDomain: "compute.test", Role: "node"},
	}
	h.start(mutate)
	return h
}

func (h *harness) start(mutate func(*Options)) {
	h.t.Helper()
	o := Options{
		State:   h.state,
		Key:     h.key,
		DataDir: h.t.TempDir(),
		Journal: h.j,
		Host:    h.host,
		Dial:    h.gw.dial,
		Version: "0.1.0-test",
		Log:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	if os.Getenv("BCD_TEST_LOG") != "" {
		o.Log = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	if mutate != nil {
		mutate(&o)
	}
	a, err := New(o)
	if err != nil {
		h.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	h.agent, h.cancel, h.done = a, cancel, done
	go func() {
		_ = a.Run(ctx)
		close(done)
	}()
	h.t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			h.t.Error("the agent did not stop")
		}
	})
}

// open accepts the agent's session, checks Hello and welcomes it.
func (h *harness) open(sections ...string) (*fakeStream, *agentv1.Hello) {
	h.t.Helper()
	s := h.gw.accept()
	hello := s.next(h.t, "Hello", func(f *agentv1.AgentFrame) bool { return f.GetHello() != nil }).GetHello()
	s.push(welcome(sections...))
	return s, hello
}

func command(body *agentv1.CommandBody) *agentv1.ServerFrame {
	b, _ := proto.Marshal(body)
	return &agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Command{Command: &agentv1.Command{Body: b, Attempt: 1}}}
}

func body(id, kind string, payload proto.Message) *agentv1.CommandBody {
	b := &agentv1.CommandBody{
		Id: id, NodeId: testNode, Kind: kind, Lane: commonv1.Lane_LANE_CONTROL, RetrySafe: true,
		NotAfter: timestamppb.New(time.Now().Add(time.Minute)),
	}
	if payload != nil {
		b.Payload, _ = anypb.New(payload)
	}
	return b
}

func desired(generation uint64, spec *agentv1.NodeSpec) *agentv1.ServerFrame {
	b, _ := proto.Marshal(&agentv1.DesiredStateBody{
		NodeId: testNode, Generation: generation, SpecHash: []byte{byte(generation)},
		Spec: &agentv1.DesiredStateBody_Full{Full: spec},
	})
	return &agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Desired{Desired: &agentv1.DesiredState{Body: b}}}
}

func verifyNodeSig(t *testing.T, key *ecdsa.PrivateKey, purpose string, sig *commonv1.Signature, parts ...[]byte) {
	t.Helper()
	if sig == nil {
		t.Fatalf("%s: no node signature", purpose)
	}
	kid, _ := pki.KeyID(&key.PublicKey)
	if sig.GetKid() != kid || !pki.VerifyP1363(&key.PublicKey, pki.SigningInput(purpose, parts...), sig.GetSig()) {
		t.Fatalf("%s: the node signature does not verify", purpose)
	}
}

// ---- tests -------------------------------------------------------------------------------------

func TestSessionInventorySpecAndCommands(t *testing.T) {
	h := newHarness(t, nil)
	s, hello := h.open("gpus")
	if hello.GetNodeId() != testNode || hello.GetRole() != commonv1.AgentRole_AGENT_ROLE_NODE || hello.GetBootId() != "boot-1" {
		t.Fatalf("hello = %v", hello)
	}
	if len(hello.GetInventoryHashes()) != len(inventory.SectionNames()) || len(hello.GetDrivers()) != 1 {
		t.Fatalf("hello inventory/drivers = %d/%d", len(hello.GetInventoryHashes()), len(hello.GetDrivers()))
	}
	inv := s.next(t, "gpus section", func(f *agentv1.AgentFrame) bool { return f.GetInventory() != nil }).GetInventory()
	if inv.GetSection() != "gpus" || sha256.Sum256(inv.GetContent()) != [32]byte(inv.GetSha256()) {
		t.Fatalf("inventory = %s", inv.GetSection())
	}

	// A spec with a hold on two GPUs: CDI files, a node-signed AllocationBound, a converged status.
	gpus := fakehw.Inventory(1).Gpus.Gpus
	spec := &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{Assignments: []*agentv1.DeviceAssignment{{
		AllocationId: "alloc_1", ReservationId: "res_1", Binding: agentv1.Binding_BINDING_HOLD,
		Devices: []*agentv1.AssignedDevice{{Id: gpus[0].Uuid, DeviceClass: "gpu"}, {Id: gpus[1].Uuid, DeviceClass: "gpu"}},
	}}}}
	s.push(desired(1, spec))
	batch := s.next(t, "AllocationBound", func(f *agentv1.AgentFrame) bool { return f.GetEvents() != nil }).GetEvents()
	report := batch.GetEvents()[0].GetAttested()
	verifyNodeSig(t, h.key, pki.PurposeAttestedReport, report.GetNodeSig(), report.GetBody())
	rb := &agentv1.AttestedReportBody{}
	_ = proto.Unmarshal(report.GetBody(), rb)
	if rb.GetAllocationBound().GetAllocationId() != "alloc_1" || rb.GetBootId() != "boot-1" || batch.GetEvents()[0].GetSeq() != 1 {
		t.Fatalf("bound = %v", rb)
	}
	status := s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil }).GetStatus()
	if status.GetObservedGeneration() != 1 || status.GetAppliedGeneration() != 1 {
		t.Fatalf("status = %v", status)
	}
	if _, err := os.Stat(h.host.Path("/etc/cdi/bcd-alloc_1.json")); err != nil {
		t.Fatal(err)
	}
	env, _ := os.ReadFile(h.host.Path("/run/bcd/allocations/alloc_1.env"))
	if want := "BCD_ALLOCATION_ID=alloc_1\nBCD_RESERVATION_ID=res_1\nNVIDIA_VISIBLE_DEVICES=" + gpus[0].Uuid + "," + gpus[1].Uuid + "\n"; string(env) != want {
		t.Fatalf("env file = %q", env)
	}

	// An overlapping hold fails with AllocationFailed and the section FAILED; the first hold stays.
	spec2 := proto.Clone(spec).(*agentv1.NodeSpec)
	spec2.Devices.Assignments = append(spec2.Devices.Assignments, &agentv1.DeviceAssignment{
		AllocationId: "alloc_2", Binding: agentv1.Binding_BINDING_HOLD,
		Devices: []*agentv1.AssignedDevice{{Id: gpus[1].Uuid}},
	})
	s.push(desired(2, spec2))
	failed := s.next(t, "AllocationFailed", func(f *agentv1.AgentFrame) bool {
		return f.GetEvents() != nil && f.GetEvents().GetEvents()[0].GetAllocationFailed() != nil
	}).GetEvents().GetEvents()[0].GetAllocationFailed()
	if failed.GetReason() != "overlap" || failed.GetGeneration() != 2 {
		t.Fatalf("failed = %v", failed)
	}
	status = s.next(t, "failed status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil }).GetStatus()
	if status.GetObservedGeneration() != 2 || status.GetSections()[1].GetState() != agentv1.SectionState_SECTION_STATE_FAILED {
		t.Fatalf("status = %v", status)
	}

	// diag.nvml is attested: ACKED, RUNNING, then a node-signed SUCCEEDED.
	diag := body("cmd_diag", "diag.nvml", &agentv1.DiagNvmlRequest{ExpectedGpuCount: 8})
	diag.Attested = true
	s.push(command(diag))
	s.update(t, "cmd_diag", commonv1.CommandState_COMMAND_STATE_ACKED)
	s.update(t, "cmd_diag", commonv1.CommandState_COMMAND_STATE_RUNNING)
	done := s.update(t, "cmd_diag", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	result := &agentv1.DiagNvmlResult{}
	_ = proto.Unmarshal(done.GetResult(), result)
	if !result.GetPassed() || result.GetGpuCount() != 8 {
		t.Fatalf("diag = %v", result)
	}
	var state [4]byte
	binary.BigEndian.PutUint32(state[:], uint32(done.GetState()))
	digest := sha256.Sum256(done.GetResult())
	verifyNodeSig(t, h.key, pki.PurposeCommandUpdate, done.GetNodeSig(), []byte("cmd_diag"), state[:], digest[:])

	// A duplicate delivery resends the stored result without running again.
	s.push(command(diag))
	again := s.update(t, "cmd_diag", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	if !proto.Equal(again.GetNodeSig(), done.GetNodeSig()) && again.GetNodeSig() == nil {
		t.Fatal("the resent result lost its signature")
	}

	// Past not_after: REJECTED/EXPIRED, journaled (a duplicate gets the same answer).
	expired := body("cmd_old", "inventory.refresh", nil)
	expired.NotAfter = timestamppb.New(time.Now().Add(-time.Second))
	s.push(command(expired))
	if u := s.update(t, "cmd_old", commonv1.CommandState_COMMAND_STATE_REJECTED); u.GetRejectReason() != commonv1.CommandRejectReason_COMMAND_REJECT_REASON_EXPIRED {
		t.Fatalf("expired = %v", u)
	}
	unknown := body("cmd_x", "wipe", nil)
	s.push(command(unknown))
	if u := s.update(t, "cmd_x", commonv1.CommandState_COMMAND_STATE_REJECTED); u.GetRejectReason() != commonv1.CommandRejectReason_COMMAND_REJECT_REASON_UNSUPPORTED {
		t.Fatalf("unsupported = %v", u)
	}

	// min_generation above the applied spec: SpecRequest, then it runs once the spec arrives.
	waiting := body("cmd_wait", "inventory.refresh", &agentv1.InventoryRefreshRequest{Sections: []string{"system"}})
	waiting.MinGeneration = 3
	s.push(command(waiting))
	req := s.next(t, "SpecRequest", func(f *agentv1.AgentFrame) bool { return f.GetSpecRequest() != nil }).GetSpecRequest()
	if req.GetReason() != agentv1.SpecRequestReason_SPEC_REQUEST_REASON_MIN_GENERATION || req.GetHaveGeneration() != 2 {
		t.Fatalf("spec request = %v", req)
	}
	s.push(desired(3, spec))
	refreshed := s.update(t, "cmd_wait", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	rr := &agentv1.InventoryRefreshResult{}
	_ = proto.Unmarshal(refreshed.GetResult(), rr)
	if len(rr.GetSectionHashes()) != 1 || rr.GetSectionHashes()["system"] == nil {
		t.Fatalf("refresh = %v", rr)
	}

	// A deferred command can be cancelled.
	later := body("cmd_later", "inventory.refresh", nil)
	later.MinGeneration = 9
	s.push(command(later))
	s.next(t, "SpecRequest", func(f *agentv1.AgentFrame) bool { return f.GetSpecRequest() != nil })
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Cancel{Cancel: &agentv1.Cancel{CommandId: "cmd_later"}}})
	s.update(t, "cmd_later", commonv1.CommandState_COMMAND_STATE_CANCELLED)

	// Acks stop the replay: after a reconnect, Hello carries only unacked results.
	meta, _ := h.j.Meta()
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Ack{Ack: &agentv1.Ack{
		JournalId: meta.JournalID, EventSeq: 2, CommandIds: []string{"cmd_diag", "cmd_old", "cmd_x"},
	}}})
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Drain{Drain: &agentv1.Drain{ReconnectAfterMs: 1}}})
	s2, hello2 := h.open()
	var ids []string
	for _, u := range hello2.GetUnackedResults() {
		ids = append(ids, u.GetCommandId())
	}
	if len(ids) != 2 || hello2.GetAppliedGeneration() != 3 || hello2.GetLastEpoch() != 1 {
		t.Fatalf("hello after reconnect: unacked %v, applied %d, epoch %d", ids, hello2.GetAppliedGeneration(), hello2.GetLastEpoch())
	}
	_ = s2
}

func TestRebootCompletesAfterRestart(t *testing.T) {
	h := newHarness(t, nil)
	h.host.onBoot = func() { go h.cancel() } // the process dies with the reboot
	s, _ := h.open()
	reboot := body("cmd_reboot", "node.reboot", &agentv1.NodeRebootRequest{Reason: "test"})
	reboot.SelfTerminating = true
	s.push(command(reboot))
	s.update(t, "cmd_reboot", commonv1.CommandState_COMMAND_STATE_ACKED)
	s.update(t, "cmd_reboot", commonv1.CommandState_COMMAND_STATE_RUNNING)
	select {
	case <-h.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the agent did not stop at the reboot")
	}
	if len(h.host.reboots) != 1 {
		t.Fatalf("reboots = %v", h.host.reboots)
	}
	// Next boot: the journal completes it as SUCCEEDED{rebooted} with the previous boot id.
	h.host.boot = "boot-2"
	h.host.onBoot = nil
	h.start(nil)
	_, hello := h.open()
	if len(hello.GetUnackedResults()) != 1 {
		t.Fatalf("unacked = %v", hello.GetUnackedResults())
	}
	u := hello.GetUnackedResults()[0]
	res := &agentv1.NodeRebootResult{}
	_ = proto.Unmarshal(u.GetResult(), res)
	if u.GetState() != commonv1.CommandState_COMMAND_STATE_SUCCEEDED || !u.GetRebooted() || u.GetBootId() != "boot-2" || res.GetPreviousBootId() != "boot-1" {
		t.Fatalf("reboot result = %v (%v)", u, res)
	}
}

func TestBusyWhenTheLaneIsFull(t *testing.T) {
	release := make(chan struct{})
	block := &Kind{
		Name: "block", Lane: dispatch.LaneControl, Roles: []dispatch.Role{dispatch.RoleNode},
		Exec: func(ctx context.Context, _ dispatch.Command) (journal.Result, error) {
			<-release
			return journal.Result{}, nil
		},
	}
	h := newHarness(t, func(o *Options) {
		o.Kinds = []*Kind{block}
		o.Lanes = map[dispatch.Lane]dispatch.LaneConfig{
			dispatch.LaneControl: {Credits: 1, Workers: 1}, dispatch.LaneProvision: {Credits: 1, Workers: 1}, dispatch.LaneBulk: {Credits: 1, Workers: 1},
		}
	})
	defer close(release)
	s, _ := h.open()
	s.push(command(body("b1", "block", nil)))
	s.update(t, "b1", commonv1.CommandState_COMMAND_STATE_RUNNING)
	s.push(command(body("b2", "block", nil)))
	if u := s.update(t, "b2", commonv1.CommandState_COMMAND_STATE_REJECTED); u.GetRejectReason() != commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BUSY {
		t.Fatalf("b2 = %v", u)
	}
	// BUSY is not journaled: the command is new again on redelivery.
	if _, ok, _ := h.j.Command("b2"); ok {
		t.Fatal("BUSY was journaled")
	}
}

// ---- signed intent -----------------------------------------------------------------------------

type signer struct {
	root  []byte
	key   *ecdsa.PrivateKey
	chain [][]byte
}

func newSigner(t *testing.T, role string) *signer {
	t.Helper()
	rootKey, _ := pki.GenerateKey()
	now := time.Now()
	rootTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "root"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	root, err := x509.CreateCertificate(rand.Reader, rootTmpl, rootTmpl, &rootKey.PublicKey, rootKey)
	if err != nil {
		t.Fatal(err)
	}
	rootCert, _ := x509.ParseCertificate(root)
	key, _ := pki.GenerateKey()
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "worker", OrganizationalUnit: []string{pki.RolePrefix + role}},
		NotBefore:    now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature,
	}
	leaf, err := x509.CreateCertificate(rand.Reader, leafTmpl, rootCert, &key.PublicKey, rootKey)
	if err != nil {
		t.Fatal(err)
	}
	return &signer{root: root, key: key, chain: [][]byte{leaf}}
}

func (s *signer) sign(t *testing.T, purpose string, b []byte) *commonv1.Signature {
	sig, err := pki.SignP1363(s.key, pki.SigningInput(purpose, b))
	if err != nil {
		t.Fatal(err)
	}
	return &commonv1.Signature{Kid: "worker", Sig: sig, Chain: s.chain}
}

func TestSignedIntentWithRoots(t *testing.T) {
	worker := newSigner(t, "worker")
	h := newHarness(t, func(o *Options) {
		o.State.TrustRoots = [][]byte{worker.root}
		o.State.TrustVersion = 1
	})
	s, _ := h.open()

	// Destructive and unsigned: BAD_SIGNATURE. Signed by a worker: accepted.
	s.push(command(body("r1", "node.reboot", &agentv1.NodeRebootRequest{DelayMs: 60_000})))
	if u := s.update(t, "r1", commonv1.CommandState_COMMAND_STATE_REJECTED); u.GetRejectReason() != commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BAD_SIGNATURE {
		t.Fatalf("unsigned reboot = %v", u)
	}
	b, _ := proto.Marshal(body("r2", "node.reboot", &agentv1.NodeRebootRequest{DelayMs: 60_000}))
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Command{Command: &agentv1.Command{Body: b, Signature: worker.sign(t, pki.PurposeCommand, b)}}})
	s.update(t, "r2", commonv1.CommandState_COMMAND_STATE_ACKED)

	// A present signature is always checked, even on a kind that needs none.
	nb, _ := proto.Marshal(body("i1", "inventory.refresh", nil))
	bad := worker.sign(t, pki.PurposeDesiredState, nb) // the wrong purpose
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Command{Command: &agentv1.Command{Body: nb, Signature: bad}}})
	if u := s.update(t, "i1", commonv1.CommandState_COMMAND_STATE_REJECTED); u.GetRejectReason() != commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BAD_SIGNATURE {
		t.Fatalf("mis-signed refresh = %v", u)
	}
	// A node-role certificate under the same root is no signer.
	notWorker := newSigner(t, "node")
	h.agent.mu.Lock()
	h.agent.state.TrustRoots = append(h.agent.state.TrustRoots, notWorker.root)
	h.agent.mu.Unlock()
	nb2, _ := proto.Marshal(body("i2", "inventory.refresh", nil))
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Command{Command: &agentv1.Command{Body: nb2, Signature: notWorker.sign(t, pki.PurposeCommand, nb2)}}})
	s.update(t, "i2", commonv1.CommandState_COMMAND_STATE_REJECTED)

	// With roots, every spec must be signed: an unsigned one is not applied.
	s.push(desired(5, &agentv1.NodeSpec{}))
	time.Sleep(200 * time.Millisecond)
	h.agent.mu.Lock()
	applied := h.agent.applied
	h.agent.mu.Unlock()
	if applied != 0 {
		t.Fatalf("an unsigned spec was applied (generation %d)", applied)
	}
	f := desired(5, &agentv1.NodeSpec{})
	f.GetDesired().Signature = worker.sign(t, pki.PurposeDesiredState, f.GetDesired().GetBody())
	s.push(f)
	status := s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil }).GetStatus()
	if status.GetAppliedGeneration() != 5 {
		t.Fatalf("status = %v", status)
	}
}

func TestUnknownSectionIsUnsupported(t *testing.T) {
	h := newHarness(t, nil)
	s, _ := h.open()
	spec := &agentv1.NodeSpec{Host: &agentv1.HostSection{Units: []*agentv1.ConfigUnit{{Unit: "sysctl", ConfigJson: "{}"}}}}
	// Field 42: a section from a newer control plane.
	spec.ProtoReflect().SetUnknown(protowire.AppendBytes(protowire.AppendTag(nil, 42, protowire.BytesType), []byte{1}))
	s.push(desired(1, spec))
	status := s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil }).GetStatus()
	reasons := map[string]bool{}
	for _, c := range status.GetConditions() {
		reasons[c.GetReason()] = true
	}
	if !reasons["1"] || !reasons["42"] || status.GetObservedGeneration() != 1 {
		t.Fatalf("status = %v", status)
	}
}

func TestJoinPersistsIdentity(t *testing.T) {
	// A deferral first, then the signed answer; Join keeps the CSR and stores key and identity.
	f := joinFixture(t)
	dir := t.TempDir()
	state, err := Join(context.Background(), JoinOptions{
		Client:        f,
		Token:         "bcjt_join_01k5w0000000000000000000000." + strings.Repeat("A", 43),
		EncryptionKey: &f.encKey.PublicKey,
		SignerPin:     f.pin,
		Claims:        Claims(fakehw.Inventory(1), "fake", "boot-1"),
		DataDir:       dir,
		Sleep:         func(context.Context, time.Duration) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if state.NodeID != f.nodeID || f.calls != 2 || len(f.csrs) != 2 || string(f.csrs[0]) != string(f.csrs[1]) {
		t.Fatalf("state %+v after %d calls", state, f.calls)
	}
	loaded, key, err := LoadState(dir)
	if err != nil || loaded.NodeID != f.nodeID || key == nil {
		t.Fatalf("LoadState = %+v, %v", loaded, err)
	}
	if _, _, err := LoadState(t.TempDir()); !errors.Is(err, ErrNotJoined) {
		t.Fatalf("empty dir: %v", err)
	}
}

// A gateway cannot move the daemon's server time back (into an old worker certificate's window, to
// replay old signed intent): a Welcome before the persisted high-water mark is refused.
func TestWelcomeCannotMoveServerTimeBack(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Backoff.Min, o.Backoff.Max = time.Millisecond, 10*time.Millisecond })
	s, _ := h.open()
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Drain{Drain: &agentv1.Drain{ReconnectAfterMs: 1}}})
	s2 := h.gw.accept()
	s2.next(t, "Hello", func(f *agentv1.AgentFrame) bool { return f.GetHello() != nil })
	old := welcome()
	old.GetWelcome().ServerTime = timestamppb.New(time.Now().Add(-time.Hour))
	s2.push(old)
	select {
	case <-s2.ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("a Welcome an hour in the past was accepted")
	}
	meta, _ := h.j.Meta()
	if time.Since(meta.ServerTime) > time.Minute {
		t.Fatalf("high-water mark = %v", meta.ServerTime)
	}
	// A current Welcome on the redial is fine.
	s3, _ := h.open()
	s3.push(command(body("ok", "inventory.refresh", nil)))
	s3.update(t, "ok", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
}
