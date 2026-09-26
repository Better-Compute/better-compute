package hostconfig

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// Sysctl is the `sysctl` unit: free-form kernel parameters (name → scalar), written to
// /etc/sysctl.d/90-bcd.conf for early boot and set live under /proc/sys.
type Sysctl struct{}

// SysctlFile is the drop-in the sysctl unit owns.
const SysctlFile = "/etc/sysctl.d/90-bcd.conf"

// sysctlKey matches provision's check (config-units.ts).
var sysctlKey = regexp.MustCompile(`^[a-z0-9_]+(?:\.[a-z0-9_-]+)+$`)

func (Sysctl) Name() string { return "sysctl" }

// parseSysctls decodes sysctl settings into name → the value as the kernel shows it.
func parseSysctls(unit string, settings json.RawMessage) (map[string]string, error) {
	raw := map[string]json.RawMessage{}
	if err := decode(unit, settings, &raw); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(raw))
	for key, v := range raw {
		if !sysctlKey.MatchString(key) {
			return nil, converge.Terminal(fmt.Errorf("%s: %q is not a sysctl name", unit, key))
		}
		if reason := guardedSysctl(key); reason != "" {
			return nil, converge.Terminal(fmt.Errorf("%s: %s is refused: %s", unit, key, reason))
		}
		d := json.NewDecoder(bytes.NewReader(v))
		d.UseNumber()
		var value any
		if err := d.Decode(&value); err != nil {
			return nil, converge.Terminal(fmt.Errorf("%s.%s: %w", unit, key, err))
		}
		switch x := value.(type) {
		case bool:
			out[key] = map[bool]string{true: "1", false: "0"}[x]
		case json.Number:
			out[key] = x.String()
		case string:
			if strings.ContainsAny(x, "\n\r\x00") || len(x) > 4096 {
				return nil, converge.Terminal(fmt.Errorf("%s.%s: not a single-line value", unit, key))
			}
			out[key] = normalizeSysctl(x)
		default:
			return nil, converge.Terminal(fmt.Errorf("%s.%s: the value must be a scalar", unit, key))
		}
	}
	return out, nil
}

// guardedSysctls are kernel parameters a spec may not set, whoever sends it: the ones that run a
// program as root (a core pattern pipe, the modprobe and usermode-helper paths) and the ones that
// lower the host's defenses. bcd helper applies units as root for an unprivileged bcd node, so the
// sysctl unit must not be a way from the node's user to root. Prefix entries end in ".".
var guardedSysctls = map[string]string{
	"kernel.core_pattern":                          "a pipe runs a program as root",
	"kernel.modprobe":                              "names the program the kernel runs as root",
	"kernel.usermodehelper.":                       "controls programs the kernel runs as root",
	"kernel.poweroff_cmd":                          "names a program the kernel runs as root",
	"kernel.hotplug":                               "names a program the kernel runs as root",
	"fs.binfmt_misc.":                              "registers interpreters the kernel runs",
	"fs.suid_dumpable":                             "lowers the host's defenses",
	"fs.protected_":                                "lowers the host's defenses",
	"kernel.randomize_va_space":                    "lowers the host's defenses",
	"kernel.kptr_restrict":                         "lowers the host's defenses",
	"kernel.dmesg_restrict":                        "lowers the host's defenses",
	"kernel.yama.":                                 "lowers the host's defenses",
	"kernel.kexec_load_disabled":                   "lowers the host's defenses",
	"kernel.unprivileged_bpf_disabled":             "lowers the host's defenses",
	"kernel.perf_event_paranoid":                   "lowers the host's defenses",
	"kernel.sysrq":                                 "lowers the host's defenses",
	"kernel.modules_disabled":                      "cannot be undone without a reboot",
	"vm.mmap_min_addr":                             "lowers the host's defenses",
	"vm.unprivileged_userfaultfd":                  "lowers the host's defenses",
	"net.core.bpf_jit_harden":                      "lowers the host's defenses",
	"user.":                                        "changes who may create namespaces",
	"kernel.unprivileged_userns_clone":             "changes who may create namespaces",
	"kernel.apparmor_restrict_unprivileged_userns": "changes who may create namespaces",
}

// guardedSysctl returns why a key is refused, or "".
func guardedSysctl(key string) string {
	for k, why := range guardedSysctls {
		if key == k || (strings.HasSuffix(k, ".") || strings.HasSuffix(k, "_")) && strings.HasPrefix(key, k) {
			return why
		}
	}
	return ""
}

// normalizeSysctl collapses whitespace: the kernel shows multi-value tunables tab-separated.
func normalizeSysctl(v string) string { return strings.Join(strings.Fields(v), " ") }

func sysctlPath(key string) string { return "/proc/sys/" + strings.ReplaceAll(key, ".", "/") }

// sysctlFile renders the drop-in, keys sorted.
func sysctlFile(unit string, values map[string]string) []byte {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(generatedHeader(unit))
	for _, k := range keys {
		fmt.Fprintf(&b, "%s = %s\n", k, values[k])
	}
	return []byte(b.String())
}

// planSysctls writes file and sets each live value that differs.
func planSysctls(sys System, unit, file string, values map[string]string) ([]converge.Action, error) {
	actions, err := ensureFile(sys, file, sysctlFile(unit, values), 0o644)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var missing []string
	for _, key := range keys {
		want := values[key]
		have, ok, err := readTrim(sys, sysctlPath(key))
		if err != nil {
			return nil, err
		}
		if !ok {
			missing = append(missing, key)
			continue
		}
		if normalizeSysctl(have) == want {
			continue
		}
		p := sysctlPath(key)
		actions = append(actions, converge.Action{
			Description: fmt.Sprintf("set %s = %s", key, want),
			Apply:       func(context.Context) error { return sys.WriteKernel(p, want) },
		})
	}
	if len(missing) > 0 {
		// Retryable: the module that provides them may load later (net.bridge.* needs br_netfilter).
		return actions, fmt.Errorf("%s: this kernel has no %s (is the module that provides it loaded?)", unit, strings.Join(missing, ", "))
	}
	return actions, nil
}

func (s Sysctl) Plan(_ context.Context, sys System, settings json.RawMessage) ([]converge.Action, error) {
	values, err := parseSysctls(s.Name(), settings)
	if err != nil {
		return nil, err
	}
	if len(values) == 0 {
		return ensureAbsent(sys, SysctlFile)
	}
	actions, err := planSysctls(sys, s.Name(), SysctlFile, values)
	if err != nil {
		// Apply what can be applied now, then report the rest.
		return append(actions, fail(err)), nil
	}
	return actions, nil
}

func (Sysctl) Clean(_ context.Context, sys System) ([]converge.Action, error) {
	return ensureAbsent(sys, SysctlFile)
}

// fail is a step that fails with err (after the steps before it applied).
func fail(err error) converge.Action {
	return converge.Action{Description: "check", Apply: func(context.Context) error { return err }}
}

// KernelModules is the `kernel-modules` unit: modules loaded now and at every boot
// (/etc/modules-load.d/bcd.conf) and their options (/etc/modprobe.d/bcd.conf). A sandbox host
// loads kvm_intel or kvm_amd, vhost_net and tun this way.
type KernelModules struct{}

// Files the kernel-modules unit owns.
const (
	ModulesLoadFile = "/etc/modules-load.d/bcd.conf"
	ModprobeFile    = "/etc/modprobe.d/bcd.conf"
)

var (
	moduleName   = regexp.MustCompile(`^[a-z0-9_-]{1,64}$`)
	moduleOption = regexp.MustCompile(`^[A-Za-z0-9_.,:=/ -]{0,256}$`)
	optionName   = regexp.MustCompile(`^[A-Za-z0-9_]{1,64}$`)
)

type kernelModulesSettings struct {
	Load    []string          `json:"load"`
	Options map[string]string `json:"options"`
}

func (KernelModules) Name() string { return "kernel-modules" }

func parseKernelModules(unit string, settings json.RawMessage) (kernelModulesSettings, error) {
	var s kernelModulesSettings
	if err := decode(unit, settings, &s); err != nil {
		return s, err
	}
	if len(s.Load) > 64 || len(s.Options) > 64 {
		return s, converge.Terminal(fmt.Errorf("%s: at most 64 modules", unit))
	}
	for _, m := range s.Load {
		if !moduleName.MatchString(m) {
			return s, converge.Terminal(fmt.Errorf("%s: %q is not a module name", unit, m))
		}
	}
	for m, opts := range s.Options {
		if !moduleName.MatchString(m) || !moduleOption.MatchString(opts) {
			return s, converge.Terminal(fmt.Errorf("%s: options for %q are not module options", unit, m))
		}
		for _, kv := range strings.Fields(opts) {
			k, _, _ := strings.Cut(kv, "=")
			if !optionName.MatchString(k) {
				return s, converge.Terminal(fmt.Errorf("%s: %q is not a module option", unit, kv))
			}
		}
	}
	return s, nil
}

// sysModule is a module's /sys/module directory (the kernel uses underscores).
func sysModule(name string) string { return "/sys/module/" + strings.ReplaceAll(name, "-", "_") }

func moduleLoaded(sys System, name string) (bool, error) {
	_, err := sys.ReadDir(sysModule(name))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// sameParam compares a module parameter as /sys shows it (Y/N for booleans) with an option value.
func sameParam(have, want string) bool {
	norm := func(v string) string {
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "y", "1", "yes", "on", "true":
			return "1"
		case "n", "0", "no", "off", "false":
			return "0"
		}
		return strings.TrimSpace(v)
	}
	return norm(have) == norm(want)
}

func (k KernelModules) Plan(_ context.Context, sys System, settings json.RawMessage) ([]converge.Action, error) {
	s, err := parseKernelModules(k.Name(), settings)
	if err != nil {
		return nil, err
	}
	load := append([]string(nil), s.Load...)
	sort.Strings(load)
	var actions []converge.Action
	var loadFile strings.Builder
	loadFile.WriteString(generatedHeader(k.Name()))
	for _, m := range load {
		loadFile.WriteString(m + "\n")
	}
	step, err := ensureFile(sys, ModulesLoadFile, []byte(loadFile.String()), 0o644)
	if err != nil {
		return nil, err
	}
	actions = append(actions, step...)

	withOptions := make([]string, 0, len(s.Options))
	for m := range s.Options {
		withOptions = append(withOptions, m)
	}
	sort.Strings(withOptions)
	if len(withOptions) > 0 {
		var b strings.Builder
		b.WriteString(generatedHeader(k.Name()))
		for _, m := range withOptions {
			fmt.Fprintf(&b, "options %s %s\n", m, strings.Join(strings.Fields(s.Options[m]), " "))
		}
		step, err = ensureFile(sys, ModprobeFile, []byte(b.String()), 0o644)
	} else {
		step, err = ensureAbsent(sys, ModprobeFile)
	}
	if err != nil {
		return nil, err
	}
	actions = append(actions, step...)

	for _, m := range load {
		loaded, err := moduleLoaded(sys, m)
		if err != nil {
			return nil, err
		}
		if !loaded {
			actions = append(actions, run(sys, Cmd{Name: "modprobe", Args: []string{"--", m}}))
			continue
		}
		// Loaded with other options: reload it when nothing holds it; otherwise the options apply
		// when it next loads (a kvm module under running VMs is not pulled from under them).
		stale := false
		for _, kv := range strings.Fields(s.Options[m]) {
			key, want, _ := strings.Cut(kv, "=")
			have, ok, err := readTrim(sys, sysModule(m)+"/parameters/"+key)
			if err != nil {
				return nil, err
			}
			if ok && !sameParam(have, want) {
				stale = true
			}
		}
		if !stale {
			continue
		}
		if refs, ok, _ := readTrim(sys, sysModule(m)+"/refcnt"); ok && refs == "0" {
			actions = append(actions,
				run(sys, Cmd{Name: "modprobe", Args: []string{"-r", "--", m}}),
				run(sys, Cmd{Name: "modprobe", Args: []string{"--", m}}))
		}
	}
	return actions, nil
}

func (KernelModules) Clean(_ context.Context, sys System) ([]converge.Action, error) {
	a, err := ensureAbsent(sys, ModulesLoadFile)
	if err != nil {
		return nil, err
	}
	b, err := ensureAbsent(sys, ModprobeFile)
	if err != nil {
		return nil, err
	}
	return append(a, b...), nil
}
