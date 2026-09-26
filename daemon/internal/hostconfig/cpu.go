package hostconfig

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// CPU is the `cpu` unit (PLAN §3.8): the frequency governor, and CPUs isolated from the scheduler
// for pinned vCPUs and holds. The governor is set live on every CPU that has cpufreq (a VM without
// it has nothing to set). Isolation is kernel arguments (isolcpus, nohz_full, rcu_nocbs) the boot
// loader carries from the next boot; until the kernel shows those CPUs isolated the unit reports
// that the node needs a reboot, and it never reboots. Removing the unit removes the arguments.
type CPU struct{}

// Paths the cpu unit reads.
const (
	CPUDir      = "/sys/devices/system/cpu"
	CPUIsolated = CPUDir + "/isolated"
)

type cpuSettings struct {
	Governor string `json:"governor"`
	Isolate  string `json:"isolate"`
}

var (
	cpuList  = regexp.MustCompile(`^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$`)
	cpuEntry = regexp.MustCompile(`^cpu[0-9]+$`)
)

func (CPU) Name() string { return "cpu" }

// ParseCPUList parses the kernel's cpulist form ("0-3,8,10-11"); "" is no CPU.
func ParseCPUList(s string) ([]int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	if !cpuList.MatchString(s) || len(s) > 256 {
		return nil, fmt.Errorf("%q is not a CPU list", s)
	}
	seen := map[int]bool{}
	for _, part := range strings.Split(s, ",") {
		lo, hi, isRange := strings.Cut(part, "-")
		a, err := strconv.Atoi(lo)
		if err != nil {
			return nil, err
		}
		b := a
		if isRange {
			if b, err = strconv.Atoi(hi); err != nil {
				return nil, err
			}
		}
		if b < a || b > 8191 {
			return nil, fmt.Errorf("%q is not a CPU range", part)
		}
		for c := a; c <= b; c++ {
			seen[c] = true
		}
	}
	out := make([]int, 0, len(seen))
	for c := range seen {
		out = append(out, c)
	}
	sort.Ints(out)
	return out, nil
}

// FormatCPUList renders sorted CPUs in the kernel's canonical cpulist form.
func FormatCPUList(cpus []int) string {
	var parts []string
	for i := 0; i < len(cpus); {
		j := i
		for j+1 < len(cpus) && cpus[j+1] == cpus[j]+1 {
			j++
		}
		if j == i {
			parts = append(parts, strconv.Itoa(cpus[i]))
		} else {
			parts = append(parts, fmt.Sprintf("%d-%d", cpus[i], cpus[j]))
		}
		i = j + 1
	}
	return strings.Join(parts, ",")
}

func (c CPU) Plan(ctx context.Context, sys System, settings json.RawMessage) ([]converge.Action, error) {
	var s cpuSettings
	if err := decode(c.Name(), settings, &s); err != nil {
		return nil, err
	}
	switch s.Governor {
	case "", "performance", "schedutil", "ondemand", "powersave":
	default:
		return nil, converge.Terminal(fmt.Errorf("cpu.governor: %q is not performance, schedutil, ondemand or powersave", s.Governor))
	}
	isolate, err := ParseCPUList(s.Isolate)
	if err != nil {
		return nil, converge.Terminal(fmt.Errorf("cpu.isolate: %w", err))
	}
	if len(isolate) > 0 && isolate[0] == 0 {
		return nil, converge.Terminal(errors.New("cpu.isolate: CPU 0 keeps the host's housekeeping and is never isolated"))
	}
	var actions []converge.Action
	if s.Governor != "" {
		a, err := planGovernor(sys, s.Governor)
		if err != nil {
			return nil, err
		}
		actions = append(actions, a...)
	}
	want := FormatCPUList(isolate)
	args := ""
	if want != "" {
		args = fmt.Sprintf("isolcpus=managed_irq,domain,%s nohz_full=%s rcu_nocbs=%s", want, want, want)
	}
	boot, err := planBootArgs(sys, c.Name(), args)
	if err != nil {
		return nil, err
	}
	actions = append(actions, boot...)
	if want == "" {
		return actions, nil
	}
	have, _, err := readTrim(sys, CPUIsolated)
	if err != nil {
		return nil, err
	}
	if live, _ := ParseCPUList(have); FormatCPUList(live) != want {
		actions = append(actions, fail(needsReboot("cpu: CPUs %s are isolated from the next boot (now: %q): reboot the node", want, have)))
	}
	return actions, nil
}

// planGovernor sets the governor on every CPU with cpufreq whose governor differs. A governor the
// driver does not offer (intel_pstate offers performance and powersave) is terminal.
func planGovernor(sys System, want string) ([]converge.Action, error) {
	entries, err := sys.ReadDir(CPUDir)
	if err != nil {
		return nil, err
	}
	var stale []string
	for _, e := range entries {
		if !cpuEntry.MatchString(e) {
			continue
		}
		dir := CPUDir + "/" + e + "/cpufreq"
		have, ok, err := readTrim(sys, dir+"/scaling_governor")
		if err != nil {
			return nil, err
		}
		if !ok {
			continue // no cpufreq on this CPU (a VM)
		}
		if have == want {
			continue
		}
		offered, _, err := readTrim(sys, dir+"/scaling_available_governors")
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		if offered != "" && !contains(strings.Fields(offered), want) {
			return nil, converge.Terminal(fmt.Errorf("cpu.governor: %s offers %s, not %s", e, offered, want))
		}
		stale = append(stale, dir+"/scaling_governor")
	}
	if len(stale) == 0 {
		return nil, nil
	}
	return []converge.Action{{
		Description: fmt.Sprintf("set the %s governor on %d CPUs", want, len(stale)),
		Apply: func(context.Context) error {
			for _, p := range stale {
				if err := sys.WriteKernel(p, want); err != nil {
					return err
				}
			}
			return nil
		},
	}}, nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// Clean removes the isolation arguments (the governor stays as it is).
func (c CPU) Clean(_ context.Context, sys System) ([]converge.Action, error) {
	return planBootArgs(sys, c.Name(), "")
}
