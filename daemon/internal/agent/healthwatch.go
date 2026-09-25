package agent

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/health"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// Kmsg opens the kernel log (/dev/kmsg) positioned after its last record.
func (h *RealHost) Kmsg() (io.ReadCloser, error) {
	f, err := os.Open(h.Path("/dev/kmsg"))
	if err != nil {
		return nil, err
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// healthLoop samples host pressure every interval and re-sends the status with it.
func (a *Agent) healthLoop(ctx context.Context) {
	p := &health.Pressure{Root: strings.TrimRight(a.host.Path("/"), `/\`)}
	p.Sample() // the first steal sample needs a baseline
	t := time.NewTicker(a.o.HealthInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		sample := p.Sample()
		a.mu.Lock()
		a.pressure = sample
		if a.lastStatus != nil {
			a.lastStatus = proto.Clone(a.lastStatus).(*agentv1.StatusReport)
			a.lastStatus.Pressure = sample
			a.sendStatusLocked()
		}
		a.mu.Unlock()
	}
}

// watchXids reads NVIDIA XIDs from the kernel log for the life of the process (this boot).
func (a *Agent) watchXids(ctx context.Context) {
	r, err := a.host.Kmsg()
	if err != nil {
		a.log.Debug("kernel log unavailable; XIDs are not watched", "error", err.Error())
		return
	}
	go func() {
		<-ctx.Done()
		r.Close()
	}()
	err = health.WatchKmsg(ctx, r, a.onXid)
	if err != nil && ctx.Err() == nil {
		a.log.Warn("kernel log watch ended", "error", err.Error())
	}
}

// onXid records an XID as an active device condition "Xid<n>" of this boot and re-sends the status.
func (a *Agent) onXid(x health.Xid) {
	a.invMu.Lock()
	device := ""
	if a.inv != nil && a.inv.Gpus != nil {
		for _, g := range a.inv.Gpus.Gpus {
			if strings.EqualFold(g.PciBusId, x.Bus) {
				device = g.Uuid
			}
		}
	}
	a.invMu.Unlock()
	if device == "" {
		a.log.Warn("XID on an unknown GPU", "bus", x.Bus, "xid", x.Code)
		return
	}
	kind := "Xid" + strconv.Itoa(x.Code)
	a.log.Warn("GPU XID", "gpu", device, "xid", x.Code, "message", x.Message)
	a.mu.Lock()
	defer a.mu.Unlock()
	found := false
	for _, c := range a.faults {
		if c.GetType() == kind && c.GetDeviceId() == device {
			c.Message = x.Message
			found = true
		}
	}
	if !found {
		a.faults = append(a.faults, &agentv1.Condition{
			Type: kind, Status: agentv1.ConditionStatus_CONDITION_STATUS_TRUE, Reason: kind, Message: x.Message, DeviceId: device,
		})
	}
	a.saveFaultsLocked()
	if a.lastStatus != nil {
		a.lastStatus = proto.Clone(a.lastStatus).(*agentv1.StatusReport)
		a.lastStatus.Conditions = append(withoutFaults(a.lastStatus.Conditions), cloneConditions(a.faults)...)
		a.sendStatusLocked()
	}
}

// faultsFile keeps this boot's XID conditions, so a daemon restart without a reboot keeps them
// (the kernel log is read from its end); a new boot id discards them.
const faultsFile = "faults.json"

type storedFaults struct {
	BootID     string            `json:"bootId"`
	Conditions []json.RawMessage `json:"conditions"`
}

func (a *Agent) saveFaultsLocked() {
	out := storedFaults{BootID: a.bootID}
	for _, c := range a.faults {
		raw, err := protojson.Marshal(c)
		if err == nil {
			out.Conditions = append(out.Conditions, raw)
		}
	}
	data, err := json.Marshal(out)
	if err == nil {
		err = writeFile(filepath.Join(a.o.DataDir, faultsFile), data, 0o600)
	}
	if err != nil {
		a.log.Warn("store the XID conditions", "error", err.Error())
	}
}

// loadFaults restores the conditions of this boot.
func (a *Agent) loadFaults() {
	raw, err := os.ReadFile(filepath.Join(a.o.DataDir, faultsFile))
	if err != nil {
		return
	}
	var stored storedFaults
	if json.Unmarshal(raw, &stored) != nil || stored.BootID != a.bootID {
		return
	}
	for _, r := range stored.Conditions {
		c := &agentv1.Condition{}
		if protojson.Unmarshal(r, c) == nil {
			a.faults = append(a.faults, c)
		}
	}
}

func withoutFaults(conditions []*agentv1.Condition) []*agentv1.Condition {
	out := conditions[:0:0]
	for _, c := range conditions {
		if !strings.HasPrefix(c.GetType(), "Xid") {
			out = append(out, c)
		}
	}
	return out
}

func cloneConditions(in []*agentv1.Condition) []*agentv1.Condition {
	out := make([]*agentv1.Condition, len(in))
	for i, c := range in {
		out[i] = proto.Clone(c).(*agentv1.Condition)
	}
	return out
}
