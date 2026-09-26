package agent

import (
	"sort"
	"time"
)

// Status is what `bcd status` shows: the agent's view of itself, from memory and the journal.
type Status struct {
	NodeID      string `json:"nodeId"`
	SiteID      string `json:"siteId"`
	Role        string `json:"role"`
	Version     string `json:"version"`
	BootID      string `json:"bootId"`
	Incarnation string `json:"incarnation"`
	JournalID   string `json:"journalId"`

	Connected bool   `json:"connected"`
	Epoch     uint64 `json:"epoch"`
	// ClockOffsetMs is server time minus local time, from the last Welcome.
	ClockOffsetMs int64 `json:"clockOffsetMs"`

	AppliedGeneration  uint64          `json:"appliedGeneration"`
	ObservedGeneration uint64          `json:"observedGeneration"`
	Sections           []SectionStatus `json:"sections,omitempty"`

	Running  []string `json:"running"`
	Deferred []string `json:"deferred"`

	PendingEvents  int    `json:"pendingEvents"`
	DroppedMetrics uint64 `json:"droppedMetrics"`
	WaitingEvents  int    `json:"waitingEvents"`

	CertificateNotAfter time.Time `json:"certificateNotAfter"`
	// NodeKey is what holds the node key: "tpm" or "file".
	NodeKey        string `json:"nodeKey"`
	TrustVersion   uint64 `json:"trustVersion"`
	CommandSigning bool   `json:"commandSigning"`

	// GPUs, Kubernetes and Telemetry: the machine's side (status_gpu.go).
	GPUs       []GPUStatus      `json:"gpus,omitempty"`
	Kubernetes *KubeStatus      `json:"kubernetes,omitempty"`
	Telemetry  *TelemetryStatus `json:"telemetry,omitempty"`
}

// SectionStatus is one NodeSpec section's last converger outcome.
type SectionStatus struct {
	Section string `json:"section"`
	State   string `json:"state"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

// Status reports the agent's state, and the machine's: its GPUs read now, the kubelet device
// plugins and the telemetry export.
func (a *Agent) Status() Status {
	st := a.agentStatus()
	st.GPUs = a.gpuStatus()
	st.Kubernetes = a.kubeStatus()
	st.Telemetry = a.telemetry.status()
	return st
}

func (a *Agent) agentStatus() Status {
	a.mu.Lock()
	defer a.mu.Unlock()
	meta, _ := a.j.Meta()
	stats, _ := a.j.EventStats()
	st := Status{
		NodeID:              a.NodeID(),
		SiteID:              a.state.SiteID,
		Role:                a.state.Role,
		Version:             a.o.Version,
		BootID:              a.bootID,
		Incarnation:         a.incarnation,
		JournalID:           meta.JournalID,
		Connected:           a.sess != nil && a.sess.welcomed,
		Epoch:               meta.LastEpoch,
		ClockOffsetMs:       a.offset.Milliseconds(),
		AppliedGeneration:   a.applied,
		ObservedGeneration:  a.observed,
		Running:             []string{},
		Deferred:            []string{},
		PendingEvents:       stats.Count,
		DroppedMetrics:      stats.DroppedMetrics,
		WaitingEvents:       len(a.overflow),
		CertificateNotAfter: a.state.NotAfter,
		NodeKey:             NodeKeyKind(a.currentKey()),
		TrustVersion:        a.state.TrustVersion,
		CommandSigning:      len(a.state.TrustRoots) > 0,
	}
	for id := range a.execs {
		st.Running = append(st.Running, id)
	}
	for id := range a.deferred {
		st.Deferred = append(st.Deferred, id)
	}
	sort.Strings(st.Running)
	sort.Strings(st.Deferred)
	if a.lastStatus != nil {
		for _, s := range a.lastStatus.GetSections() {
			st.Sections = append(st.Sections, SectionStatus{
				Section: s.GetSection(), State: s.GetState().String(), Reason: s.GetReason(), Message: s.GetMessage(),
			})
		}
	}
	return st
}
