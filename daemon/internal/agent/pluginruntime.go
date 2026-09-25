package agent

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	driverv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1"
	"github.com/better-compute/better-compute/daemon/internal/bcx"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// PluginRuntime is a runtime a bcx plugin serves (PLAN.md §5.6 walkthrough 4): a hosted driver whose
// manifest lists the kind "runtime". It speaks the TypeScript RuntimeDriver contract
// (packages/vps/src/runtime.ts) over Invoke, with positional JSON arguments:
//
//	list()           → [{id, state, addresses, message?}]
//	apply(spec)      → {id, state, addresses, message?}   spec: core's InstanceSpec
//	remove(id)       → null
//
// apply converges one instance to its spec, desired state included, so Ensure only records the spec
// and SetState applies it. Snapshots are not part of the bcx contract yet (UNSUPPORTED).
type PluginRuntime struct {
	ID   string
	Host DriverHost

	mu sync.Mutex
	// specs are the instances' last specs (core JSON shape), for SetState; firstBoot holds a new
	// instance's user data and restore until an apply succeeded.
	specs     map[string]*coreInstanceSpec
	firstBoot map[string]*coreInstanceSpec
}

// PluginRuntimes wraps the hosted drivers that implement "runtime" and are not built into bcd.
func PluginRuntimes(drivers []HostedDriver, builtin []runtime.Runtime) []runtime.Runtime {
	have := map[string]bool{}
	for _, r := range builtin {
		have[r.Name()] = true
	}
	var out []runtime.Runtime
	for _, d := range drivers {
		for _, k := range d.Manifest.GetKinds() {
			if k == "runtime" && !have[d.Manifest.GetId()] {
				have[d.Manifest.GetId()] = true
				out = append(out, &PluginRuntime{ID: d.Manifest.GetId(), Host: d.Host})
			}
		}
	}
	return out
}

// coreInstanceSpec is core's InstanceSpec (packages/core/src/domain.ts) as JSON.
type coreInstanceSpec struct {
	ID            string       `json:"id"`
	DesiredState  string       `json:"desiredState"`
	Runtime       string       `json:"runtime"`
	Flavor        coreFlavor   `json:"flavor"`
	Image         *coreImage   `json:"image,omitempty"`
	UserData      string       `json:"userData,omitempty"`
	DeviceIDs     []string     `json:"deviceIds,omitempty"`
	AllocationID  string       `json:"allocationId,omitempty"`
	Nics          []coreNic    `json:"nics,omitempty"`
	RestoreFrom   *coreRestore `json:"restoreFrom,omitempty"`
	NetworkPolicy string       `json:"networkPolicy,omitempty"`
}

type coreFlavor struct {
	VCPU      uint32  `json:"vcpu"`
	MemoryGiB float64 `json:"memoryGiB"`
	DiskGiB   float64 `json:"diskGiB"`
	GPUs      int     `json:"gpus,omitempty"`
}

type coreImage struct {
	URL    string `json:"url"`
	Sha256 string `json:"sha256"`
	Format string `json:"format"`
}

type coreNic struct {
	Network   string   `json:"network"`
	Mac       string   `json:"mac"`
	Addresses []string `json:"addresses"`
}

type coreRestore struct {
	URL     string `json:"url"`
	Sha256  string `json:"sha256"`
	ImageID string `json:"imageId"`
}

type coreInstanceStatus struct {
	ID        string   `json:"id"`
	State     string   `json:"state"`
	Addresses []string `json:"addresses"`
	Message   string   `json:"message,omitempty"`
}

func (p *PluginRuntime) Name() string { return p.ID }

func (p *PluginRuntime) invoke(ctx context.Context, operation, key string, args ...any) (string, error) {
	if args == nil {
		args = []any{}
	}
	raw, err := json.Marshal(args)
	if err != nil {
		return "", err
	}
	result, err := p.Host.Invoke(ctx, &driverv1.InvokeRequest{
		DriverId: p.ID, Kind: "runtime", Operation: operation, ConfigJson: "{}", ArgsJson: string(raw), IdempotencyKey: key,
	}, nil)
	if err != nil {
		var de *bcx.Error
		if errors.As(err, &de) {
			return "", fmt.Errorf("%s %s: %s: %s", p.ID, operation, de.Code, de.Message)
		}
		return "", fmt.Errorf("%s %s: %w", p.ID, operation, err)
	}
	return result, nil
}

func domainOf(runtimeID string, s coreInstanceStatus) runtime.Domain {
	state := runtime.StateStopped
	switch s.State {
	case "running":
		state = runtime.StateRunning
	case "paused":
		state = runtime.StatePaused
	case "error":
		state = runtime.StateError
	}
	return runtime.Domain{ID: s.ID, Runtime: runtimeID, Managed: true, State: state, Addresses: s.Addresses, Message: s.Message}
}

// List returns what the plugin holds. Everything a runtime plugin holds is bcd's: the plugin
// creates instances only when bcd applies a spec.
func (p *PluginRuntime) List(ctx context.Context) ([]runtime.Domain, error) {
	raw, err := p.invoke(ctx, "list", "")
	if err != nil {
		return nil, err
	}
	var statuses []coreInstanceStatus
	if err := json.Unmarshal([]byte(raw), &statuses); err != nil {
		return nil, fmt.Errorf("%s list: %w", p.ID, err)
	}
	out := make([]runtime.Domain, 0, len(statuses))
	for _, s := range statuses {
		if s.ID != "" {
			out = append(out, domainOf(p.ID, s))
		}
	}
	return out, nil
}

// coreSpecOf converts a spec to core's shape; the desired state is filled in by SetState.
func coreSpecOf(spec *agentv1.InstanceSpec) *coreInstanceSpec {
	c := &coreInstanceSpec{
		ID:      spec.GetInstanceId(),
		Runtime: spec.GetRuntime(),
		Flavor: coreFlavor{
			VCPU: spec.GetVcpu(), MemoryGiB: float64(spec.GetMemoryBytes()) / (1 << 30), DiskGiB: float64(spec.GetDiskBytes()) / (1 << 30),
			GPUs: len(spec.GetGpuDeviceIds()),
		},
		DeviceIDs:    spec.GetGpuDeviceIds(),
		AllocationID: spec.GetAllocationId(),
	}
	if img := spec.GetImage(); img.GetUrl() != "" {
		c.Image = &coreImage{URL: img.GetUrl(), Sha256: hex.EncodeToString(img.GetSha256()), Format: img.GetFormat()}
	}
	for _, n := range spec.GetNics() {
		c.Nics = append(c.Nics, coreNic{Network: n.GetNetwork(), Mac: n.GetMac(), Addresses: append([]string{}, n.GetAddresses()...)})
	}
	if pol := spec.GetNetworkPolicy(); pol != agentv1.InstanceNetworkPolicy_INSTANCE_NETWORK_POLICY_UNSPECIFIED {
		c.NetworkPolicy = policyName(pol)
	}
	return c
}

// Ensure records the spec (with a new instance's user data and snapshot) for SetState, which
// applies it: the plugin's apply both defines and starts.
func (p *PluginRuntime) Ensure(_ context.Context, spec *agentv1.InstanceSpec, userData []byte, restore *runtime.Restore) error {
	c := coreSpecOf(spec)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.specs == nil {
		p.specs, p.firstBoot = map[string]*coreInstanceSpec{}, map[string]*coreInstanceSpec{}
	}
	p.specs[c.ID] = c
	if len(userData) > 0 || restore != nil {
		first := *c
		first.UserData = string(userData)
		if restore != nil {
			// The snapshot is already downloaded and verified: the plugin reads the local file.
			first.RestoreFrom = &coreRestore{URL: "file://" + restore.Path, Sha256: restore.Sha256, ImageID: spec.GetRestoreFrom().GetRef()}
		}
		p.firstBoot[c.ID] = &first
	}
	return nil
}

// SetState applies the instance's last spec with the desired state.
func (p *PluginRuntime) SetState(ctx context.Context, id, state string) error {
	p.mu.Lock()
	spec := p.firstBoot[id]
	first := spec != nil
	if spec == nil {
		spec = p.specs[id]
	}
	p.mu.Unlock()
	if spec == nil {
		return fmt.Errorf("%s: no spec for %s yet", p.ID, id)
	}
	applied := *spec
	applied.DesiredState = state
	raw, err := p.invoke(ctx, "apply", "instance:"+id+":apply:"+state, applied)
	if err != nil {
		return err
	}
	var st coreInstanceStatus
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		return fmt.Errorf("%s apply: %w", p.ID, err)
	}
	if first {
		p.mu.Lock()
		delete(p.firstBoot, id)
		p.mu.Unlock()
	}
	if st.State == "error" {
		return fmt.Errorf("%s: %s", p.ID, strings.TrimSpace(firstNonEmpty(st.Message, "the instance failed")))
	}
	return nil
}

// Destroy removes the instance.
func (p *PluginRuntime) Destroy(ctx context.Context, id string) error {
	if _, err := p.invoke(ctx, "remove", "instance:"+id+":remove", id); err != nil {
		return err
	}
	p.mu.Lock()
	delete(p.specs, id)
	delete(p.firstBoot, id)
	p.mu.Unlock()
	return nil
}

// Snapshot is not in the bcx runtime contract yet.
func (p *PluginRuntime) Snapshot(context.Context, string, bool, string, io.Writer) (string, error) {
	return "", &KindError{Code: "unsupported", Message: "runtime " + p.ID + " (a bcx plugin) does not take snapshots"}
}
