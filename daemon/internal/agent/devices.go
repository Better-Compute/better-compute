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
	"sync"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/converge"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/kube"
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
	Name string `json:"name"`
	// Annotations carry the atom's real id (CDI names allow no "/"; CDI 0.6 device annotations).
	Annotations    map[string]string `json:"annotations,omitempty"`
	ContainerEdits cdiEdits          `json:"containerEdits"`
}

type cdiEdits struct {
	Env []string `json:"env"`
}

const (
	annotationAllocation  = "bcd.dev/allocation-id"
	annotationReservation = "bcd.dev/reservation-id"
	annotationGeneration  = "bcd.dev/generation"
	annotationDeviceID    = "bcd.dev/device-id"
	// annotationCgroupParent names the hold's slice (PLAN.md §3.8), for containerd, Slurm or a
	// wrapper to place the workload in; BCD_CGROUP_PARENT carries it in the env.
	annotationCgroupParent = "bcd.dev/cgroup-parent"
)

type hold struct {
	deviceIDs  []string
	generation uint64
	// kubernetes: a Kubernetes binding (its release waits for the pods, kuberelease.go).
	kubernetes bool
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
	// limits: the bound, still desired holds that have limits (host admission counts them; read by
	// the instances converger under mu).
	mu     sync.Mutex
	limits map[string]*agentv1.ResourceLimits
	// Kubernetes releases (kuberelease.go): inUseHook replaces kube's InUse in tests; recheck is the
	// pending backstop pass.
	inUseHook func(ctx context.Context, allocationID string) bool
	recheck   *time.Timer
	// releasesUnaccounted reports whether a pod may hold a bcd GPU of an allocation outside live
	// (fail closed): it clears the unreadable-releases marker. nil: only an operator clears it.
	releasesUnaccounted func(ctx context.Context, live map[string]bool) bool
}

func (d *devicesConverger) setLimits(id string, l *agentv1.ResourceLimits) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.limits == nil {
		d.limits = map[string]*agentv1.ResourceLimits{}
	}
	if l == nil {
		delete(d.limits, id)
	} else {
		d.limits[id] = l
	}
}

// sliced says whether a hold runs in its own slice: one with limits, unless the kubelet runs its
// workloads. A Kubernetes binding's pods live in the kubelet's own cgroups (kubepods.slice), where
// the kubelet enforces the pods' requests and limits; bcd's slice would stay empty. The booked
// limits still count in bcd's host admission.
func sliced(as *agentv1.DeviceAssignment) bool {
	return as.GetLimits() != nil && as.GetBinding() != agentv1.Binding_BINDING_KUBERNETES
}

// admits says whether limits need host admission: a memory limit or hugepages.
func admits(l *agentv1.ResourceLimits) bool {
	return l.GetMemoryBytes() > 0 || l.GetHugepages_2Mi() > 0 || l.GetHugepages_1Gi() > 0
}

func (d *devicesConverger) Section() converge.Section { return converge.SectionDevices }

func (d *devicesConverger) Plan(ctx context.Context, desired []byte) ([]converge.Action, error) {
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
	// Kubernetes releases pending from earlier passes: reported once no pod holds their devices.
	actions = append(actions, d.releaseActions(wanted)...)
	for _, id := range released {
		h := observed[id]
		delete(observed, id)
		actions = append(actions, converge.Action{
			Description: "release " + id,
			Apply: func(ctx context.Context) error {
				if h.kubernetes {
					// Recorded before the CDI spec goes, so a crash in between never loses the report.
					if err := d.updateReleasing(func(m map[string]releasing) {
						m[id] = releasing{DeviceIDs: h.deviceIDs, Generation: generation, Since: time.Now()}
					}); err != nil {
						return err
					}
				}
				for _, p := range []string{cdiSpecPath(id), envFilePath(id)} {
					if err := host.RemoveFile(p); err != nil {
						return err
					}
				}
				if h.kubernetes {
					// No longer advertised: the kube reaper evicts pods still holding the devices, and
					// AllocationReleased waits for them (kuberelease.go).
					d.a.log.Info("allocation releasing", "allocation", id, "generation", generation, "kubernetes", true)
					d.a.kube.Trigger()
					d.recheckSoon()
					return nil
				}
				// Its slice goes once empty; a workload still running keeps it (and its limits).
				if name := holdSlice(id); d.a.sliceExists(name) {
					if err := host.RemoveSlice(ctx, name); err != nil {
						d.a.log.Info("hold slice kept", "allocation", id, "reason", err.Error())
					}
				}
				d.a.log.Info("allocation released", "allocation", id, "generation", generation)
				d.a.emitAttested(journal.ClassTransition, "allocation.released", &agentv1.AttestedReportBody{
					Report: &agentv1.AttestedReportBody_AllocationReleased{AllocationReleased: &agentv1.AllocationReleased{
						AllocationId: id, Generation: generation, DeviceIds: h.deviceIDs,
					}},
				})
				d.a.kube.Trigger()
				return nil
			},
		})
	}
	// A slice whose hold is gone, but whose workload outlived the release, stays until it is empty:
	// every pass (the drift pass too) tries to stop it again.
	owned := map[string]bool{}
	for id := range wanted {
		owned[holdSlice(id)] = true
	}
	for _, id := range released {
		owned[holdSlice(id)] = true
	}
	for _, name := range d.a.holdSliceNames() {
		if owned[name] {
			continue
		}
		name := name
		actions = append(actions, converge.Action{
			Description: "stop the leftover slice " + name,
			Apply: func(ctx context.Context) error {
				if err := host.RemoveSlice(ctx, name); err != nil {
					d.a.log.Info("leftover slice kept until its workload exits", "slice", name, "reason", err.Error())
				} else {
					d.a.log.Info("leftover slice stopped", "slice", name)
				}
				return nil
			},
		})
	}
	// Devices of pending Kubernetes releases stay claimed until reported.
	claimed := d.releasingDevices()
	kept := map[string]*agentv1.ResourceLimits{}
	for _, as := range section.GetAssignments() {
		if h, ok := observed[as.GetAllocationId()]; ok {
			for _, dev := range h.deviceIDs {
				claimed[dev] = as.GetAllocationId()
			}
			if admits(as.GetLimits()) {
				kept[as.GetAllocationId()] = as.GetLimits()
			}
		}
	}
	d.mu.Lock()
	d.limits = kept
	d.mu.Unlock()
	// Host admission of new holds with limits (admission.go): probed once, when one needs it, against
	// the runtimes' domains now and the holds kept.
	var hostMem *hostMemory
	probed := !d.a.holdAdmission()
	admitHold := func(l *agentv1.ResourceLimits) error {
		if !probed {
			probed = true
			m, err := d.a.probeForHolds(ctx, kept)
			if err != nil {
				d.a.log.Warn("host memory unreadable; binding without host-side admission", "err", err)
			}
			hostMem = m
		}
		if hostMem == nil {
			return nil
		}
		return hostMem.admitHold(l)
	}
	d.a.invMu.Lock()
	inv := d.a.inv
	d.a.invMu.Unlock()
	// GPUs VMs have (VFIO): never held beside them.
	passed := d.a.passedGPUs()
	mps := d.mpsRunning()
	resolve := func(as *agentv1.DeviceAssignment) ([]atom, string, string) {
		atoms := make([]atom, 0, len(as.GetDevices()))
		var missing []string
		for _, dev := range as.GetDevices() {
			a, reason, message := resolveAtom(inv, dev)
			if reason == "device-missing" {
				missing = append(missing, message)
				continue
			}
			if reason != "" {
				return nil, reason, message
			}
			atoms = append(atoms, a)
		}
		if len(missing) > 0 {
			return nil, "device-missing", strings.Join(missing, "; ")
		}
		return atoms, "", ""
	}

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
			if limits := as.GetLimits(); sliced(as) && !d.a.sliceExists(holdSlice(id)) {
				// Runtime properties vanish on a reboot; the hold (its CDI spec) does not.
				actions = append(actions, converge.Action{
					Description: "restore the slice of " + id,
					Apply: func(ctx context.Context) error {
						return host.ApplySlice(ctx, holdSlice(id), sliceLimits(limits))
					},
				})
			}
			if _, err := os.Stat(host.Path(envFilePath(id))); errors.Is(err, os.ErrNotExist) {
				atoms, _, _ := resolve(as)
				actions = append(actions, converge.Action{
					Description: "rewrite the env file of " + id,
					Apply: func(context.Context) error {
						return host.WriteFile(envFilePath(id), envFile(as, atoms, mps), 0o644)
					},
				})
			}
			continue
		}
		// A Kubernetes binding is a hold the node's device plugin hands to the kubelet (kube package).
		if b := as.GetBinding(); b != agentv1.Binding_BINDING_HOLD && b != agentv1.Binding_BINDING_KUBERNETES {
			failures = append(failures, failure{id, "unsupported-binding", fmt.Sprintf("binding %s is not supported", as.GetBinding())})
			continue
		}
		atoms, reason, message := resolve(as)
		if reason != "" {
			failures = append(failures, failure{id, reason, message})
			continue
		}
		if msg := holdConflict(id, atoms, claimed, passed); msg != "" {
			failures = append(failures, failure{id, "overlap", msg})
			continue
		}
		if admits(as.GetLimits()) {
			if err := admitHold(as.GetLimits()); err != nil {
				// The control plane re-places the bind (markAllocationFailed).
				failures = append(failures, failure{id, "resources-exhausted", err.Error()})
				continue
			}
		}
		for _, dev := range ids {
			claimed[dev] = id
		}
		actions = append(actions, converge.Action{
			Description: "bind " + id,
			Apply: func(ctx context.Context) error {
				if limits := as.GetLimits(); sliced(as) {
					if err := host.ApplySlice(ctx, holdSlice(id), sliceLimits(limits)); err != nil {
						return fmt.Errorf("the slice of %s: %w", id, err)
					}
				}
				spec, err := json.Marshal(newCDISpec(as, generation, atoms, mps))
				if err != nil {
					return err
				}
				if err := host.WriteFile(cdiSpecPath(id), spec, 0o644); err != nil {
					return err
				}
				if err := host.WriteFile(envFilePath(id), envFile(as, atoms, mps), 0o644); err != nil {
					return err
				}
				delete(d.failed, id)
				if admits(as.GetLimits()) {
					d.setLimits(id, as.GetLimits())
				}
				cdi := make([]string, 0, len(ids))
				for _, dev := range ids {
					cdi = append(cdi, "bcd.dev/gpu="+cdiDeviceName(dev))
				}
				d.a.log.Info("allocation bound", "allocation", id, "generation", generation, "devices", len(ids))
				bound := &agentv1.AllocationBound{
					AllocationId: id,
					Generation:   generation,
					DeviceIds:    ids,
					CdiDevices:   cdi,
					CdiSpecPath:  cdiSpecPath(id),
					EnvFile:      envFilePath(id),
				}
				if sliced(as) {
					// Where the user runs the workload (reservations.get: binding.cgroupParent).
					bound.CgroupParent = holdSlice(id)
				}
				d.a.emitAttested(journal.ClassTransition, "allocation.bound", &agentv1.AttestedReportBody{
					Report: &agentv1.AttestedReportBody_AllocationBound{AllocationBound: bound},
				})
				d.a.kube.Trigger()
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

// passedGPUs are the GPUs VMs have or are to have (VFIO): GPU UUID → instance. The current specs',
// plus what running domains had at the last pass (a GPU dropped from a running VM's spec stays its
// until the next start).
func (a *Agent) passedGPUs() map[string]string {
	out := map[string]string{}
	if a.instances == nil {
		return out
	}
	a.instances.specsMu.Lock()
	for gpu, id := range a.instances.passed {
		out[gpu] = id
	}
	a.instances.specsMu.Unlock()
	for _, spec := range a.instances.currentSpecs() {
		if spec.GetDesiredState() == agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_DELETED {
			continue
		}
		for _, gpu := range spec.GetGpuDeviceIds() {
			out[gpu] = spec.GetInstanceId()
		}
	}
	return out
}

// mpsRunning reports whether the MPS control daemon's pipe directory exists (hostconfig's
// gpu-sharing unit in mps mode).
func (d *devicesConverger) mpsRunning() bool {
	info, err := os.Stat(d.a.host.Path(mpsPipeDir))
	return err == nil && info.IsDir()
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
		h := hold{generation: gen, kubernetes: spec.Annotations[kube.AnnotationBinding] == kube.BindingKubernetes}
		for _, dev := range spec.Devices {
			// The real atom id (a MIG instance's or slot's has a "/" a CDI name cannot).
			if real := dev.Annotations[annotationDeviceID]; real != "" {
				h.deviceIDs = append(h.deviceIDs, real)
			} else {
				h.deviceIDs = append(h.deviceIDs, dev.Name)
			}
		}
		out[id] = h
	}
	return out, nil
}

// assignedDevices lists the devices of the live holds, and of Kubernetes releases pods may still
// hold (gpu.reset, VM passthrough and hostconfig refuse them).
func (d *devicesConverger) assignedDevices() map[string]bool {
	holds, err := d.observed()
	out := map[string]bool{}
	for dev := range d.releasingDevices() {
		out[dev] = true
	}
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

// holdEnv is what every workload of a hold gets beside its devices: the allocation, the slice it
// runs in when the hold has limits, and the MPS pipe for slots when MPS runs.
func holdEnv(as *agentv1.DeviceAssignment, atoms []atom, mps bool) []string {
	env := []string{"BCD_ALLOCATION_ID=" + as.GetAllocationId()}
	if sliced(as) {
		env = append(env, "BCD_CGROUP_PARENT="+holdSlice(as.GetAllocationId()))
	}
	for _, a := range atoms {
		if a.class == "gpu.slot" && mps {
			env = append(env, "CUDA_MPS_PIPE_DIRECTORY="+mpsPipeDir)
			break
		}
	}
	return env
}

func newCDISpec(as *agentv1.DeviceAssignment, generation uint64, atoms []atom, mps bool) cdiSpec {
	spec := cdiSpec{
		CdiVersion: "0.6.0",
		Kind:       "bcd.dev/gpu",
		Annotations: map[string]string{
			annotationAllocation:  as.GetAllocationId(),
			annotationReservation: as.GetReservationId(),
			annotationGeneration:  strconv.FormatUint(generation, 10),
		},
		ContainerEdits: cdiEdits{Env: holdEnv(as, atoms, mps)},
	}
	if sliced(as) {
		spec.Annotations[annotationCgroupParent] = holdSlice(as.GetAllocationId())
	}
	if as.GetBinding() == agentv1.Binding_BINDING_KUBERNETES {
		// Only these holds' devices are advertised to the kubelet (kube.ReadHolds).
		spec.Annotations[kube.AnnotationBinding] = kube.BindingKubernetes
	} else {
		// One key for the whole hold: per-device env would repeat NVIDIA_VISIBLE_DEVICES and the last
		// device would win. (A Kubernetes pod may get part of a hold: the plugin sets its own in
		// Allocate.)
		spec.ContainerEdits.Env = append(spec.ContainerEdits.Env, "NVIDIA_VISIBLE_DEVICES="+strings.Join(visibleDevices(atoms), ","))
	}
	for _, a := range atoms {
		spec.Devices = append(spec.Devices, cdiDevice{
			Name:        cdiDeviceName(a.id),
			Annotations: map[string]string{annotationDeviceID: a.id},
		})
	}
	return spec
}

// visibleDevices is what NVIDIA_VISIBLE_DEVICES lists for atoms: two slots of one GPU are one device
// to the driver.
func visibleDevices(atoms []atom) []string {
	out := make([]string, 0, len(atoms))
	seen := map[string]bool{}
	for _, a := range atoms {
		if !seen[a.visible] {
			seen[a.visible] = true
			out = append(out, a.visible)
		}
	}
	return out
}

func envFile(as *agentv1.DeviceAssignment, atoms []atom, mps bool) []byte {
	lines := holdEnv(as, atoms, mps)
	lines = append(lines, "BCD_RESERVATION_ID="+as.GetReservationId(), "NVIDIA_VISIBLE_DEVICES="+strings.Join(visibleDevices(atoms), ","))
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
