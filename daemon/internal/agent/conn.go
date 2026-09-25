package agent

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/session"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// outboxSize bounds the frames waiting for the writer; a full outbox drops the session (P12).
const outboxSize = 4096

// eventBatch bounds the events of one EventBatch frame.
const eventBatch = 100

// sess is one Session stream.
type sess struct {
	stream   Stream
	out      chan *agentv1.AgentFrame
	cancel   context.CancelFunc
	welcomed bool
	// after is the Drain delay before the redial.
	after      *time.Duration
	heartbeats int
}

// runSession dials, says Hello, and handles frames until the stream ends. It reports whether a
// Welcome arrived (the redial backoff restarts) and a Drain delay, if any.
func (a *Agent) runSession(ctx context.Context) (bool, *time.Duration, error) {
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := a.o.Dial(sctx)
	if err != nil {
		return false, nil, err
	}
	hello, err := a.hello()
	if err != nil {
		return false, nil, err
	}
	if err := stream.Send(&agentv1.AgentFrame{Msg: &agentv1.AgentFrame_Hello{Hello: hello}}); err != nil {
		_ = stream.CloseRequest()
		_ = stream.CloseResponse()
		return false, nil, err
	}
	s := &sess{stream: stream, out: make(chan *agentv1.AgentFrame, outboxSize), cancel: cancel}
	a.mu.Lock()
	a.sess = s
	a.mu.Unlock()
	a.log.Info("session open", "node", a.NodeID(), "journal", hello.GetJournalId(),
		"unacked", len(hello.GetUnackedResults()), "running", len(hello.GetRunningCommandIds()))

	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		for {
			select {
			case <-sctx.Done():
				return
			case f := <-s.out:
				if err := stream.Send(f); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	welcomeTimer := time.AfterFunc(a.o.WelcomeTimeout, func() {
		a.mu.Lock()
		late := a.sess == s && !s.welcomed
		a.mu.Unlock()
		if late {
			a.log.Warn("no Welcome; dropping the session")
			cancel()
		}
	})
	defer welcomeTimer.Stop()

	var recvErr error
	for {
		f, err := stream.Receive()
		if err != nil {
			recvErr = err
			break
		}
		if !a.handle(sctx, s, f) {
			break
		}
	}
	a.mu.Lock()
	if a.sess == s {
		a.sess = nil
	}
	welcomed, after := s.welcomed, s.after
	a.mu.Unlock()
	cancel()
	<-writerDone
	_ = stream.CloseRequest()
	_ = stream.CloseResponse()
	if errors.Is(recvErr, context.Canceled) {
		recvErr = nil
	}
	return welcomed, after, recvErr
}

// hello builds the first frame from the journal (session.NewHello's rules).
func (a *Agent) hello() (*agentv1.Hello, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	meta, err := a.j.Meta()
	if err != nil {
		return nil, err
	}
	commands, err := a.j.Commands()
	if err != nil {
		return nil, err
	}
	h := &agentv1.Hello{
		NodeId:            a.NodeID(),
		BootId:            a.bootID,
		JournalId:         meta.JournalID,
		Role:              wireRole(a.o.State.Role),
		DaemonVersion:     a.o.Version,
		ProtoMin:          session.ProtoMin,
		ProtoMax:          session.ProtoMax,
		LastEpoch:         meta.LastEpoch,
		AppliedGeneration: meta.AppliedGeneration,
		LastEventSeq:      meta.EventSeq,
		InventoryHashes:   a.inventoryHashes(),
		TrustVersion:      a.state.TrustVersion,
	}
	if spec, ok, err := a.j.Spec(); err == nil && ok {
		h.AppliedSpecHash = spec.Hash
	}
	for _, c := range commands {
		switch {
		case c.State == journal.StateDone && !c.ResultAcked && c.Result != nil:
			h.UnackedResults = append(h.UnackedResults, a.updateOf(c.ID, *c.Result))
		case c.State != journal.StateDone && c.Incarnation == a.incarnation:
			h.RunningCommandIds = append(h.RunningCommandIds, c.ID)
		}
	}
	a.invMu.Lock()
	gpus := len(gpuUUIDs(a.inv))
	a.invMu.Unlock()
	if len(a.o.Runtimes) > 0 {
		h.Capabilities = append(h.Capabilities, InstanceDialCapability, NetworkPolicyCapability)
	}
	for _, d := range a.o.Drivers {
		h.Drivers = append(h.Drivers, d.Manifest)
	}
	for _, r := range a.o.Runtimes {
		if _, plugin := r.(*PluginRuntime); plugin {
			continue // its plugin's manifest is listed above
		}
		h.Drivers = append(h.Drivers, &commonv1.DriverManifest{
			Id: r.Name(), Version: a.o.Version, Kinds: []string{"runtime"}, RunsOn: commonv1.RunsOn_RUNS_ON_NODE,
			ConfigSchemaJson: `{"type":"object"}`,
		})
	}
	if gpus > 0 {
		h.Capabilities = append(h.Capabilities, "cdi", "nvml")
		h.Drivers = append(h.Drivers, &commonv1.DriverManifest{
			Id:               "nvidia",
			Version:          a.o.Version,
			Kinds:            []string{"config"},
			RunsOn:           commonv1.RunsOn_RUNS_ON_NODE,
			ConfigSchemaJson: `{"type":"object"}`,
		})
	}
	return h, nil
}

// handle processes one server frame; false ends the session.
func (a *Agent) handle(ctx context.Context, s *sess, f *agentv1.ServerFrame) bool {
	a.mu.Lock()
	a.lastContact = time.Now()
	a.mu.Unlock()
	if w := f.GetWelcome(); w != nil {
		return a.onWelcome(ctx, s, w)
	}
	a.mu.Lock()
	welcomed := s.welcomed
	a.mu.Unlock()
	if !welcomed {
		a.log.Warn("protocol: a frame before Welcome; dropping the session")
		return false
	}
	switch m := f.GetMsg().(type) {
	case *agentv1.ServerFrame_Command:
		a.onCommand(m.Command)
	case *agentv1.ServerFrame_Cancel:
		a.onCancel(m.Cancel)
	case *agentv1.ServerFrame_Desired:
		a.onDesired(m.Desired)
	case *agentv1.ServerFrame_Ack:
		a.onAck(m.Ack)
	case *agentv1.ServerFrame_Drain:
		d := time.Duration(m.Drain.GetReconnectAfterMs()) * time.Millisecond
		a.log.Info("drain", "reason", m.Drain.GetReason(), "reconnectAfter", d.String())
		a.mu.Lock()
		s.after = &d
		a.mu.Unlock()
		return false
	case *agentv1.ServerFrame_Secret:
		a.onSecretResponse(m.Secret)
	case *agentv1.ServerFrame_WorkloadToken:
		a.onWorkloadTokenResponse(m.WorkloadToken)
	case *agentv1.ServerFrame_OpenTunnel:
		a.onOpenTunnel(m.OpenTunnel)
	case *agentv1.ServerFrame_Revoked:
		a.log.Error("certificate revoked", "reason", m.Revoked.GetReason())
		a.mu.Lock()
		a.revoked = true
		a.mu.Unlock()
		return false
	default:
		a.log.Debug("frame ignored", "type", strings.TrimPrefix(frameName(f), "*agentv1.ServerFrame_"))
	}
	return true
}

func frameName(f *agentv1.ServerFrame) string {
	if f.GetMsg() == nil {
		return "empty"
	}
	return strings.TrimPrefix(strings.TrimPrefix(typeName(f.GetMsg()), "*"), "agentv1.")
}

func typeName(v any) string { return strings.TrimPrefix(fmtType(v), "*") }

// MaxServerTimeRegression is how far a Welcome's server_time may lie before the daemon's server
// time high-water mark (clock skew between gateways); anything earlier is refused.
const MaxServerTimeRegression = 5 * time.Minute

func (a *Agent) onWelcome(ctx context.Context, s *sess, w *agentv1.Welcome) bool {
	a.mu.Lock()
	if s.welcomed {
		a.mu.Unlock()
		a.log.Debug("duplicate Welcome ignored")
		return true
	}
	if st := w.GetServerTime(); st != nil {
		meta, err := a.j.Meta()
		if err != nil {
			a.mu.Unlock()
			a.log.Error("journal: meta", "error", err.Error())
			return false
		}
		serverTime := st.AsTime()
		if !meta.ServerTime.IsZero() && serverTime.Before(meta.ServerTime.Add(-MaxServerTimeRegression)) {
			a.mu.Unlock()
			a.log.Error("protocol: server time went backwards; refusing the session",
				"serverTime", serverTime.Format(time.RFC3339), "highWater", meta.ServerTime.Format(time.RFC3339))
			return false
		}
		// Within the skew allowance the session is accepted, but the working clock never moves back:
		// not behind the persisted mark, nor behind this process's own server clock. Otherwise a
		// gateway could reconnect "a few minutes earlier" and replay a ticket whose jti was pruned.
		floor := meta.ServerTime
		if a.clockSet {
			floor = maxTime(floor, a.serverNowLocked())
		}
		serverTime = maxTime(serverTime, floor)
		a.offset = serverTime.Sub(time.Now())
		a.clockSet = true
		a.advanceServerTimeLocked()
		next := *a.state
		next.ServerTime = a.serverNowLocked()
		if err := SaveState(a.o.DataDir, &next); err != nil {
			a.log.Error("store the server time", "error", err.Error())
		} else {
			a.state = &next
		}
	}
	if err := session.ApplyWelcome(a.j, session.Welcome{Epoch: w.GetEpoch(), AckedEventSeq: w.GetAckedEventSeq()}); err != nil {
		a.log.Error("journal: apply Welcome", "error", err.Error())
	}
	a.upgradeNeeded = w.GetUpgradeRequired()
	if w.GetTrust() != nil && len(a.o.SignerPin) > 0 {
		bundle, err := pki.OpenTrustBundle(w.GetTrust(), a.o.SignerPin, a.state.TrustVersion)
		if err == nil {
			current, ok := a.trustBundleLocked()
			if !ok {
				err = errors.New("the stored trust bundle is unreadable")
			} else if why := quorumChange(current, bundle); why != "" {
				err = errors.New(why)
				a.log.Warn("trust bundle refused", "version", bundle.GetVersion(), "reason", why)
			}
		}
		if err != nil {
			a.log.Info("trust bundle ignored", "reason", err.Error())
		} else {
			next := *a.state
			next.TrustVersion = bundle.GetVersion()
			next.TrustRoots = bundle.GetCommandSigningRoots()
			next.TrustBundle, _ = proto.Marshal(bundle)
			if err := SaveState(a.o.DataDir, &next); err != nil {
				a.log.Error("store the trust bundle", "error", err.Error())
			} else {
				a.state = &next
				a.log.Info("trust bundle updated", "version", next.TrustVersion, "roots", len(next.TrustRoots))
				// The ack of the new trust (?13 root switch) rides the next StatusReport.
				if a.lastStatus != nil {
					a.lastStatus = proto.Clone(a.lastStatus).(*agentv1.StatusReport)
					a.trustPending = true
				}
			}
		}
	}
	s.welcomed = true
	a.mu.Unlock()
	interval := time.Duration(w.GetHeartbeatIntervalMs()) * time.Millisecond
	if interval <= 0 {
		interval = session.DefaultHeartbeat
	}
	a.log.Info("welcome", "epoch", w.GetEpoch(), "session", w.GetSessionId(), "acked", w.GetAckedEventSeq(),
		"sections", strings.Join(w.GetRequestSections(), ","))

	if names := w.GetRequestSections(); len(names) > 0 {
		sections, err := a.collect(false)
		if err == nil {
			wanted := map[string]bool{}
			for _, n := range names {
				wanted[n] = true
			}
			var send []int
			for i, sec := range sections {
				if wanted[sec.Name] {
					send = append(send, i)
				}
			}
			a.sendSections(sections, send)
		}
	}
	a.mu.Lock()
	a.sendUnackedEventsLocked()
	a.sendStatusLocked()
	a.mu.Unlock()
	go a.heartbeats(ctx, s, interval)
	return true
}

func maxTime(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

// advanceServerTimeLocked moves the persisted server time high-water mark to serverNow.
func (a *Agent) advanceServerTimeLocked() {
	meta, err := a.j.Meta()
	if err != nil {
		return
	}
	meta.ServerTime = a.serverNowLocked()
	if err := a.j.SaveMeta(meta); err != nil {
		a.log.Error("journal: server time", "error", err.Error())
	}
}

func (a *Agent) heartbeats(ctx context.Context, s *sess, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.heartbeat(s)
		}
	}
}

func (a *Agent) heartbeat(s *sess) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sess != s {
		return
	}
	s.heartbeats++
	a.advanceServerTimeLocked()
	hb := &agentv1.Heartbeat{AppliedGeneration: a.applied}
	running := 0
	for _, x := range a.execs {
		if x.phase == phaseRunning {
			running++
		}
	}
	for _, lane := range []dispatch.Lane{dispatch.LaneControl, dispatch.LaneProvision, dispatch.LaneBulk} {
		used, _ := a.lanes.InUse(lane)
		free := a.laneConfig[lane].Credits - used
		if free < 0 {
			free = 0
		}
		hb.Credits = append(hb.Credits, &agentv1.LaneCredits{Lane: commonv1.Lane(lane), Credits: uint32(free)})
	}
	stats, _ := a.j.EventStats()
	hb.Load = &agentv1.NodeLoad{
		LoadAverage_1M:       loadAverage(),
		MemoryAvailableBytes: memoryAvailable(),
		RunningCommands:      uint32(running),
		PendingEvents:        uint32(stats.Count),
	}
	// Every 10th heartbeat carries the inventory hashes (PLAN.md §10.1).
	if s.heartbeats%10 == 0 {
		hb.InventoryHashes = a.inventoryHashes()
	}
	a.sendLocked(&agentv1.AgentFrame{Msg: &agentv1.AgentFrame_Heartbeat{Heartbeat: hb}})
}

func (a *Agent) onAck(ack *agentv1.Ack) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := session.ApplyAck(a.j, session.Ack{JournalID: ack.GetJournalId(), EventSeq: ack.GetEventSeq(), CommandIDs: ack.GetCommandIds()}); err != nil {
		a.log.Error("journal: apply Ack", "error", err.Error())
	}
	a.retryOverflowLocked()
}

// send pushes a frame to the welcomed session, if any; false when there is none (the journal
// replays what matters on the next session).
func (a *Agent) send(f *agentv1.AgentFrame) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sendLocked(f)
}

func (a *Agent) sendLocked(f *agentv1.AgentFrame) bool {
	s := a.sess
	if s == nil || !s.welcomed {
		return false
	}
	select {
	case s.out <- f:
		return true
	default:
		a.log.Warn("outbox full; dropping the session")
		s.cancel()
		return false
	}
}

// ---- events ------------------------------------------------------------------------------------

// emitEvent journals an event and sends it. A metric is dropped when the journal is full; results
// and transitions wait in memory (and commands get BUSY) until Acks make room.
func (a *Agent) emitEvent(class journal.EventClass, kind string, ev *agentv1.Event) {
	a.mu.Lock()
	defer a.mu.Unlock()
	ev.ObservedAt = timestamppb.New(a.serverNowLocked())
	payload, err := marshal(ev)
	if err != nil {
		a.log.Error("encode an event", "error", err.Error())
		return
	}
	e := journal.Event{Class: class, Kind: kind, Payload: payload}
	if len(a.overflow) > 0 && class != journal.ClassMetric {
		a.overflow = append(a.overflow, e)
		return
	}
	stored, err := a.j.AppendEvent(e)
	if errors.Is(err, journal.ErrFull) {
		if class == journal.ClassMetric {
			a.log.Debug("event dropped", "kind", kind)
			return
		}
		a.overflow = append(a.overflow, e)
		a.log.Warn("journal full; event waits", "kind", kind, "pending", len(a.overflow))
		return
	}
	if err != nil {
		a.log.Error("journal: append event", "kind", kind, "error", err.Error())
		return
	}
	a.sendEventsLocked([]journal.Event{stored})
}

func (a *Agent) retryOverflowLocked() {
	for len(a.overflow) > 0 {
		stored, err := a.j.AppendEvent(a.overflow[0])
		if errors.Is(err, journal.ErrFull) {
			return
		}
		if err != nil {
			a.log.Error("journal: append event", "error", err.Error())
			return
		}
		a.overflow = a.overflow[1:]
		a.sendEventsLocked([]journal.Event{stored})
	}
}

func (a *Agent) sendUnackedEventsLocked() {
	events, err := a.j.UnackedEvents()
	if err != nil {
		a.log.Error("journal: unacked events", "error", err.Error())
		return
	}
	a.sendEventsLocked(events)
}

func (a *Agent) sendEventsLocked(events []journal.Event) {
	for i := 0; i < len(events); i += eventBatch {
		end := min(i+eventBatch, len(events))
		batch := &agentv1.EventBatch{JournalId: a.journalID}
		for _, e := range events[i:end] {
			ev := &agentv1.Event{}
			if err := unmarshal(e.Payload, ev); err != nil {
				a.log.Error("journal: undecodable event", "seq", e.Seq, "error", err.Error())
				continue
			}
			ev.Seq = e.Seq
			batch.Events = append(batch.Events, ev)
		}
		a.sendLocked(&agentv1.AgentFrame{Msg: &agentv1.AgentFrame_Events{Events: batch}})
	}
}

// ---- host load ---------------------------------------------------------------------------------

func loadAverage() float64 {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(fields[0], 64)
	return v
}

func memoryAvailable() uint64 {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if rest, ok := strings.CutPrefix(line, "MemAvailable:"); ok {
			fields := strings.Fields(rest)
			if len(fields) > 0 {
				kb, _ := strconv.ParseUint(fields[0], 10, 64)
				return kb * 1024
			}
		}
	}
	return 0
}
