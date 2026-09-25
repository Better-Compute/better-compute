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
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	driverv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1"
	"github.com/better-compute/better-compute/daemon/internal/bcx"
	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/structpb"
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
	mu         sync.Mutex
	boot       string
	root       string
	inv        *inventory.NodeInventory
	reboots    []string
	onBoot     func()
	sshReloads int
	kmsg       io.ReadCloser
	resets     []string
	// firewalls are the rulesets loaded; firewallErr fails the next loads; firewallGone says the
	// table was flushed away.
	firewalls    []string
	firewallErr  error
	firewallGone bool
}

func (h *fakeHost) CheckFirewall(context.Context, int) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.firewallGone {
		return errors.New("no such table")
	}
	return nil
}

func (h *fakeHost) ApplyFirewall(_ context.Context, ruleset string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.firewallErr != nil {
		return h.firewallErr
	}
	h.firewalls = append(h.firewalls, ruleset)
	return nil
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
func (h *fakeHost) Kmsg() (io.ReadCloser, error) {
	if h.kmsg == nil {
		return nil, os.ErrNotExist
	}
	return h.kmsg, nil
}
func (h *fakeHost) ResetGPU(_ context.Context, uuid string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.resets = append(h.resets, uuid)
	return nil
}
func (h *fakeHost) real() *RealHost { return &RealHost{Root: h.root, RebootFunc: h.Reboot} }
func (h *fakeHost) SecureErase(ctx context.Context, d *inventory.Disk, mode agentv1.WipeMode) (string, bool, error) {
	return h.real().SecureErase(ctx, d, mode)
}
func (h *fakeHost) RereadPartitions(ctx context.Context, d *inventory.Disk) error {
	return h.real().RereadPartitions(ctx, d)
}
func (h *fakeHost) InstallUserData(ctx context.Context, d *inventory.Disk, kind string, data []byte) error {
	return h.real().InstallUserData(ctx, d, kind, data)
}
func (h *fakeHost) InstallFiles(ctx context.Context, d *inventory.Disk, files map[string][]byte) error {
	return h.real().InstallFiles(ctx, d, files)
}
func (h *fakeHost) Kexec(ctx context.Context, d *inventory.Disk, kernel, initrd string, cmdline []string) error {
	return h.real().Kexec(ctx, d, kernel, initrd, cmdline)
}
func (h *fakeHost) RunDCGM(ctx context.Context, level uint32, uuids []string, gpus []*inventory.Gpu) (*agentv1.DiagDcgmResult, error) {
	return h.real().RunDCGM(ctx, level, uuids, gpus)
}
func (h *fakeHost) ReloadSSH() error {
	h.mu.Lock()
	h.sshReloads++
	h.mu.Unlock()
	return nil
}
func (h *fakeHost) Logs(_ context.Context, unit string, _ time.Duration) ([]byte, error) {
	return []byte(unit + ": started\nenv: BCD_JOIN_TOKEN=bcjt_join_01k5w0000000000000000000000.secretsecret\n"), nil
}

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
	// runErr is what Run returned (read after done is closed).
	runErr error
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
		err := a.Run(ctx)
		h.runErr = err
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
	// With roots every kind needs a signature, destructive or not.
	s.push(command(body("i0", "inventory.refresh", nil)))
	if u := s.update(t, "i0", commonv1.CommandState_COMMAND_STATE_REJECTED); u.GetRejectReason() != commonv1.CommandRejectReason_COMMAND_REJECT_REASON_BAD_SIGNATURE {
		t.Fatalf("unsigned refresh = %v", u)
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

func TestLogsCollectUploadsARedactedBundle(t *testing.T) {
	var got []byte
	var contentType string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.Header.Get("X-Upload") != "yes" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		got, _ = io.ReadAll(r.Body)
		contentType = r.Header.Get("Content-Type")
	}))
	defer srv.Close()
	h := newHarness(t, func(o *Options) { o.HTTPClient = srv.Client() })
	s, _ := h.open()
	req := &agentv1.LogsCollectRequest{
		UploadUrl:     srv.URL + "/bundle",
		UploadHeaders: []*agentv1.HttpHeader{{Name: "X-Upload", Value: "yes"}},
		Units:         []string{"bcd.service", "containerd.service"},
		SupportBundle: true,
	}
	logs := body("cmd_logs", "logs.collect", req)
	logs.Lane = commonv1.Lane_LANE_BULK
	s.push(command(logs))
	done := s.update(t, "cmd_logs", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	res := &agentv1.LogsCollectResult{}
	_ = proto.Unmarshal(done.GetResult(), res)
	text := string(got)
	if strings.Contains(text, "secretsecret") || !strings.Contains(text, "bcjt_[redacted]") ||
		!strings.Contains(text, "containerd.service: started") || !strings.Contains(text, "==> support <==") {
		t.Fatalf("bundle:\n%s", text)
	}
	if sum := sha256.Sum256(got); res.GetUploadedBytes() != uint64(len(got)) || string(res.GetSha256()) != string(sum[:]) || contentType != "text/plain" {
		t.Fatalf("result = %v", res)
	}
	// Truncated oldest first to max_bytes; plain http is refused.
	req.MaxBytes = 64
	small := body("cmd_small", "logs.collect", req)
	s.push(command(small))
	done = s.update(t, "cmd_small", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	_ = proto.Unmarshal(done.GetResult(), res)
	if !res.GetTruncated() || len(got) > 64 {
		t.Fatalf("truncated = %v, %d bytes", res.GetTruncated(), len(got))
	}
	req.UploadUrl = "http://example.com/x"
	s.push(command(body("cmd_http", "logs.collect", req)))
	if u := s.update(t, "cmd_http", commonv1.CommandState_COMMAND_STATE_FAILED); u.GetError().GetCode() != "invalid-payload" {
		t.Fatalf("http upload = %v", u)
	}
}

func TestStatusReportsTheSession(t *testing.T) {
	h := newHarness(t, nil)
	if st := h.agent.Status(); st.Connected || st.NodeID != testNode {
		t.Fatalf("before Welcome: %+v", st)
	}
	s, _ := h.open()
	s.push(desired(4, &agentv1.NodeSpec{}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil })
	st := h.agent.Status()
	if !st.Connected || st.Epoch != 1 || st.AppliedGeneration != 4 || st.ObservedGeneration != 4 || len(st.Sections) != 6 || st.CommandSigning {
		t.Fatalf("status = %+v", st)
	}
}

func TestSecretAndWorkloadTokenRequests(t *testing.T) {
	h := newHarness(t, nil)
	s, _ := h.open()
	type answer struct {
		value []byte
		err   error
	}
	got := make(chan answer, 1)
	go func() {
		v, err := h.agent.RequestSecret(context.Background(), "secret://t/user-data", pki.SecretBinding{AllocationID: "alloc_1"})
		got <- answer{v, err}
	}()
	req := s.next(t, "SecretRequest", func(f *agentv1.AgentFrame) bool { return f.GetSecretRequest() != nil }).GetSecretRequest()
	if !pki.VerifyP1363(&h.key.PublicKey, pki.SecretRequestSigningInput(req), req.GetNodeSig().GetSig()) || req.GetAllocationId() != "alloc_1" {
		t.Fatalf("request = %v", req)
	}
	epk, _ := pki.PublicKeyFromPoint(req.GetEpk())
	jwe, _ := pki.SealJWE([]byte("user-data!"), epk, map[string]any{"typ": pki.SecretResponseType, "ref": req.GetRef(), "rid": req.GetRequestId()})
	// An answer to nothing is ignored; the real one is opened.
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Secret{Secret: &agentv1.SecretResponse{RequestId: "req_other", Jwe: jwe}}})
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Secret{Secret: &agentv1.SecretResponse{Ref: req.GetRef(), RequestId: req.GetRequestId(), Jwe: jwe}}})
	if a := <-got; a.err != nil || string(a.value) != "user-data!" {
		t.Fatalf("secret = %q, %v", a.value, a.err)
	}

	tokens := make(chan error, 1)
	go func() {
		_, _, err := h.agent.RequestWorkloadToken(context.Background(), "inst_1", "sts")
		tokens <- err
	}()
	wreq := s.next(t, "WorkloadTokenRequest", func(f *agentv1.AgentFrame) bool { return f.GetWorkloadTokenRequest() != nil }).GetWorkloadTokenRequest()
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_WorkloadToken{WorkloadToken: &agentv1.WorkloadTokenResponse{RequestId: wreq.GetRequestId(), Error: "disabled"}}})
	if err := <-tokens; err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Fatalf("refusal = %v", err)
	}
}

func TestXidBecomesADeviceCondition(t *testing.T) {
	r, w := io.Pipe()
	gpu := fakehw.Inventory(1).Gpus.Gpus[2]
	h := newHarness(t, func(o *Options) { o.Host.(*fakeHost).kmsg = r })
	defer w.Close()
	s, _ := h.open()
	s.push(desired(1, &agentv1.NodeSpec{}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil })
	bus := strings.TrimPrefix(strings.ToLower(gpu.PciBusId), "0000")
	bus = strings.TrimSuffix(bus, ".0")
	_, _ = io.WriteString(w, "3,1,1,-;NVRM: Xid (PCI:"+bus+"): 79, pid=1, GPU has fallen off the bus.\n")
	status := s.next(t, "status with the XID", func(f *agentv1.AgentFrame) bool {
		for _, c := range f.GetStatus().GetConditions() {
			if c.GetType() == "Xid79" {
				return true
			}
		}
		return false
	}).GetStatus()
	for _, c := range status.GetConditions() {
		if c.GetType() == "Xid79" && (c.GetDeviceId() != gpu.Uuid || c.GetStatus() != agentv1.ConditionStatus_CONDITION_STATUS_TRUE) {
			t.Fatalf("condition = %v", c)
		}
	}
	// A restart in the same boot keeps it (the kernel log is read from its end).
	restarted := &Agent{o: Options{DataDir: h.agent.o.DataDir}, bootID: "boot-1"}
	restarted.loadFaults()
	if len(restarted.faults) != 1 || restarted.faults[0].GetType() != "Xid79" {
		t.Fatalf("restored = %v", restarted.faults)
	}
	nextBoot := &Agent{o: Options{DataDir: h.agent.o.DataDir}, bootID: "boot-2"}
	nextBoot.loadFaults()
	if len(nextBoot.faults) != 0 {
		t.Fatal("a new boot kept the XIDs")
	}
	// The next converger pass keeps it (this boot's faults stay active).
	s.push(desired(2, &agentv1.NodeSpec{}))
	again := s.next(t, "next status", func(f *agentv1.AgentFrame) bool { return f.GetStatus().GetAppliedGeneration() == 2 }).GetStatus()
	if len(again.GetConditions()) != 1 {
		t.Fatalf("conditions = %v", again.GetConditions())
	}
}

func TestGpuResetRefusesHeldGPUs(t *testing.T) {
	h := newHarness(t, nil)
	s, _ := h.open()
	gpus := fakehw.Inventory(1).Gpus.Gpus
	s.push(desired(1, &agentv1.NodeSpec{Devices: &agentv1.DevicesSection{Assignments: []*agentv1.DeviceAssignment{{
		AllocationId: "alloc_1", Binding: agentv1.Binding_BINDING_HOLD, Devices: []*agentv1.AssignedDevice{{Id: gpus[0].Uuid}},
	}}}}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil })
	held := body("r_held", "gpu.reset", &agentv1.GpuResetRequest{GpuUuids: []string{gpus[0].Uuid}})
	s.push(command(held))
	if u := s.update(t, "r_held", commonv1.CommandState_COMMAND_STATE_FAILED); u.GetError().GetCode() != "gpu-busy" {
		t.Fatalf("held = %v", u)
	}
	free := body("r_free", "gpu.reset", &agentv1.GpuResetRequest{GpuUuids: []string{gpus[3].Uuid, "GPU-missing"}})
	free.Attested = true
	s.push(command(free))
	done := s.update(t, "r_free", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	res := &agentv1.GpuResetResult{}
	_ = proto.Unmarshal(done.GetResult(), res)
	if len(res.GetGpus()) != 2 || done.GetNodeSig() == nil {
		t.Fatalf("result = %v", res)
	}
	for _, o := range res.GetGpus() {
		if o.GetUuid() == gpus[3].Uuid && (!o.GetReset_() || !o.GetHealthy()) || o.GetUuid() == "GPU-missing" && o.GetReset_() {
			t.Fatalf("outcome = %v", o)
		}
	}
	if len(h.host.resets) != 1 || h.host.resets[0] != gpus[3].Uuid {
		t.Fatalf("resets = %v", h.host.resets)
	}
}

// Within the skew allowance a Welcome is accepted, but the clock never moves back.
func TestWelcomeWithinSkewDoesNotMoveTheClockBack(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Backoff.Min, o.Backoff.Max = time.Millisecond, 10*time.Millisecond })
	s, _ := h.open()
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Drain{Drain: &agentv1.Drain{ReconnectAfterMs: 1}}})
	s2 := h.gw.accept()
	s2.next(t, "Hello", func(f *agentv1.AgentFrame) bool { return f.GetHello() != nil })
	earlier := welcome()
	earlier.GetWelcome().ServerTime = timestamppb.New(time.Now().Add(-4 * time.Minute))
	s2.push(earlier)
	s2.push(command(body("ok2", "inventory.refresh", nil)))
	s2.update(t, "ok2", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	if skew := time.Since(h.agent.serverNow()); skew > 5*time.Second {
		t.Fatalf("the clock moved back by %s", skew)
	}
}

func TestInstanceTicketsNeverReachTheHost(t *testing.T) {
	for _, op := range []string{"ssh", "tcp", "exec", "console"} {
		if _, err := DefaultTunnelProgram(pki.ExecTicketClaims{Op: op, Inst: "inst_1", Port: 8080}, TunnelIO{}); err == nil {
			t.Errorf("%s with an instance was allowed", op)
		}
	}
	if _, err := DefaultTunnelProgram(pki.ExecTicketClaims{Op: "exec"}, TunnelIO{}); err == nil {
		t.Error("an exec ticket without an instance opened a host shell")
	}
}

type recordingDriver struct {
	got *driverv1.InvokeRequest
	err error
}

func (r *recordingDriver) Invoke(_ context.Context, req *driverv1.InvokeRequest, _ func(*driverv1.Progress)) (string, error) {
	r.got = req
	if r.err != nil {
		return "", r.err
	}
	return `{"power":"on"}`, nil
}

func TestDriverInvokeThroughAHostedPlugin(t *testing.T) {
	rec := &recordingDriver{}
	h := newHarness(t, func(o *Options) {
		o.State.Role = "site"
		o.Drivers = []HostedDriver{{Manifest: &commonv1.DriverManifest{Id: "acme-bmc", Kinds: []string{"power", "management"}}, Host: rec}}
	})
	s, hello := h.open()
	if ids := hello.GetDrivers(); len(ids) == 0 || ids[0].GetId() != "acme-bmc" {
		t.Fatalf("hello drivers = %v", ids)
	}
	args, _ := structpb.NewStruct(map[string]any{
		"concern": "power", "operation": "setPower", "args": map[string]any{"action": "on"},
		"config": map[string]any{"endpoint": "https://10.0.0.5", "password": "secret://t/bmc"},
	})
	inv := body("d1", "driver.invoke", &agentv1.DriverInvokeRequest{WorkflowId: "wf_1", StepId: "power", Attempt: 2, Args: args})
	inv.Lane = commonv1.Lane_LANE_PROVISION
	s.push(command(inv))
	if req := answerSecret(t, s, "hunter2"); req.GetRef() != "secret://t/bmc" || req.GetStepId() != "power" {
		t.Fatalf("secret request = %v", req)
	}
	done := s.update(t, "d1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	res := &agentv1.DriverInvokeResult{}
	_ = proto.Unmarshal(done.GetResult(), res)
	if res.GetResultJson() != `{"power":"on"}` {
		t.Fatalf("result = %v", res)
	}
	g := rec.got
	if g.GetDriverId() != "acme-bmc" || g.GetKind() != "power" || g.GetOperation() != "setPower" || g.GetArgsJson() != `{"action":"on"}` ||
		g.GetIdempotencyKey() != "wf:wf_1:power#2" || len(g.GetSecrets()) != 1 || g.GetSecrets()[0].GetField() != "password" ||
		string(g.GetSecrets()[0].GetValue()) != "hunter2" || !strings.Contains(g.GetConfigJson(), `"password":"secret://t/bmc"`) || g.GetDeadline() == nil {
		t.Fatalf("invoke request = %v", g)
	}
	// Unknown concern, and a driver's own error code.
	other, _ := structpb.NewStruct(map[string]any{"concern": "deploy", "operation": "deploy"})
	s.push(command(body("d2", "driver.invoke", &agentv1.DriverInvokeRequest{Args: other})))
	if u := s.update(t, "d2", commonv1.CommandState_COMMAND_STATE_FAILED); u.GetError().GetCode() != "driver-not-found" {
		t.Fatalf("unknown concern = %v", u)
	}
	rec.err = &bcx.Error{Code: "unreachable", Message: "no BMC"}
	plain, _ := structpb.NewStruct(map[string]any{"concern": "power", "operation": "getPower"})
	s.push(command(body("d3", "driver.invoke", &agentv1.DriverInvokeRequest{Args: plain})))
	if u := s.update(t, "d3", commonv1.CommandState_COMMAND_STATE_FAILED); u.GetError().GetCode() != "unreachable" {
		t.Fatalf("driver error = %v", u)
	}
}
