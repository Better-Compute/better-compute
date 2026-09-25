// Package runtime is the host side of VPS instances (PLAN.md §12, v0.3): the Runtime interface the
// instances converger drives, and a fake runtime for fakehw hosts and tests. Real runtimes
// (libvirt-kvm, cloud-hypervisor) implement the same interface.
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// Domain states as a runtime reports them.
const (
	StateRunning = "running"
	StateStopped = "stopped"
	StatePaused  = "paused"
	StateError   = "error"
)

// Domain is one VM (or container) a runtime holds.
type Domain struct {
	ID      string `json:"id"`
	Runtime string `json:"runtime"`
	// Managed: created by bcd for a spec. An unmanaged domain is never touched, only reported.
	Managed      bool     `json:"managed"`
	State        string   `json:"state"`
	Message      string   `json:"message,omitempty"`
	VCPU         uint32   `json:"vcpu"`
	MemoryBytes  uint64   `json:"memoryBytes"`
	DiskBytes    uint64   `json:"diskBytes"`
	Image        string   `json:"image,omitempty"`
	AllocationID string   `json:"allocationId,omitempty"`
	GPUs         []string `json:"gpus,omitempty"`
	MACs         []string `json:"macs,omitempty"`
	Addresses    []string `json:"addresses,omitempty"`
	// UserData is what the guest booted with (NoCloud seed).
	UserData string `json:"userData,omitempty"`
	// Boots counts starts (a resume from paused is not a boot).
	Boots int `json:"boots"`
}

// Runtime drives one hypervisor or container runtime.
type Runtime interface {
	// Name is the runtime driver id (InstanceSpec.runtime), e.g. "libvirt-kvm".
	Name() string
	// List returns every domain the runtime holds, managed or not.
	List(ctx context.Context) ([]Domain, error)
	// Ensure defines the domain for spec, or updates an existing one (resources, NICs, GPUs); it
	// never starts it. userData is the NoCloud user data for a new domain.
	Ensure(ctx context.Context, spec *agentv1.InstanceSpec, userData []byte) error
	// SetState starts, stops, pauses or resumes a managed domain.
	SetState(ctx context.Context, id, state string) error
	// Destroy removes a managed domain and its disks and taps.
	Destroy(ctx context.Context, id string) error
}

// ErrNoCapacity reports a start beyond the host's free vCPU or memory.
var ErrNoCapacity = errors.New("not enough free vCPU or memory on this host")

// Fake is a runtime whose domains live in a JSON file: they outlive the daemon process, and a new
// boot id (a host reboot) stops them, as real VMs would.
type Fake struct {
	RuntimeName string
	Path        string
	BootID      string
	// VCPU and MemoryBytes limit the running domains (0 = unlimited).
	VCPU        uint32
	MemoryBytes uint64

	mu sync.Mutex
}

type fakeState struct {
	BootID  string            `json:"bootId"`
	Domains map[string]Domain `json:"domains"`
}

func (f *Fake) Name() string { return f.RuntimeName }

func (f *Fake) load() (*fakeState, error) {
	st := &fakeState{BootID: f.BootID, Domains: map[string]Domain{}}
	raw, err := os.ReadFile(f.Path)
	if errors.Is(err, os.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, st); err != nil {
		return nil, err
	}
	if st.Domains == nil {
		st.Domains = map[string]Domain{}
	}
	if st.BootID != f.BootID {
		// The host rebooted: every domain is stopped.
		for id, d := range st.Domains {
			if d.State == StateRunning || d.State == StatePaused {
				d.State = StateStopped
			}
			st.Domains[id] = d
		}
		st.BootID = f.BootID
	}
	return st, nil
}

func (f *Fake) save(st *fakeState) error {
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(f.Path, raw, 0o600)
}

func (f *Fake) List(context.Context) ([]Domain, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	st, err := f.load()
	if err != nil {
		return nil, err
	}
	if err := f.save(st); err != nil {
		return nil, err
	}
	out := make([]Domain, 0, len(st.Domains))
	for _, d := range st.Domains {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (f *Fake) Ensure(_ context.Context, spec *agentv1.InstanceSpec, userData []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	st, err := f.load()
	if err != nil {
		return err
	}
	var addrs, macs []string
	for _, n := range spec.GetNics() {
		macs = append(macs, n.GetMac())
		addrs = append(addrs, n.GetAddresses()...)
	}
	d, ok := st.Domains[spec.GetInstanceId()]
	if ok && !d.Managed {
		return fmt.Errorf("a domain named %s exists that bcd did not create", spec.GetInstanceId())
	}
	if !ok {
		d = Domain{ID: spec.GetInstanceId(), Runtime: f.RuntimeName, Managed: true, State: StateStopped, UserData: string(userData),
			AllocationID: spec.GetAllocationId()}
		if img := spec.GetImage(); img != nil {
			d.Image = fmt.Sprintf("%x", img.GetSha256())
		}
	} else if spec.GetDiskBytes() < d.DiskBytes {
		return errors.New("a disk cannot shrink")
	}
	d.VCPU, d.MemoryBytes, d.DiskBytes = spec.GetVcpu(), spec.GetMemoryBytes(), spec.GetDiskBytes()
	d.GPUs, d.MACs, d.Addresses = append([]string(nil), spec.GetGpuDeviceIds()...), macs, addrs
	st.Domains[d.ID] = d
	return f.save(st)
}

func (f *Fake) SetState(_ context.Context, id, state string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	st, err := f.load()
	if err != nil {
		return err
	}
	d, ok := st.Domains[id]
	if !ok || !d.Managed {
		return fmt.Errorf("no managed domain %s", id)
	}
	if (state == StateRunning || state == StatePaused) && d.State != StateRunning && d.State != StatePaused {
		var vcpu uint32
		var mem uint64
		for _, o := range st.Domains {
			if o.ID != id && (o.State == StateRunning || o.State == StatePaused) {
				vcpu += o.VCPU
				mem += o.MemoryBytes
			}
		}
		if (f.VCPU > 0 && vcpu+d.VCPU > f.VCPU) || (f.MemoryBytes > 0 && mem+d.MemoryBytes > f.MemoryBytes) {
			return ErrNoCapacity
		}
		d.Boots++
	}
	d.State, d.Message = state, ""
	st.Domains[id] = d
	return f.save(st)
}

func (f *Fake) Destroy(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	st, err := f.load()
	if err != nil {
		return err
	}
	if d, ok := st.Domains[id]; ok && d.Managed {
		delete(st.Domains, id)
	}
	return f.save(st)
}

// Leak defines a domain bcd did not create (tests: the control plane must report it).
func (f *Fake) Leak(id, state string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	st, err := f.load()
	if err != nil {
		return err
	}
	st.Domains[id] = Domain{ID: id, Runtime: f.RuntimeName, State: state}
	return f.save(st)
}
