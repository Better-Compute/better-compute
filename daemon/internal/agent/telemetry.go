package agent

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/converge"
	"github.com/better-compute/better-compute/daemon/internal/nvml"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/telemetry"
	"google.golang.org/protobuf/proto"
)

// Telemetry export bounds.
const (
	defaultExportInterval = time.Minute
	minExportInterval     = 5 * time.Second
)

// telemetryHeadersBinding is how a SecretRequest claims NodeSpec.telemetry.headers_ref.
var telemetryHeadersBinding = pki.SecretBinding{WorkflowID: "host:telemetry", StepID: "headersRef"}

// telemetryConverger applies NodeSpec.telemetry: it runs one OTLP exporter of bcd's own metrics
// (bcd.gpu.* from nvidia-smi, bcd.host.* pressure) to the spec's endpoint, restarted when the section
// changes and stopped when it is empty. Telemetry never rides the Session (P8).
type telemetryConverger struct {
	a *Agent

	mu      sync.Mutex
	applied *agentv1.TelemetrySection
	cancel  context.CancelFunc
	// The export's last outcome, for bcd status.
	lastExport time.Time
	lastError  string
}

// TelemetryStatus is the OTLP export as bcd status shows it.
type TelemetryStatus struct {
	Endpoint   string    `json:"endpoint"`
	LastExport time.Time `json:"lastExport,omitzero"`
	LastError  string    `json:"lastError,omitempty"`
}

func (t *telemetryConverger) status() *TelemetryStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.applied.GetOtlpEndpoint() == "" {
		return nil
	}
	return &TelemetryStatus{Endpoint: t.applied.GetOtlpEndpoint(), LastExport: t.lastExport, LastError: t.lastError}
}

func (t *telemetryConverger) record(err error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if err == nil {
		t.lastExport, t.lastError = time.Now(), ""
	} else {
		t.lastError = err.Error()
	}
}

func (t *telemetryConverger) Section() converge.Section { return converge.SectionTelemetry }

func (t *telemetryConverger) Plan(_ context.Context, desired []byte) ([]converge.Action, error) {
	sec := &agentv1.TelemetrySection{}
	if err := proto.Unmarshal(desired, sec); err != nil {
		return nil, converge.Terminal(fmt.Errorf("telemetry section: %w", err))
	}
	if sec.GetOtlpEndpoint() != "" {
		if _, err := telemetry.MetricsURL(sec.GetOtlpEndpoint()); err != nil {
			return nil, converge.Terminal(err)
		}
	}
	if _, err := resourceAttributes(sec.GetResourceAttributes()); err != nil {
		return nil, converge.Terminal(err)
	}
	t.mu.Lock()
	same := proto.Equal(sec, t.applied) || (t.applied == nil && sec.GetOtlpEndpoint() == "")
	t.mu.Unlock()
	if same {
		return nil, nil
	}
	description := "stop the OTLP export"
	if sec.GetOtlpEndpoint() != "" {
		description = "export telemetry to " + sec.GetOtlpEndpoint()
	}
	return []converge.Action{{Description: description, Apply: func(context.Context) error {
		t.start(sec)
		return nil
	}}}, nil
}

func resourceAttributes(pairs []string) (map[string]string, error) {
	out := map[string]string{}
	for _, p := range pairs {
		k, v, ok := strings.Cut(p, "=")
		if !ok || strings.TrimSpace(k) == "" {
			return nil, fmt.Errorf("telemetry resource attribute %q is not key=value", p)
		}
		out[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return out, nil
}

// start replaces the running exporter with one for sec (none when its endpoint is empty).
func (t *telemetryConverger) start(sec *agentv1.TelemetrySection) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.cancel != nil {
		t.cancel()
		t.cancel = nil
	}
	t.applied = proto.Clone(sec).(*agentv1.TelemetrySection)
	t.lastExport, t.lastError = time.Time{}, ""
	if sec.GetOtlpEndpoint() == "" || t.a.ctx == nil {
		return
	}
	ctx, cancel := context.WithCancel(t.a.ctx)
	t.cancel = cancel
	go t.run(ctx, t.applied)
}

// run exports every interval until ctx ends. Failures are logged once per kind, not per interval.
func (t *telemetryConverger) run(ctx context.Context, sec *agentv1.TelemetrySection) {
	a := t.a
	interval := time.Duration(sec.GetExportIntervalMs()) * time.Millisecond
	if interval <= 0 {
		interval = defaultExportInterval
	}
	interval = max(interval, minExportInterval)
	extra, _ := resourceAttributes(sec.GetResourceAttributes())
	a.mu.Lock()
	site := a.state.SiteID
	a.mu.Unlock()
	resource := map[string]string{
		"service.name":    "bcd",
		"service.version": a.o.Version,
		"host.name":       a.host.Hostname(),
		"bcd.node.id":     a.NodeID(),
		"bcd.site.id":     site,
	}
	for k, v := range extra {
		if _, own := resource[k]; !own {
			resource[k] = v
		}
	}
	exp := &telemetry.Exporter{Endpoint: sec.GetOtlpEndpoint(), Resource: resource, Scope: "bcd", ScopeVersion: a.o.Version, Start: time.Now()}
	lastErr := ""
	report := func(err error) {
		t.record(err)
		if msg := errText(err); msg != lastErr {
			lastErr = msg
			if err != nil {
				a.log.Warn("telemetry export", "endpoint", sec.GetOtlpEndpoint(), "error", msg)
			} else {
				a.log.Info("telemetry export resumed", "endpoint", sec.GetOtlpEndpoint())
			}
		}
	}
	headersPending := sec.GetHeadersRef() != ""
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		if headersPending {
			raw, err := a.RequestSecret(ctx, sec.GetHeadersRef(), telemetryHeadersBinding)
			if err == nil {
				exp.Headers, err = telemetry.ParseHeaders(raw)
			}
			if err != nil {
				report(fmt.Errorf("headers %s: %w", sec.GetHeadersRef(), err))
			} else {
				headersPending = false
			}
		}
		if !headersPending {
			sctx, cancel := context.WithTimeout(ctx, interval)
			metrics := a.metrics(sctx)
			err := exp.Export(sctx, time.Now(), metrics)
			cancel()
			if ctx.Err() != nil {
				return
			}
			report(err)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// metrics samples the GPUs (GPUSampler) and reads the inventory's counters and the host pressure.
func (a *Agent) metrics(ctx context.Context) []telemetry.Metric {
	gauge := func(name, unit string) *telemetry.Metric { return &telemetry.Metric{Name: name, Unit: unit} }
	var (
		memUsed    = gauge("bcd.gpu.memory.used", "By")
		memTotal   = gauge("bcd.gpu.memory.total", "By")
		memReserve = gauge("bcd.gpu.memory.reserved", "By")
		util       = gauge("bcd.gpu.utilization", "1")
		memUtil    = gauge("bcd.gpu.memory.utilization", "1")
		temp       = gauge("bcd.gpu.temperature", "Cel")
		power      = gauge("bcd.gpu.power.draw", "W")
		limit      = gauge("bcd.gpu.power.limit", "W")
		smClock    = gauge("bcd.gpu.clock.sm", "MHz")
		memClock   = gauge("bcd.gpu.clock.memory", "MHz")
		procs      = gauge("bcd.gpu.processes", "{process}")
		migUsed    = gauge("bcd.gpu.mig.memory.used", "By")
		migTotal   = gauge("bcd.gpu.mig.memory.total", "By")
		xids       = gauge("bcd.gpu.xid.active", "{condition}")
		ecc        = &telemetry.Metric{Name: "bcd.gpu.ecc.errors", Unit: "{error}", Sum: true}
		remapped   = gauge("bcd.gpu.rows.remapped", "{row}")
	)
	i64 := func(v uint64) *int64 { n := int64(v); return &n }
	names := map[string]map[string]string{}
	a.invMu.Lock()
	if a.inv != nil && a.inv.Gpus != nil {
		for _, g := range a.inv.Gpus.Gpus {
			attrs := map[string]string{"gpu.uuid": g.Uuid, "gpu.index": strconv.Itoa(int(g.Index)), "gpu.model": g.Name}
			names[g.Uuid] = attrs
			if e := g.Ecc; e != nil && e.AggregateCounts != nil {
				ecc.Points = append(ecc.Points,
					telemetry.Point{Attrs: with(attrs, "type", "correctable"), Int: i64(e.AggregateCounts.Correctable)},
					telemetry.Point{Attrs: with(attrs, "type", "uncorrectable"), Int: i64(e.AggregateCounts.Uncorrectable)})
			}
			if r := g.RowRemap; r != nil {
				remapped.Points = append(remapped.Points,
					telemetry.Point{Attrs: with(attrs, "type", "correctable"), Int: i64(uint64(r.Correctable))},
					telemetry.Point{Attrs: with(attrs, "type", "uncorrectable"), Int: i64(uint64(r.Uncorrectable))})
			}
		}
	}
	a.invMu.Unlock()
	active := map[string]uint64{}
	a.mu.Lock()
	for _, f := range a.faults {
		active[f.GetDeviceId()]++
	}
	pressure := a.pressure
	a.mu.Unlock()
	for uuid, attrs := range names {
		xids.Points = append(xids.Points, telemetry.Point{Attrs: attrs, Int: i64(active[uuid])})
	}
	if a.o.GPUSampler != nil {
		if snap, err := a.o.GPUSampler(ctx); err == nil && snap != nil {
			for _, s := range snap.Samples {
				attrs := names[s.UUID]
				if attrs == nil {
					attrs = map[string]string{"gpu.uuid": s.UUID}
				}
				d := func(m *telemetry.Metric, v float64) {
					m.Points = append(m.Points, telemetry.Point{Attrs: attrs, Double: v})
				}
				n := func(m *telemetry.Metric, v uint64) {
					m.Points = append(m.Points, telemetry.Point{Attrs: attrs, Int: i64(v)})
				}
				n(memUsed, s.MemoryUsed)
				n(memTotal, s.MemoryTotal)
				n(memReserve, s.MemoryReserved)
				d(util, float64(s.UtilizationGPU)/100)
				d(memUtil, float64(s.UtilizationMemory)/100)
				d(temp, float64(s.TemperatureC))
				d(power, float64(s.PowerDrawMw)/1000)
				d(limit, float64(s.PowerLimitMw)/1000)
				d(smClock, float64(s.SMClockMHz))
				d(memClock, float64(s.MemClockMHz))
				n(procs, uint64(s.Processes))
				for _, m := range s.Mig {
					ma := with(attrs, "mig.id", m.ID)
					migUsed.Points = append(migUsed.Points, telemetry.Point{Attrs: ma, Int: i64(m.MemoryUsed)})
					migTotal.Points = append(migTotal.Points, telemetry.Point{Attrs: ma, Int: i64(m.MemoryTotal)})
				}
			}
		}
	}
	out := []telemetry.Metric{}
	for _, m := range []*telemetry.Metric{memUsed, memTotal, memReserve, util, memUtil, temp, power, limit, smClock, memClock, procs, migUsed, migTotal, xids, ecc, remapped} {
		if len(m.Points) > 0 {
			out = append(out, *m)
		}
	}
	if pressure != nil {
		for _, p := range []struct {
			name  string
			value float32
		}{
			{"bcd.host.pressure.cpu", pressure.GetCpuSomeAvg10()},
			{"bcd.host.pressure.memory", pressure.GetMemorySomeAvg10()},
			{"bcd.host.pressure.io", pressure.GetIoSomeAvg10()},
			{"bcd.host.cpu.steal", pressure.GetStealPct()},
		} {
			out = append(out, telemetry.Metric{Name: p.name, Unit: "%", Points: []telemetry.Point{{Double: float64(p.value)}}})
		}
	}
	out = append(out, a.hostMemoryMetrics()...)
	out = append(out, a.instanceMetrics(ctx)...)
	return out
}

func with(attrs map[string]string, k, v string) map[string]string {
	out := make(map[string]string, len(attrs)+1)
	for a, b := range attrs {
		out[a] = b
	}
	out[k] = v
	return out
}

// GPUSampler reads the GPUs' live state (nvml.SMI.Snapshot on a host).
type GPUSampler func(ctx context.Context) (*nvml.Snapshot, error)
