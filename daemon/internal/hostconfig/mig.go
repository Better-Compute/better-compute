package hostconfig

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// MigLayout is the `mig-layout` unit: every MIG-capable GPU partitioned to one layout (capacity's
// pool `policy.migLayout`, or the profile's). A layout is
//
//	all-disabled                    MIG mode off
//	all-<profile>                   as many instances of one profile as fit (all-1g.10gb)
//	mixed:<n>x<profile>+<profile>…  these GPU instances on each GPU (mixed:3g.40gb+2x2g.20gb)
//
// with a compute instance filling each GPU instance. Profiles with a `+` of their own (1g.10gb+me)
// are not expressible. A GPU is repartitioned only when Busy says nothing is allocated on it; the
// control plane changes a pool's layout only once its atoms are free (capacity §10.4), so this is
// the daemon's own guard.
type MigLayout struct {
	// Busy reports whether a GPU (by UUID) holds allocations. Nil means never busy.
	Busy func(uuid string) bool
}

type migLayoutSettings struct {
	From   string `json:"from"`
	Layout string `json:"layout"`
}

// Layout is a parsed MIG layout.
type Layout struct {
	// Disabled turns MIG mode off.
	Disabled bool
	// Fill, when set, is the one profile repeated as often as it fits.
	Fill string
	// Profiles are the GPU instances of a mixed layout, sorted.
	Profiles []string
}

var migProfile = regexp.MustCompile(`^[0-9]+g\.[0-9]+gb$`)

// ParseLayout parses a layout string.
func ParseLayout(s string) (Layout, error) {
	switch {
	case s == "all-disabled":
		return Layout{Disabled: true}, nil
	case strings.HasPrefix(s, "all-"):
		p := strings.TrimPrefix(s, "all-")
		if !migProfile.MatchString(p) {
			return Layout{}, fmt.Errorf("%q is not a MIG profile", p)
		}
		return Layout{Fill: p}, nil
	case strings.HasPrefix(s, "mixed:"):
		var out []string
		for _, part := range strings.Split(strings.TrimPrefix(s, "mixed:"), "+") {
			n, p := 1, part
			if count, rest, ok := strings.Cut(part, "x"); ok && !strings.Contains(count, ".") {
				c, err := strconv.Atoi(count)
				if err != nil || c < 1 || c > 8 {
					return Layout{}, fmt.Errorf("%q is not a count of MIG instances", part)
				}
				n, p = c, rest
			}
			if !migProfile.MatchString(p) {
				return Layout{}, fmt.Errorf("%q is not a MIG profile", p)
			}
			for range n {
				out = append(out, p)
			}
		}
		if len(out) == 0 || len(out) > 8 {
			return Layout{}, fmt.Errorf("a mixed layout holds 1 to 8 instances")
		}
		sort.Strings(out)
		return Layout{Profiles: out}, nil
	}
	return Layout{}, fmt.Errorf("%q is not all-disabled, all-<profile> or mixed:<profiles>", s)
}

func (MigLayout) Name() string { return "mig-layout" }

// migGPU is one GPU as nvidia-smi reports it.
type migGPU struct {
	Index   string
	UUID    string
	Current string // Enabled, Disabled
	Pending string
}

// listMigGPUs returns the MIG-capable GPUs.
func listMigGPUs(ctx context.Context, sys System) ([]migGPU, error) {
	out, err := sys.Run(ctx, Cmd{Name: "nvidia-smi", Args: []string{"--query-gpu=index,uuid,mig.mode.current,mig.mode.pending", "--format=csv,noheader"}})
	if err != nil {
		return nil, err
	}
	var gpus []migGPU
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Split(line, ",")
		if len(f) != 4 {
			continue
		}
		for i := range f {
			f[i] = strings.TrimSpace(f[i])
		}
		if f[2] != "Enabled" && f[2] != "Disabled" {
			continue // not MIG-capable ([N/A])
		}
		gpus = append(gpus, migGPU{Index: f[0], UUID: f[1], Current: f[2], Pending: f[3]})
	}
	return gpus, nil
}

// giRow matches a GPU instance of `nvidia-smi mig -lgi`: | GPU  Name  Profile ID  Instance ID  Placement |.
var giRow = regexp.MustCompile(`^\|\s*(\d+)\s+MIG\s+(\S+)\s+(\d+)\s+(\d+)\s+\S+\s*\|`)

// gpuInstances returns the profiles of a GPU's instances, sorted.
func gpuInstances(ctx context.Context, sys System, index string) ([]string, error) {
	out, err := sys.Run(ctx, Cmd{Name: "nvidia-smi", Args: []string{"mig", "-i", index, "-lgi"}})
	if err != nil {
		if strings.Contains(err.Error(), "No GPU instances found") {
			return nil, nil
		}
		return nil, err
	}
	var profiles []string
	for _, line := range strings.Split(string(out), "\n") {
		if m := giRow.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
			profiles = append(profiles, m[2])
		}
	}
	sort.Strings(profiles)
	return profiles, nil
}

// gipRow matches a profile of `nvidia-smi mig -lgip`: | GPU  Name  ID  Free/Total  Memory ... |.
var gipRow = regexp.MustCompile(`^\|\s*(\d+)\s+MIG\s+(\S+)\s+(\d+)\s+(\d+)/(\d+)\s`)

// profileCapacity returns how many instances of profile fit on an empty GPU.
func profileCapacity(ctx context.Context, sys System, index, profile string) (int, error) {
	out, err := sys.Run(ctx, Cmd{Name: "nvidia-smi", Args: []string{"mig", "-i", index, "-lgip"}})
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(out), "\n") {
		if m := gipRow.FindStringSubmatch(strings.TrimSpace(line)); m != nil && m[2] == profile {
			return strconv.Atoi(m[5])
		}
	}
	return 0, converge.Terminal(fmt.Errorf("mig-layout: GPU %s has no MIG profile %s", index, profile))
}

func (m MigLayout) Plan(ctx context.Context, sys System, settings json.RawMessage) ([]converge.Action, error) {
	var s migLayoutSettings
	if err := decode(m.Name(), settings, &s); err != nil {
		return nil, err
	}
	if s.Layout == "" {
		return nil, nil // the control plane resolved no layout: nothing to hold the GPUs to
	}
	layout, err := ParseLayout(s.Layout)
	if err != nil {
		return nil, converge.Terminal(fmt.Errorf("mig-layout.layout: %w", err))
	}
	gpus, err := listMigGPUs(ctx, sys)
	if err != nil {
		return nil, err
	}
	var actions []converge.Action
	var busy []string
	for _, g := range gpus {
		steps, err := m.planGPU(ctx, sys, g, layout, true)
		if err != nil {
			return nil, err
		}
		if len(steps) == 0 {
			continue
		}
		if m.Busy != nil && m.Busy(g.UUID) {
			busy = append(busy, g.UUID)
			continue
		}
		actions = append(actions, steps...)
	}
	if len(busy) > 0 {
		actions = append(actions, fail(fmt.Errorf("mig-layout: %s hold allocations; they are repartitioned once those end", strings.Join(busy, ", "))))
	}
	return actions, nil
}

// planGPU returns the steps that bring one GPU to layout. Turning MIG mode on changes what the
// GPU can report, so the instances are planned again once it is on (again says whether to).
func (m MigLayout) planGPU(ctx context.Context, sys System, g migGPU, layout Layout, again bool) ([]converge.Action, error) {
	destroy := []converge.Action{
		// Compute instances before GPU instances; "not found" means already none.
		tolerant(sys, Cmd{Name: "nvidia-smi", Args: []string{"mig", "-i", g.Index, "-dci"}}),
		tolerant(sys, Cmd{Name: "nvidia-smi", Args: []string{"mig", "-i", g.Index, "-dgi"}}),
	}
	if layout.Disabled {
		if g.Current == "Disabled" && g.Pending != "Enabled" {
			return nil, nil
		}
		steps := destroy
		steps = append(steps, run(sys, Cmd{Name: "nvidia-smi", Args: []string{"-i", g.Index, "-mig", "0"}}))
		return append(steps, m.resetIfPending(sys, g, "Disabled")), nil
	}
	if g.Current != "Enabled" {
		steps := []converge.Action{
			run(sys, Cmd{Name: "nvidia-smi", Args: []string{"-i", g.Index, "-mig", "1"}}),
			m.resetIfPending(sys, g, "Enabled"),
		}
		if !again {
			return steps, nil
		}
		return append(steps, converge.Action{
			Description: "partition GPU " + g.Index,
			Apply: func(ctx context.Context) error {
				now := g
				now.Current, now.Pending = "Enabled", "Enabled"
				more, err := m.planGPU(ctx, sys, now, layout, false)
				if err != nil {
					return err
				}
				for _, s := range more {
					if err := s.Apply(ctx); err != nil {
						return fmt.Errorf("%s: %w", s.Description, err)
					}
				}
				return nil
			},
		}), nil
	}
	want := layout.Profiles
	if layout.Fill != "" {
		n, err := profileCapacity(ctx, sys, g.Index, layout.Fill)
		if err != nil {
			return nil, err
		}
		want = make([]string, n)
		for i := range want {
			want[i] = layout.Fill
		}
	}
	have, err := gpuInstances(ctx, sys, g.Index)
	if err != nil {
		return nil, err
	}
	if strings.Join(have, ",") == strings.Join(want, ",") {
		return nil, nil
	}
	steps := destroy
	if len(want) > 0 {
		// Largest first: placement is first-fit, and small instances first can strand the big one.
		ordered := append([]string(nil), want...)
		sort.SliceStable(ordered, func(i, j int) bool { return computeSlices(ordered[i]) > computeSlices(ordered[j]) })
		steps = append(steps, run(sys, Cmd{Name: "nvidia-smi", Args: []string{"mig", "-i", g.Index, "-cgi", strings.Join(ordered, ","), "-C"}}))
	}
	return steps, nil
}

// computeSlices is a profile's compute slice count (3 for 3g.40gb).
func computeSlices(profile string) int {
	n, _ := strconv.Atoi(strings.SplitN(profile, "g", 2)[0])
	return n
}

// resetIfPending resets a GPU whose MIG mode change waits for a reset (Ampere); a GPU in use
// refuses, and the node needs a reboot.
func (m MigLayout) resetIfPending(sys System, g migGPU, want string) converge.Action {
	return converge.Action{
		Description: "apply the MIG mode of GPU " + g.Index,
		Apply: func(ctx context.Context) error {
			gpus, err := listMigGPUs(ctx, sys)
			if err != nil {
				return err
			}
			for _, now := range gpus {
				if now.Index != g.Index || now.Current == want {
					continue
				}
				if _, err := sys.Run(ctx, Cmd{Name: "nvidia-smi", Args: []string{"--gpu-reset", "-i", g.Index}}); err != nil {
					return needsReboot("MIG mode %s waits for a GPU reset, which failed (reboot the node): %w", strings.ToLower(want), err)
				}
			}
			return nil
		},
	}
}

// tolerant runs a destroy step for which "nothing to destroy" is success.
func tolerant(sys System, cmd Cmd) converge.Action {
	return converge.Action{
		Description: "run " + cmd.String(),
		Apply: func(ctx context.Context) error {
			_, err := sys.Run(ctx, cmd)
			if err != nil && (strings.Contains(err.Error(), "No GPU instances found") ||
				strings.Contains(err.Error(), "No compute instances found") ||
				strings.Contains(err.Error(), "Not Found")) {
				return nil
			}
			return err
		},
	}
}
