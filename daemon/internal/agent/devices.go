package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/converge"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/proto"
)

// Where holds live (PLAN.md §3.4 step 9). The CDI spec is the hold itself: it survives reboots, and
// the converger reads the observed holds back from it. The env file lives on tmpfs and is rewritten
// after a reboot.
const (
	cdiDir = "/etc/cdi"
	envDir = "/run/bcd/allocations"
)

func cdiSpecPath(allocationID string) string { return path.Join(cdiDir, "bcd-"+allocationID+".json") }
func envFilePath(allocationID string) string { return path.Join(envDir, allocationID+".env") }

// cdiSpec is the CDI document of a hold (the shape FakeDaemon writes).
type cdiSpec struct {
	CdiVersion     string            `json:"cdiVersion"`
	Kind           string            `json:"kind"`
	Annotations    map[string]string `json:"annotations"`
	Devices        []cdiDevice       `json:"devices"`
	ContainerEdits cdiEdits          `json:"containerEdits"`
}

type cdiDevice struct {
	Name           string   `json:"name"`
	ContainerEdits cdiEdits `json:"containerEdits"`
}

type cdiEdits struct {
	Env []string `json:"env"`
}

const (
	annotationAllocation  = "bcd.dev/allocation-id"
	annotationReservation = "bcd.dev/reservation-id"
	annotationGeneration  = "bcd.dev/generation"
)

type hold struct {
	deviceIDs  []string
	generation uint64
}

// devicesConverger materializes DevicesSection (PLAN.md §3.4, P6): it releases holds no longer
// desired, keeps the ones still desired (rewriting a missing env file), and binds new ones in spec
// order unless the binding is unsupported, a device is missing, or a device is already held
// (AllocationFailed, section FAILED). It never drops a hold on its own. Every bind and release is a
// node-signed AttestedReport event.
type devicesConverger struct {
	a          *Agent
	generation uint64
	// failed remembers the generation an allocation's failure was reported at (reported once).
	failed map[string]uint64
}

func (d *devicesConverger) Section() converge.Section { return converge.SectionDevices }

func (d *devicesConverger) Plan(_ context.Context, desired []byte) ([]converge.Action, error) {
	section := &agentv1.DevicesSection{}
	if err := proto.Unmarshal(desired, section); err != nil {
		return nil, converge.Terminal(fmt.Errorf("devices section: %w", err))
	}
	host := d.a.host
	observed, err := d.observed()
	if err != nil {
		return nil, err
	}
	generation := d.generation
	var actions []converge.Action
	wanted := map[string]bool{}
	for _, as := range section.GetAssignments() {
		wanted[as.GetAllocationId()] = true
	}
	var released []string
	for id := range observed {
		if !wanted[id] {
			released = append(released, id)
		}
	}
	sort.Strings(released)
	for _, id := range released {
		h := observed[id]
		delete(observed, id)
		actions = append(actions, converge.Action{
			Description: "release " + id,
			Apply: func(context.Context) error {
				for _, p := range []string{cdiSpecPath(id), envFilePath(id)} {
					if err := host.RemoveFile(p); err != nil {
						return err
					}
				}
				d.a.log.Info("allocation released", "allocation", id, "generation", generation)
				d.a.emitAttested(journal.ClassTransition, "allocation.released", &agentv1.AttestedReportBody{
					Report: &agentv1.AttestedReportBody_AllocationReleased{AllocationReleased: &agentv1.AllocationReleased{
						AllocationId: id, Generation: generation, DeviceIds: h.deviceIDs,
					}},
				})
				return nil
			},
		})
	}
	claimed := map[string]string{}
	for _, as := range section.GetAssignments() {
		if h, ok := observed[as.GetAllocationId()]; ok {
			for _, dev := range h.deviceIDs {
				claimed[dev] = as.GetAllocationId()
			}
		}
	}
	d.a.invMu.Lock()
	present := map[string]bool{}
	for _, g := range gpuUUIDs(d.a.inv) {
		present[g] = true
	}
	d.a.invMu.Unlock()

	type failure struct{ id, reason, message string }
	var failures []failure
	for _, as := range section.GetAssignments() {
		as := as
		id := as.GetAllocationId()
		ids := make([]string, 0, len(as.GetDevices()))
		for _, dev := range as.GetDevices() {
			ids = append(ids, dev.GetId())
		}
		if _, held := observed[id]; held {
			if _, err := os.Stat(host.Path(envFilePath(id))); errors.Is(err, os.ErrNotExist) {
				actions = append(actions, converge.Action{
					Description: "rewrite the env file of " + id,
					Apply: func(context.Context) error {
						return host.WriteFile(envFilePath(id), envFile(as), 0o644)
					},
				})
			}
			continue
		}
		if as.GetBinding() != agentv1.Binding_BINDING_HOLD {
			failures = append(failures, failure{id, "unsupported-binding", fmt.Sprintf("binding %s is not supported", as.GetBinding())})
			continue
		}
		if foreign := foreignDevice(as); foreign != "" {
			failures = append(failures, failure{id, "unsupported-device", fmt.Sprintf("device class %s cannot be held", foreign)})
			continue
		}
		var missing []string
		for _, dev := range ids {
			if !present[dev] {
				missing = append(missing, dev)
			}
		}
		if len(missing) > 0 {
			failures = append(failures, failure{id, "device-missing", strings.Join(missing, ", ") + " not present"})
			continue
		}
		if msg := overlap(ids, claimed, id); msg != "" {
			failures = append(failures, failure{id, "overlap", msg})
			continue
		}
		for _, dev := range ids {
			claimed[dev] = id
		}
		actions = append(actions, converge.Action{
			Description: "bind " + id,
			Apply: func(context.Context) error {
				spec, err := json.Marshal(newCDISpec(as, generation))
				if err != nil {
					return err
				}
				if err := host.WriteFile(cdiSpecPath(id), spec, 0o644); err != nil {
					return err
				}
				if err := host.WriteFile(envFilePath(id), envFile(as), 0o644); err != nil {
					return err
				}
				delete(d.failed, id)
				cdi := make([]string, 0, len(ids))
				for _, dev := range ids {
					cdi = append(cdi, "bcd.dev/gpu="+dev)
				}
				d.a.log.Info("allocation bound", "allocation", id, "generation", generation, "devices", len(ids))
				d.a.emitAttested(journal.ClassTransition, "allocation.bound", &agentv1.AttestedReportBody{
					Report: &agentv1.AttestedReportBody_AllocationBound{AllocationBound: &agentv1.AllocationBound{
						AllocationId: id,
						Generation:   generation,
						DeviceIds:    ids,
						CdiDevices:   cdi,
						CdiSpecPath:  cdiSpecPath(id),
						EnvFile:      envFilePath(id),
					}},
				})
				return nil
			},
		})
	}
	if len(failures) > 0 {
		actions = append(actions, converge.Action{
			Description: "report failed assignments",
			Apply: func(context.Context) error {
				if d.failed == nil {
					d.failed = map[string]uint64{}
				}
				var msgs []string
				for _, f := range failures {
					msgs = append(msgs, f.id+": "+f.reason)
					if d.failed[f.id] == generation {
						continue
					}
					d.failed[f.id] = generation
					d.a.log.Warn("allocation failed", "allocation", f.id, "reason", f.reason, "generation", generation)
					d.a.emitEvent(journal.ClassTransition, "allocation.failed", &agentv1.Event{
						Body: &agentv1.Event_AllocationFailed{AllocationFailed: &agentv1.AllocationFailed{
							AllocationId: f.id, Generation: generation, Reason: f.reason, Message: f.message,
						}},
					})
				}
				return converge.Terminal(errors.New(strings.Join(msgs, "; ")))
			},
		})
	}
	return actions, nil
}

func foreignDevice(as *agentv1.DeviceAssignment) string {
	for _, dev := range as.GetDevices() {
		if c := dev.GetDeviceClass(); c != "" && c != "gpu" {
			return c
		}
	}
	return ""
}

func overlap(ids []string, claimed map[string]string, id string) string {
	seen := map[string]bool{}
	for _, dev := range ids {
		if seen[dev] {
			return "a device is listed twice"
		}
		seen[dev] = true
		if owner, ok := claimed[dev]; ok && owner != id {
			return dev + " is assigned to " + owner
		}
	}
	return ""
}

// observed reads the holds back from the CDI directory.
func (d *devicesConverger) observed() (map[string]hold, error) {
	dir := d.a.host.Path(cdiDir)
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]hold{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]hold{}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "bcd-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		var spec cdiSpec
		if err := json.Unmarshal(data, &spec); err != nil {
			d.a.log.Warn("unreadable CDI spec ignored", "file", name)
			continue
		}
		id := spec.Annotations[annotationAllocation]
		if id == "" {
			continue
		}
		gen, _ := strconv.ParseUint(spec.Annotations[annotationGeneration], 10, 64)
		h := hold{generation: gen}
		for _, dev := range spec.Devices {
			h.deviceIDs = append(h.deviceIDs, dev.Name)
		}
		out[id] = h
	}
	return out, nil
}

// assignedDevices lists the devices of the live holds (gpu.reset refuses them).
func (d *devicesConverger) assignedDevices() map[string]bool {
	holds, err := d.observed()
	out := map[string]bool{}
	if err != nil {
		return out
	}
	for _, h := range holds {
		for _, dev := range h.deviceIDs {
			out[dev] = true
		}
	}
	return out
}

func newCDISpec(as *agentv1.DeviceAssignment, generation uint64) cdiSpec {
	spec := cdiSpec{
		CdiVersion: "0.6.0",
		Kind:       "bcd.dev/gpu",
		Annotations: map[string]string{
			annotationAllocation:  as.GetAllocationId(),
			annotationReservation: as.GetReservationId(),
			annotationGeneration:  strconv.FormatUint(generation, 10),
		},
		ContainerEdits: cdiEdits{Env: []string{"BCD_ALLOCATION_ID=" + as.GetAllocationId()}},
	}
	for _, dev := range as.GetDevices() {
		spec.Devices = append(spec.Devices, cdiDevice{
			Name:           dev.GetId(),
			ContainerEdits: cdiEdits{Env: []string{"NVIDIA_VISIBLE_DEVICES=" + dev.GetId()}},
		})
	}
	return spec
}

func envFile(as *agentv1.DeviceAssignment) []byte {
	ids := make([]string, 0, len(as.GetDevices()))
	for _, dev := range as.GetDevices() {
		ids = append(ids, dev.GetId())
	}
	lines := []string{
		"BCD_ALLOCATION_ID=" + as.GetAllocationId(),
		"BCD_RESERVATION_ID=" + as.GetReservationId(),
		"NVIDIA_VISIBLE_DEVICES=" + strings.Join(ids, ","),
	}
	lines = append(lines, as.GetEnv()...)
	return []byte(strings.Join(lines, "\n") + "\n")
}

func writeFile(p string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return pki.WriteFileAtomic(p, data, mode)
}

// emitAttested journals and sends a node-signed AttestedReport (purpose attested-report, parts
// [body]), so a gateway cannot forge a binding.
func (a *Agent) emitAttested(class journal.EventClass, kind string, body *agentv1.AttestedReportBody) {
	body.NodeId = a.NodeID()
	body.BootId = a.bootID
	b, err := marshal(body)
	if err != nil {
		a.log.Error("encode an attested report", "error", err.Error())
		return
	}
	report := &agentv1.AttestedReport{Body: b}
	if sig, err := pki.SignNodeStatement(a.currentKey(), pki.SigningInput(pki.PurposeAttestedReport, b)); err == nil {
		report.NodeSig = sig
	} else {
		a.log.Error("sign an attested report", "error", err.Error())
	}
	a.emitEvent(class, kind, &agentv1.Event{Body: &agentv1.Event_Attested{Attested: report}})
}
