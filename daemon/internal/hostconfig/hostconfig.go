// Package hostconfig converges NodeSpec.host: the config units a profile's hostConfig resolves to
// (PLAN.md §11.2, §11.3; packages/provision config-units.ts). Each unit owns one concern of the
// host (kernel parameters, memory, the NVIDIA driver, the container toolkit and CDI, the MIG
// layout, Fabric Manager, a Kubernetes join) and is an idempotent plan over what the host shows now.
//
// Units act on the host only through System, so the same code runs in bcd node, in bcd helper (as
// root, when bcd node runs unprivileged) and against FakeSystem in tests. A unit's settings are the
// canonical JSON the control plane validated against the unit's manifest; the daemon decodes them
// strictly again and refuses what it does not understand (terminal: retrying cannot fix it).
//
// Removing a unit from the spec stops managing its concern; it does not undo it (a driver stays
// installed, a joined node stays joined). Units whose state is only bcd's own files (sysctl,
// kernel-modules) implement Cleaner and remove those files.
package hostconfig

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// StateDir holds what the units record about the host (the boot loader's arguments, the CDI spec's
// stamp). It is root's, never bcd's data_dir: under bcd helper the unprivileged node owns data_dir,
// and a record there would let it steer root's writes through a planted symlink.
const StateDir = "/var/lib/bcd-hostconfig"

// Cmd is a program run on the host.
type Cmd struct {
	Name string
	Args []string
	// Env is added to the program's environment (KEY=value).
	Env []string
	// Stdin, when set, is the program's standard input.
	Stdin []byte
}

func (c Cmd) String() string { return strings.TrimSpace(c.Name + " " + strings.Join(c.Args, " ")) }

// System is the host the units configure.
type System interface {
	// ReadFile reads a host file (absolute path). A missing file is an error matching fs.ErrNotExist.
	ReadFile(abs string) ([]byte, error)
	// ReadDir lists a host directory's entry names, sorted. A missing directory matches fs.ErrNotExist.
	ReadDir(abs string) ([]string, error)
	// WriteFile atomically replaces a file bcd owns (/etc/sysctl.d/90-bcd.conf, ...).
	WriteFile(abs string, data []byte, mode fs.FileMode) error
	// RemoveFile removes a file bcd owns; absent is fine.
	RemoveFile(abs string) error
	// WriteKernel writes a kernel tunable in place (/proc/sys/..., /sys/...).
	WriteKernel(abs string, value string) error
	// Run runs a program and returns its standard output. A failure's error carries its output.
	Run(ctx context.Context, cmd Cmd) ([]byte, error)
	// LookPath reports whether a program is installed.
	LookPath(name string) bool
}

// Unit configures one concern of the host.
type Unit interface {
	// Name is the unit's name in NodeSpec.host (ConfigUnit.unit).
	Name() string
	// Plan compares the unit's settings (canonical JSON) with the host and returns the steps that
	// close the gap; none means converged. Plan must not change the host. Settings the unit cannot
	// accept are a converge.Terminal error.
	Plan(ctx context.Context, sys System, settings json.RawMessage) ([]converge.Action, error)
}

// Cleaner is a unit that removes its own files once the spec no longer names it.
type Cleaner interface {
	Unit
	// Clean returns the steps that remove what the unit wrote; none when nothing is left.
	Clean(ctx context.Context, sys System) ([]converge.Action, error)
}

// Condition is a standing fact a unit reports about its concern: health that converging does not
// fix by itself (a daemon that keeps failing). Reported conditions are true; an absent one is false.
type Condition struct {
	Type    string
	Reason  string
	Message string
}

// RebootRequired is the error of a unit whose desired state takes effect only after a reboot (the
// boot loader's arguments, a GPU mode that waits for a reset, a driver in use). bcd never reboots
// on its own: the section keeps retrying, and the node reports condition RebootRequired so the
// control plane or an operator reboots it within the disruption budget.
type RebootRequired struct{ Err error }

func (r *RebootRequired) Error() string { return r.Err.Error() }
func (r *RebootRequired) Unwrap() error { return r.Err }

// RebootPhrase is in every RebootRequired message: a unit applied by bcd helper comes back as text,
// and the phrase is how the node still recognises it.
const RebootPhrase = "reboot the node"

// needsReboot is a RebootRequired error (fmt.Errorf's format, %w included); the message must say
// RebootPhrase.
func needsReboot(format string, args ...any) error {
	err := fmt.Errorf(format, args...)
	if !strings.Contains(err.Error(), RebootPhrase) {
		err = fmt.Errorf("%w: %s", err, RebootPhrase)
	}
	return &RebootRequired{Err: err}
}

// IsRebootRequired reports whether err says the host needs a reboot to converge, typed or as the
// helper's text.
func IsRebootRequired(err error) bool {
	var r *RebootRequired
	return err != nil && (errors.As(err, &r) || strings.Contains(err.Error(), RebootPhrase))
}

// Reporter is a unit that reports conditions while the spec names it.
type Reporter interface {
	Unit
	Conditions(ctx context.Context, sys System, settings json.RawMessage) []Condition
}

// Config is one unit of NodeSpec.host.
type Config struct {
	Unit     string
	Settings json.RawMessage
}

// Registry holds the units a daemon knows, in the order they converge: kernel modules before the
// sysctls that need them, memory before the workloads, the driver before the toolkit and the MIG
// layout, a cluster join last.
type Registry struct {
	units []Unit
	// Delegate, when set, applies a unit that planned changes instead of this process (an
	// unprivileged bcd node asks bcd helper, which plans the unit again as root). settings is nil
	// for a unit the spec no longer names (clean it).
	Delegate func(ctx context.Context, unit string, settings json.RawMessage) error
	// Observe, when set, hears each applied unit's outcome (nil: converged in this pass).
	Observe func(unit string, err error)
}

// Options configure the built-in units.
type Options struct {
	// GPUBusy reports whether a GPU (by UUID) holds allocations; mig-layout leaves those alone.
	GPUBusy func(uuid string) bool
}

// Builtin returns the units bcd ships, in convergence order: kernel modules, then the sysctls they
// provide, memory, CPUs, the driver, Fabric Manager, the MIG layout, GPU sharing on top of it, and
// the container toolkit last, so its CDI spec describes the partitioned GPUs. A cluster join is
// added after them (Registry.Add).
func Builtin(o Options) *Registry {
	return NewRegistry(
		KernelModules{}, Sysctl{}, Hugepages{}, CPU{}, IOMMU{},
		NvidiaDriver{}, FabricManager{}, GPUSettings{}, MigLayout{Busy: o.GPUBusy}, GPUSharing{}, ContainerToolkit{},
	)
}

// NewRegistry returns a registry of units, converged in the order given.
func NewRegistry(units ...Unit) *Registry {
	return &Registry{units: units}
}

// Add appends a unit (a unit of the same name is replaced in place).
func (r *Registry) Add(u Unit) {
	for i, have := range r.units {
		if have.Name() == u.Name() {
			r.units[i] = u
			return
		}
	}
	r.units = append(r.units, u)
}

// Unit returns the unit of that name.
func (r *Registry) Unit(name string) (Unit, bool) {
	for _, u := range r.units {
		if u.Name() == name {
			return u, true
		}
	}
	return nil, false
}

// Names lists the units in convergence order.
func (r *Registry) Names() []string {
	out := make([]string, 0, len(r.units))
	for _, u := range r.units {
		out = append(out, u.Name())
	}
	return out
}

// Plan plans every unit of the spec, and cleans the Cleaners the spec no longer names. Each unit
// that is not converged becomes one action which plans again when it runs, against the host as the
// units before it left it, and applies those steps. A unit that fails to plan up front still gets its
// action (the unit before it may be what it waits for), and a unit that fails to apply does not stop
// the ones after it: a last action reports every failure once all units had their turn.
func (r *Registry) Plan(ctx context.Context, sys System, configs []Config) ([]converge.Action, error) {
	byName := make(map[string]json.RawMessage, len(configs))
	for _, c := range configs {
		if _, dup := byName[c.Unit]; dup {
			return nil, converge.Terminal(fmt.Errorf("unit %s is named twice", c.Unit))
		}
		byName[c.Unit] = c.Settings
	}
	var unknown []string
	for name := range byName {
		if _, ok := r.Unit(name); !ok {
			unknown = append(unknown, name)
		}
	}
	sort.Strings(unknown)

	var actions []converge.Action
	var deferred, failed []error
	for _, u := range r.units {
		settings, named := byName[u.Name()]
		if named && len(bytes.TrimSpace(settings)) == 0 {
			settings = json.RawMessage("{}")
		}
		plan := func(ctx context.Context) ([]converge.Action, error) {
			if named {
				return u.Plan(ctx, sys, settings)
			}
			if c, ok := u.(Cleaner); ok {
				return c.Clean(ctx, sys)
			}
			return nil, nil
		}
		steps, err := plan(ctx)
		if err != nil && errors.Is(err, converge.ErrTerminal) {
			deferred = append(deferred, fmt.Errorf("%s: %w", u.Name(), err))
			continue
		}
		if err == nil && len(steps) == 0 {
			continue
		}
		name := u.Name()
		apply := func(ctx context.Context) error {
			if r.Delegate != nil {
				var s json.RawMessage
				if named {
					s = settings
				}
				return r.Delegate(ctx, name, s)
			}
			steps, err := plan(ctx)
			if err != nil {
				return err
			}
			for _, s := range steps {
				if err := s.Apply(ctx); err != nil {
					return fmt.Errorf("%s: %w", s.Description, err)
				}
			}
			return nil
		}
		// A unit's failure is recorded, not returned: converge stops a section at the first failing
		// action, and one unit waiting (for a reboot, a package) must not hold back the rest.
		actions = append(actions, converge.Action{
			Description: "unit " + name,
			Apply: func(ctx context.Context) error {
				err := apply(ctx)
				if r.Observe != nil {
					r.Observe(name, err)
				}
				if err != nil {
					failed = append(failed, fmt.Errorf("%s: %w", name, err))
				}
				return nil
			},
		})
	}
	for _, name := range unknown {
		deferred = append(deferred, converge.Terminal(fmt.Errorf("unit %s is not supported by this daemon", name)))
	}
	if len(deferred) > 0 || len(actions) > 0 {
		// Last, so every unit that can converge does: the section reports what failed, retryable
		// while any failure is (a terminal one alone fails it).
		actions = append(actions, converge.Action{
			Description: "host units",
			Apply: func(context.Context) error {
				all := append(append([]error(nil), failed...), deferred...)
				if len(all) == 0 {
					return nil
				}
				joined := errors.Join(all...)
				for _, err := range all {
					if !errors.Is(err, converge.ErrTerminal) {
						return retryable{joined}
					}
				}
				return joined
			},
		})
	}
	return actions, nil
}

// retryable carries a joined error whose parts include a terminal one without being terminal
// itself: errors.Is(retryable, converge.ErrTerminal) is false, the text is all of them.
type retryable struct{ err error }

func (r retryable) Error() string { return r.err.Error() }

// As lets errors.As find a RebootRequired among the parts (Is stays false for ErrTerminal).
func (r retryable) As(target any) bool { return errors.As(r.err, target) }

// Conditions collects the conditions of the spec's units that report some, in unit order.
func (r *Registry) Conditions(ctx context.Context, sys System, configs []Config) []Condition {
	var out []Condition
	for _, u := range r.units {
		rep, ok := u.(Reporter)
		if !ok {
			continue
		}
		for _, c := range configs {
			if c.Unit == u.Name() {
				out = append(out, rep.Conditions(ctx, sys, c.Settings)...)
			}
		}
	}
	return out
}

// PlanUnit plans one unit alone (bcd helper applies a unit it was asked to, as root).
func (r *Registry) PlanUnit(ctx context.Context, sys System, name string, settings json.RawMessage) ([]converge.Action, error) {
	u, ok := r.Unit(name)
	if !ok {
		return nil, converge.Terminal(fmt.Errorf("unit %s is not supported by this daemon", name))
	}
	if settings == nil {
		if c, ok := u.(Cleaner); ok {
			return c.Clean(ctx, sys)
		}
		return nil, nil
	}
	return u.Plan(ctx, sys, settings)
}

// decode decodes a unit's settings strictly: unknown fields and trailing data are terminal.
func decode(unit string, settings json.RawMessage, into any) error {
	if len(bytes.TrimSpace(settings)) == 0 {
		settings = json.RawMessage("{}")
	}
	d := json.NewDecoder(bytes.NewReader(settings))
	d.DisallowUnknownFields()
	if err := d.Decode(into); err != nil {
		return converge.Terminal(fmt.Errorf("%s settings: %w", unit, err))
	}
	if d.More() {
		return converge.Terminal(fmt.Errorf("%s settings: trailing data", unit))
	}
	return nil
}

// readTrim reads a small host file and trims it; ok is false when it does not exist.
func readTrim(sys System, abs string) (value string, ok bool, err error) {
	b, err := sys.ReadFile(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return strings.TrimSpace(string(b)), true, nil
}

// ensureFile returns the step that writes data to abs, or none when the file already holds it.
func ensureFile(sys System, abs string, data []byte, mode fs.FileMode) ([]converge.Action, error) {
	have, err := sys.ReadFile(abs)
	if err == nil && bytes.Equal(have, data) {
		return nil, nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return []converge.Action{{
		Description: "write " + abs,
		Apply:       func(context.Context) error { return sys.WriteFile(abs, data, mode) },
	}}, nil
}

// ensureAbsent returns the step that removes abs, or none when it does not exist.
func ensureAbsent(sys System, abs string) ([]converge.Action, error) {
	_, err := sys.ReadFile(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return []converge.Action{{
		Description: "remove " + abs,
		Apply:       func(context.Context) error { return sys.RemoveFile(abs) },
	}}, nil
}

// run returns a step that runs cmd.
func run(sys System, cmd Cmd) converge.Action {
	return converge.Action{
		Description: "run " + cmd.String(),
		Apply: func(ctx context.Context) error {
			_, err := sys.Run(ctx, cmd)
			return err
		},
	}
}

// generatedHeader starts every file bcd writes for a unit.
func generatedHeader(unit string) string {
	return "# Written by bcd for the " + unit + " config unit of this node's NodeSpec. Local edits are replaced.\n"
}
