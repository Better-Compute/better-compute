package hostconfig

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// converge runs the registry's plan like the host converger: every action, stopping at the first
// error, which it returns.
func runAll(t *testing.T, r *Registry, sys System, configs ...Config) (int, error) {
	t.Helper()
	actions, err := r.Plan(context.Background(), sys, configs)
	if err != nil {
		return 0, err
	}
	units := 0 // the units applied; the last action only reports their failures
	for _, a := range actions {
		if err := a.Apply(context.Background()); err != nil {
			return units, fmt.Errorf("%s: %w", a.Description, err)
		}
		if a.Description != "host units" {
			units++
		}
	}
	return units, nil
}

func unit(name, settings string) Config {
	return Config{Unit: name, Settings: json.RawMessage(settings)}
}

func TestSysctlConvergesAndCleans(t *testing.T) {
	sys := NewFakeSystem()
	sys.Set("/proc/sys/vm/swappiness", "60\n")
	sys.Set("/proc/sys/net/ipv4/ip_local_port_range", "32768\t60999\n")
	r := NewRegistry(Sysctl{})
	cfg := unit("sysctl", `{"vm.swappiness":10,"net.ipv4.ip_local_port_range":"1024 65000"}`)

	if n, err := runAll(t, r, sys, cfg); err != nil || n != 1 {
		t.Fatalf("first pass: %d %v", n, err)
	}
	if v, _ := sys.Get("/proc/sys/vm/swappiness"); v != "10\n" {
		t.Fatalf("swappiness = %q", v)
	}
	file, _ := sys.Get(SysctlFile)
	if !strings.Contains(file, "net.ipv4.ip_local_port_range = 1024 65000\nvm.swappiness = 10\n") {
		t.Fatalf("drop-in:\n%s", file)
	}
	// The kernel shows it tab-separated: still converged.
	sys.Set("/proc/sys/net/ipv4/ip_local_port_range", "1024\t65000\n")
	if n, err := runAll(t, r, sys, cfg); err != nil || n != 0 {
		t.Fatalf("second pass: %d %v", n, err)
	}
	// Drift is corrected.
	sys.Set("/proc/sys/vm/swappiness", "60\n")
	if n, err := runAll(t, r, sys, cfg); err != nil || n != 1 {
		t.Fatalf("drift: %d %v", n, err)
	}
	// Dropped from the spec: the drop-in goes, live values stay.
	if _, err := runAll(t, r, sys); err != nil {
		t.Fatal(err)
	}
	if _, ok := sys.Get(SysctlFile); ok {
		t.Fatal("drop-in left behind")
	}
}

func TestSysctlRefusesAndWaits(t *testing.T) {
	sys := NewFakeSystem()
	r := NewRegistry(Sysctl{})
	_, err := runAll(t, r, sys, unit("sysctl", `{"vm.swappiness":{"x":1}}`))
	if !errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("object value: %v", err)
	}
	_, err = runAll(t, r, sys, unit("sysctl", `{"../../etc":1}`))
	if !errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("path key: %v", err)
	}
	// Keys that would give whoever writes the spec root, or lower the host's defenses.
	for _, key := range []string{"kernel.core_pattern", "kernel.modprobe", "kernel.usermodehelper.bset", "fs.binfmt_misc.register", "kernel.randomize_va_space", "user.max_user_namespaces", "fs.protected_symlinks"} {
		sys.Set(sysctlPath(key), "x\n")
		_, err = runAll(t, r, sys, unit("sysctl", `{"`+key+`":"|/tmp/x"}`))
		if !errors.Is(err, converge.ErrTerminal) || !strings.Contains(err.Error(), "refused") {
			t.Fatalf("%s: %v", key, err)
		}
		if v, _ := sys.Get(sysctlPath(key)); v != "x\n" {
			t.Fatalf("%s written", key)
		}
	}
	// A key the kernel does not have yet (its module is not loaded) is retried, not terminal.
	_, err = runAll(t, r, sys, unit("sysctl", `{"net.bridge.bridge-nf-call-iptables":1}`))
	if err == nil || errors.Is(err, converge.ErrTerminal) || !strings.Contains(err.Error(), "net.bridge.bridge-nf-call-iptables") {
		t.Fatalf("missing key: %v", err)
	}
}

func TestKernelModulesThenSysctl(t *testing.T) {
	sys := NewFakeSystem()
	// modprobe br_netfilter makes the sysctl appear: the sysctl unit, planned after it, converges
	// in the same pass.
	sys.Handler = func(_ context.Context, c Cmd) ([]byte, error) {
		if c.Name == "modprobe" && slices.Contains(c.Args, "br_netfilter") {
			sys.Set("/sys/module/br_netfilter/refcnt", "0\n")
			sys.Set("/proc/sys/net/bridge/bridge-nf-call-iptables", "0\n")
		}
		return nil, nil
	}
	sys.Set("/sys/module/kvm_intel/parameters/nested", "N\n")
	sys.Set("/sys/module/kvm_intel/refcnt", "0\n")
	r := NewRegistry(KernelModules{}, Sysctl{})
	_, err := runAll(t, r, sys,
		unit("kernel-modules", `{"load":["br_netfilter","kvm_intel"],"options":{"kvm_intel":"nested=1"}}`),
		unit("sysctl", `{"net.bridge.bridge-nf-call-iptables":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := sys.Get("/proc/sys/net/bridge/bridge-nf-call-iptables"); v != "1\n" {
		t.Fatalf("sysctl = %q", v)
	}
	want := []string{"modprobe -- br_netfilter", "modprobe -r -- kvm_intel", "modprobe -- kvm_intel"}
	if got := sys.Commands(); !slices.Equal(got, want) {
		t.Fatalf("commands %q, want %q", got, want)
	}
	if f, _ := sys.Get(ModprobeFile); !strings.Contains(f, "options kvm_intel nested=1\n") {
		t.Fatalf("modprobe.d:\n%s", f)
	}
	if f, _ := sys.Get(ModulesLoadFile); !strings.HasSuffix(f, "br_netfilter\nkvm_intel\n") {
		t.Fatalf("modules-load.d:\n%s", f)
	}
	// In use (VMs running): the option waits for the next load instead of pulling the module.
	sys.Ran = nil
	sys.Set("/sys/module/kvm_intel/refcnt", "3\n")
	if _, err := runAll(t, r, sys, unit("kernel-modules", `{"load":["br_netfilter","kvm_intel"],"options":{"kvm_intel":"nested=1"}}`)); err != nil {
		t.Fatal(err)
	}
	if len(sys.Ran) != 0 {
		t.Fatalf("reloaded a module in use: %q", sys.Commands())
	}
	_, err = runAll(t, r, sys, unit("kernel-modules", `{"load":["kvm; rm -rf /"]}`))
	if !errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("bad name: %v", err)
	}
}

func TestRegistryUnknownAndTerminalDoNotBlockOthers(t *testing.T) {
	sys := NewFakeSystem()
	sys.Set("/proc/sys/vm/swappiness", "60\n")
	r := NewRegistry(KernelModules{}, Sysctl{})
	_, err := runAll(t, r, sys,
		unit("kernel-modules", `{"load":["x"],"bogus":true}`),
		unit("slurm-join", `{}`),
		unit("sysctl", `{"vm.swappiness":1}`))
	if !errors.Is(err, converge.ErrTerminal) || !strings.Contains(err.Error(), "slurm-join") || !strings.Contains(err.Error(), "kernel-modules") {
		t.Fatalf("err = %v", err)
	}
	if v, _ := sys.Get("/proc/sys/vm/swappiness"); v != "1\n" {
		t.Fatal("sysctl held back by another unit's failure")
	}
	if _, err := r.Plan(context.Background(), sys, []Config{unit("sysctl", `{}`), unit("sysctl", `{}`)}); !errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("duplicate: %v", err)
	}
}

func hugepageHost() *FakeSystem {
	sys := NewFakeSystem()
	sys.Set(Hugepages2MDir+"/nr_hugepages", "0\n")
	sys.Set(Hugepages1GDir+"/nr_hugepages", "0\n")
	sys.Set(THPEnabled, "[always] madvise never\n")
	sys.Set("/proc/mounts", "hugetlbfs /dev/hugepages hugetlbfs rw,relatime,pagesize=2M 0 0\n")
	return sys
}

func TestAUnitWaitingForARebootDoesNotHoldBackTheRest(t *testing.T) {
	sys := hugepageHost()
	sys.Set("/proc/mounts", "hugetlbfs /dev/hugepages1G hugetlbfs rw,pagesize=1024M 0 0\n")
	sys.Programs["update-grub"] = true
	sys.Set("/proc/sys/vm/swappiness", "60\n")
	short := &shortKernel{FakeSystem: sys, keep: Hugepages1GDir + "/nr_hugepages"}
	var observed []string
	r := NewRegistry(Hugepages{}, Sysctl{})
	r.Observe = func(unit string, err error) { observed = append(observed, fmt.Sprintf("%s:%v", unit, err != nil)) }
	_, err := runAll(t, r, short, unit("hugepages", `{"pages1g":2}`), unit("sysctl", `{"vm.swappiness":5}`))
	if !IsRebootRequired(err) || errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("err = %v", err)
	}
	if v, _ := sys.Get("/proc/sys/vm/swappiness"); v != "5\n" {
		t.Fatal("the sysctl after a unit waiting for a reboot was held back")
	}
	if !slices.Equal(observed, []string{"hugepages:true", "sysctl:false"}) {
		t.Fatalf("observed %q", observed)
	}
	// A terminal failure next to a retryable one: the section retries.
	_, err = runAll(t, r, short, unit("hugepages", `{"pages1g":2}`), unit("sysctl", `{"vm.swappiness":{"x":1}}`))
	if err == nil || errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("mixed: %v", err)
	}
}

func TestHugepages(t *testing.T) {
	sys := hugepageHost()
	r := NewRegistry(Hugepages{})
	cfg := unit("hugepages", `{"pages2m":1024,"pages1g":4,"transparent":"madvise"}`)
	if _, err := runAll(t, r, sys, cfg); err != nil {
		t.Fatal(err)
	}
	if v, _ := sys.Get(Hugepages2MDir + "/nr_hugepages"); v != "1024\n" {
		t.Fatalf("2M = %q", v)
	}
	if v, _ := sys.Get(THPEnabled); v != "madvise\n" {
		t.Fatalf("thp = %q", v)
	}
	want := []string{"mkdir -p /dev/hugepages1G", "mount -t hugetlbfs -o pagesize=1G hugetlbfs /dev/hugepages1G"}
	if got := sys.Commands(); !slices.Equal(got, want) {
		t.Fatalf("commands %q", got)
	}
	sys.Set(THPEnabled, "always [madvise] never\n")
	sys.Set("/proc/mounts", "hugetlbfs /dev/hugepages1G hugetlbfs rw,relatime,pagesize=1024M 0 0\n")
	if n, err := runAll(t, r, sys, cfg); err != nil || n != 0 {
		t.Fatalf("converged pass: %d %v", n, err)
	}
}

func TestHugepages1GFallsBackToTheBootLoader(t *testing.T) {
	sys := hugepageHost()
	sys.Set("/proc/mounts", "hugetlbfs /dev/hugepages1G hugetlbfs rw,pagesize=1024M 0 0\n")
	sys.Programs["update-grub"] = true
	// The kernel finds no contiguous gigabytes: the write "succeeds" and nothing is allocated.
	sys2 := &shortKernel{FakeSystem: sys, keep: Hugepages1GDir + "/nr_hugepages"}
	r := NewRegistry(Hugepages{})
	_, err := runAll(t, r, sys2, unit("hugepages", `{"pages1g":8}`))
	if err == nil || errors.Is(err, converge.ErrTerminal) || !strings.Contains(err.Error(), "reboot the node") {
		t.Fatalf("err = %v", err)
	}
	cfg, _ := sys.Get(GrubHugepagesFile)
	if !strings.Contains(cfg, `GRUB_CMDLINE_LINUX="$GRUB_CMDLINE_LINUX hugepagesz=1G hugepages=8"`) {
		t.Fatalf("grub drop-in:\n%s", cfg)
	}
	if got := sys.Commands(); !slices.Equal(got, []string{"update-grub"}) {
		t.Fatalf("commands %q", got)
	}
	// Next pass: the boot loader is already set; only the runtime retry (and its error) remain.
	sys.Ran = nil
	if _, err := runAll(t, r, sys2, unit("hugepages", `{"pages1g":8}`)); err == nil {
		t.Fatal("still short, want an error")
	}
	if len(sys.Ran) != 0 {
		t.Fatalf("boot loader rewritten: %q", sys.Commands())
	}
	// Back to 0: the drop-in goes.
	if _, err := runAll(t, r, sys2, unit("hugepages", `{"pages1g":0}`)); err != nil {
		t.Fatal(err)
	}
	if _, ok := sys.Get(GrubHugepagesFile); ok {
		t.Fatal("drop-in left")
	}
}

// shortKernel ignores writes to one tunable (the kernel could not allocate).
type shortKernel struct {
	*FakeSystem
	keep string
}

func (s *shortKernel) WriteKernel(abs, value string) error {
	if abs == s.keep {
		return nil
	}
	return s.FakeSystem.WriteKernel(abs, value)
}

func gpuHost(driver string) *FakeSystem {
	sys := NewFakeSystem()
	sys.Set("/etc/os-release", "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID=\"24.04\"\n")
	if driver != "" {
		sys.Set(NvidiaModuleVersion, driver+"\n")
		sys.Set(NvidiaProcVersion, "NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  "+driver+"  Release Build\n")
	}
	return sys
}

func TestNvidiaDriverInstallsAndLoads(t *testing.T) {
	sys := gpuHost("")
	sys.Handler = func(_ context.Context, c Cmd) ([]byte, error) {
		switch {
		case c.Name == "modinfo":
			return nil, errors.New("modinfo: ERROR: Module nvidia not found.")
		case c.Name == "modprobe" && slices.Equal(c.Args, []string{"nvidia"}):
			sys.Set(NvidiaModuleVersion, "570.86.15\n")
			sys.Set(NvidiaProcVersion, "NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  570.86.15\n")
		}
		return nil, nil
	}
	r := NewRegistry(NvidiaDriver{})
	if _, err := runAll(t, r, sys, unit("nvidia-driver", `{"branch":"570","open":true}`)); err != nil {
		t.Fatal(err)
	}
	cmds := strings.Join(sys.Commands(), "\n")
	for _, want := range []string{
		"apt-get -q update",
		"apt-get -q -y --no-install-recommends -o Dpkg::Options::=--force-confold install nvidia-headless-570-server-open nvidia-utils-570-server",
		"modprobe nvidia\nmodprobe nvidia_uvm",
	} {
		if !strings.Contains(cmds, want) {
			t.Fatalf("missing %q in\n%s", want, cmds)
		}
	}
	for _, c := range sys.Ran {
		if c.Name == "apt-get" && !slices.Contains(c.Env, "DEBIAN_FRONTEND=noninteractive") {
			t.Fatal("apt-get without DEBIAN_FRONTEND")
		}
	}
	// Converged: nothing runs but the persistenced check (not installed here).
	sys.Ran = nil
	if n, err := runAll(t, r, sys, unit("nvidia-driver", `{"branch":"570","open":true}`)); err != nil || n != 0 {
		t.Fatalf("converged: %d %v %q", n, err, sys.Commands())
	}
	// The proprietary flavor asked for: open is loaded, so it is not converged.
	actions, _ := r.Plan(context.Background(), sys, []Config{unit("nvidia-driver", `{"branch":"570","open":false}`)})
	if len(actions) == 0 {
		t.Fatal("flavor mismatch converged")
	}
	if _, err := runAll(t, r, sys, unit("nvidia-driver", `{"branch":"57"}`)); !errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("bad branch: %v", err)
	}
}

func TestNvidiaDriverInUseAsksForReboot(t *testing.T) {
	sys := gpuHost("550.54.15")
	sys.Handler = func(_ context.Context, c Cmd) ([]byte, error) {
		switch {
		case c.Name == "modinfo" && slices.Contains(c.Args, "version"):
			return []byte("570.86.15\n"), nil
		case c.Name == "modinfo":
			return []byte("Dual MIT/GPL\n"), nil
		case c.Name == "modprobe" && c.Args[0] == "-r":
			return nil, errors.New("modprobe: FATAL: Module nvidia is in use.")
		}
		return nil, nil
	}
	_, err := runAll(t, NewRegistry(NvidiaDriver{}), sys, unit("nvidia-driver", `{"branch":"570"}`))
	if err == nil || errors.Is(err, converge.ErrTerminal) || !strings.Contains(err.Error(), "reboot the node") {
		t.Fatalf("err = %v", err)
	}
	for _, c := range sys.Commands() {
		if strings.HasPrefix(c, "apt-get") {
			t.Fatal("reinstalled an installed branch")
		}
	}
}

func TestContainerToolkitCDI(t *testing.T) {
	sys := gpuHost("570.86.15")
	sys.Programs["nvidia-ctk"] = true
	sys.Programs["containerd"] = true
	sys.Set("/etc/containerd/config.toml", "version = 2\n")
	gpus := "GPU 0: NVIDIA H100 80GB HBM3 (UUID: GPU-aaaa)\n"
	sys.Handler = func(_ context.Context, c Cmd) ([]byte, error) {
		switch {
		case c.Name == "nvidia-smi":
			return []byte(gpus), nil
		case c.Name == "nvidia-ctk" && c.Args[0] == "cdi":
			return []byte("cdiVersion: 0.5.0\nkind: nvidia.com/gpu\n"), nil
		case c.Name == "nvidia-ctk" && c.Args[0] == "runtime":
			sys.Set("/etc/containerd/config.toml", "version = 2\n# nvidia-container-runtime\n")
		}
		return nil, nil
	}
	r := NewRegistry(ContainerToolkit{})
	if _, err := runAll(t, r, sys, unit("container-toolkit", `{"cdi":true}`)); err != nil {
		t.Fatal(err)
	}
	if spec, _ := sys.Get(CDISpecFile); !strings.Contains(spec, "nvidia.com/gpu") {
		t.Fatalf("spec = %q", spec)
	}
	cmds := strings.Join(sys.Commands(), "\n")
	if !strings.Contains(cmds, "nvidia-ctk runtime configure --runtime=containerd --cdi.enabled\nsystemctl restart containerd") {
		t.Fatalf("commands:\n%s", cmds)
	}
	if n, err := runAll(t, r, sys, unit("container-toolkit", `{}`)); err != nil || n != 0 {
		t.Fatalf("converged: %d %v", n, err)
	}
	// A MIG layout change shows new devices: the spec is regenerated.
	gpus += "  MIG 3g.40gb Device 0: (UUID: MIG-bbbb)\n"
	if n, err := runAll(t, r, sys, unit("container-toolkit", `{}`)); err != nil || n != 1 {
		t.Fatalf("regenerate: %d %v", n, err)
	}
}

func TestFabricManagerOnlyWithNVSwitches(t *testing.T) {
	sys := gpuHost("570.86.15")
	r := NewRegistry(FabricManager{})
	if n, err := runAll(t, r, sys, unit("fabric-manager", `{}`)); err != nil || n != 0 {
		t.Fatalf("no NVSwitch: %d %v", n, err)
	}
	sys.Set(NVSwitchDevices+"/0000:05:00.0/information", "x")
	if _, err := runAll(t, r, sys, unit("fabric-manager", `{}`)); err != nil {
		t.Fatal(err)
	}
	cmds := strings.Join(sys.Commands(), "\n")
	if !strings.Contains(cmds, "install nvidia-fabricmanager-570") || !strings.Contains(cmds, "systemctl enable --now nvidia-fabricmanager") {
		t.Fatalf("commands:\n%s", cmds)
	}
}

func TestParseLayout(t *testing.T) {
	for in, want := range map[string]Layout{
		"all-disabled":            {Disabled: true},
		"all-1g.10gb":             {Fill: "1g.10gb"},
		"mixed:3g.40gb+2x2g.20gb": {Profiles: []string{"2g.20gb", "2g.20gb", "3g.40gb"}},
	} {
		got, err := ParseLayout(in)
		if err != nil || got.Disabled != want.Disabled || got.Fill != want.Fill || !slices.Equal(got.Profiles, want.Profiles) {
			t.Fatalf("%s: %+v %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "all-", "all-1g.10gb+me", "mixed:", "mixed:9x1g.10gb", "mixed:1g.10gb;reboot", "some"} {
		if _, err := ParseLayout(bad); err == nil {
			t.Fatalf("%q parsed", bad)
		}
	}
}

// fakeMIG answers nvidia-smi for GPUs with MIG state.
type fakeMIG struct {
	mode      map[string]string // index → Enabled/Disabled
	pending   map[string]string
	instances map[string][]string
}

func (m *fakeMIG) handle(_ context.Context, c Cmd) ([]byte, error) {
	a := c.Args
	switch {
	case len(a) > 0 && strings.HasPrefix(a[0], "--query-gpu"):
		var b strings.Builder
		for _, i := range []string{"0", "1"} {
			fmt.Fprintf(&b, "%s, GPU-%s, %s, %s\n", i, i, m.mode[i], m.pending[i])
		}
		return []byte(b.String()), nil
	case len(a) == 4 && a[0] == "-i" && a[2] == "-mig":
		want := map[string]string{"1": "Enabled", "0": "Disabled"}[a[3]]
		m.pending[a[1]] = want
		return nil, nil
	case len(a) == 3 && a[0] == "--gpu-reset":
		m.mode[a[2]] = m.pending[a[2]]
		return nil, nil
	case a[0] == "mig" && a[3] == "-lgip":
		return []byte("| GPU  Name  ID  Instances Free/Total  Memory GiB |\n|   0  MIG 1g.10gb   19     7/7        9.75       No     14     0     0   |\n|   0  MIG 3g.40gb    9     2/2       39.25       No     42     2     0   |\n"), nil
	case a[0] == "mig" && a[3] == "-lgi":
		if len(m.instances[a[2]]) == 0 {
			return nil, errors.New("No GPU instances found: Not Found")
		}
		var b strings.Builder
		for n, p := range m.instances[a[2]] {
			fmt.Fprintf(&b, "|   %s  MIG %s          19        %d          %d:1     |\n", a[2], p, n+1, n)
		}
		return []byte(b.String()), nil
	case a[0] == "mig" && a[3] == "-dgi":
		m.instances[a[2]] = nil
		return nil, nil
	case a[0] == "mig" && a[3] == "-dci":
		return nil, nil
	case a[0] == "mig" && a[3] == "-cgi":
		m.instances[a[2]] = strings.Split(a[4], ",")
		return nil, nil
	}
	return nil, fmt.Errorf("unexpected nvidia-smi %q", a)
}

func TestMigLayout(t *testing.T) {
	sys := NewFakeSystem()
	m := &fakeMIG{
		mode:      map[string]string{"0": "Disabled", "1": "Enabled"},
		pending:   map[string]string{"0": "Disabled", "1": "Enabled"},
		instances: map[string][]string{"1": {"1g.10gb"}},
	}
	sys.Handler = m.handle
	busy := map[string]bool{}
	r := NewRegistry(MigLayout{Busy: func(uuid string) bool { return busy[uuid] }})
	cfg := unit("mig-layout", `{"from":"pool","layout":"all-1g.10gb"}`)
	if _, err := runAll(t, r, sys, cfg); err != nil {
		t.Fatal(err)
	}
	for _, i := range []string{"0", "1"} {
		if m.mode[i] != "Enabled" || len(m.instances[i]) != 7 {
			t.Fatalf("GPU %s: %s %v", i, m.mode[i], m.instances[i])
		}
	}
	if n, err := runAll(t, r, sys, cfg); err != nil || n != 0 {
		t.Fatalf("converged: %d %v", n, err)
	}
	// Mixed, largest first; a busy GPU waits and the section says so.
	busy["GPU-1"] = true
	_, err := runAll(t, r, sys, unit("mig-layout", `{"from":"profile","layout":"mixed:2x1g.10gb+3g.40gb"}`))
	if err == nil || !strings.Contains(err.Error(), "GPU-1") {
		t.Fatalf("busy: %v", err)
	}
	if got := strings.Join(m.instances["0"], ","); got != "3g.40gb,1g.10gb,1g.10gb" {
		t.Fatalf("GPU 0 = %s", got)
	}
	if len(m.instances["1"]) != 7 {
		t.Fatal("busy GPU repartitioned")
	}
	busy["GPU-1"] = false
	if _, err := runAll(t, r, sys, unit("mig-layout", `{"layout":"all-disabled"}`)); err != nil {
		t.Fatal(err)
	}
	if m.mode["0"] != "Disabled" || len(m.instances["0"]) != 0 {
		t.Fatalf("disabled: %s %v", m.mode["0"], m.instances["0"])
	}
}

func TestHugepagesPerNuma(t *testing.T) {
	sys := hugepageHost()
	for _, n := range []string{"node0", "node1"} {
		sys.Set(NodeDir+"/"+n+"/hugepages/hugepages-2048kB/nr_hugepages", "0\n")
		sys.Set(NodeDir+"/"+n+"/hugepages/hugepages-1048576kB/nr_hugepages", "0\n")
	}
	sys.Set(NodeDir+"/possible", "0-1\n")
	sys.Set("/proc/mounts", "hugetlbfs /dev/hugepages1G hugetlbfs rw,pagesize=1024M 0 0\n")
	sys.Programs["grubby"] = true
	short := &shortKernel{FakeSystem: sys, keep: NodeDir + "/node1/hugepages/hugepages-1048576kB/nr_hugepages"}
	_, err := runAll(t, NewRegistry(Hugepages{}), short, unit("hugepages", `{"pages2m":512,"pages1g":2,"perNuma":true}`))
	if err == nil || !strings.Contains(err.Error(), "1 GiB on node1") {
		t.Fatalf("err = %v", err)
	}
	for _, n := range []string{"node0", "node1"} {
		if v, _ := sys.Get(NodeDir + "/" + n + "/hugepages/hugepages-2048kB/nr_hugepages"); v != "512\n" {
			t.Fatalf("%s 2M = %q", n, v)
		}
	}
	if v, _ := sys.Get(NodeDir + "/node0/hugepages/hugepages-1048576kB/nr_hugepages"); v != "2\n" {
		t.Fatalf("node0 1G = %q", v)
	}
	// The boot loader reserves the host total.
	if got := sys.Commands(); !slices.Equal(got, []string{"grubby --update-kernel=ALL --args=hugepagesz=1G hugepages=4"}) {
		t.Fatalf("commands %q", got)
	}
}

func TestGPUSharing(t *testing.T) {
	sys := gpuHost("570.86.15")
	sys.Programs["nvidia-cuda-mps-control"] = true
	active := false
	sys.Handler = func(_ context.Context, c Cmd) ([]byte, error) {
		if c.Name == "systemctl" && c.Args[0] == "is-active" {
			if active {
				return []byte("active\n"), nil
			}
			return []byte("inactive\n"), errors.New("exit status 3")
		}
		return nil, nil
	}
	r := Builtin(Options{})
	cfg := unit("gpu-sharing", `{"mode":"mps","replicas":4}`)
	if conds := r.Conditions(context.Background(), sys, []Config{cfg}); len(conds) != 1 || conds[0].Type != "MPSDown" {
		t.Fatalf("conditions %+v", conds)
	}
	if _, err := runAll(t, r, sys, cfg); err != nil {
		t.Fatal(err)
	}
	file, _ := sys.Get(MPSUnitFile)
	if !strings.Contains(file, "set_default_active_thread_percentage 25 |") || !strings.Contains(file, "CUDA_MPS_PIPE_DIRECTORY=/run/nvidia-mps") {
		t.Fatalf("unit:\n%s", file)
	}
	if got := strings.Join(sys.Commands(), "\n"); !strings.Contains(got, "systemctl restart bcd-mps.service") {
		t.Fatalf("commands:\n%s", got)
	}
	active = true
	if n, err := runAll(t, r, sys, cfg); err != nil || n != 0 {
		t.Fatalf("converged: %d %v", n, err)
	}
	if conds := r.Conditions(context.Background(), sys, []Config{cfg}); len(conds) != 0 {
		t.Fatalf("conditions %+v", conds)
	}
	// Timeslice (or the unit gone): MPS is stopped and its unit removed.
	sys.Ran = nil
	if _, err := runAll(t, r, sys, unit("gpu-sharing", `{"mode":"timeslice","replicas":4}`)); err != nil {
		t.Fatal(err)
	}
	if _, ok := sys.Get(MPSUnitFile); ok {
		t.Fatal("MPS unit left")
	}
	if got := sys.Commands(); !slices.Contains(got, "systemctl disable --now bcd-mps.service") {
		t.Fatalf("commands %q", got)
	}
	if _, err := runAll(t, r, sys, unit("gpu-sharing", `{"mode":"exclusive"}`)); !errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("mode: %v", err)
	}
}

func TestFabricManagerDownCondition(t *testing.T) {
	sys := gpuHost("570.86.15")
	r := Builtin(Options{})
	cfg := []Config{unit("fabric-manager", `{}`)}
	if conds := r.Conditions(context.Background(), sys, cfg); len(conds) != 0 {
		t.Fatalf("no NVSwitch: %+v", conds)
	}
	sys.Set(NVSwitchDevices+"/0000:05:00.0/information", "x")
	if conds := r.Conditions(context.Background(), sys, cfg); len(conds) != 1 || conds[0].Type != "FabricManagerDown" {
		t.Fatalf("conditions %+v", conds)
	}
}

func TestCPUList(t *testing.T) {
	cpus, err := ParseCPUList("8-11,4,5,10")
	if err != nil || FormatCPUList(cpus) != "4-5,8-11" {
		t.Fatalf("%v %v", cpus, err)
	}
	for _, bad := range []string{"4-2", "a", "1,,2", "0-9000", "4 - 5"} {
		if _, err := ParseCPUList(bad); err == nil {
			t.Fatalf("%q parsed", bad)
		}
	}
}

func cpuHost(n int, governor string) *FakeSystem {
	sys := NewFakeSystem()
	for i := range n {
		dir := fmt.Sprintf("%s/cpu%d/cpufreq", CPUDir, i)
		sys.Set(dir+"/scaling_governor", governor+"\n")
		sys.Set(dir+"/scaling_available_governors", "performance powersave\n")
	}
	sys.Set(CPUDir+"/online", fmt.Sprintf("0-%d\n", n-1))
	sys.Set(CPUIsolated, "\n")
	return sys
}

func TestCPUGovernorAndIsolation(t *testing.T) {
	sys := cpuHost(8, "powersave")
	sys.Programs["update-grub"] = true
	r := Builtin(Options{})
	cfg := unit("cpu", `{"governor":"performance","isolate":"4-7"}`)
	_, err := runAll(t, r, sys, cfg)
	if err == nil || errors.Is(err, converge.ErrTerminal) || !strings.Contains(err.Error(), "reboot the node") {
		t.Fatalf("err = %v", err)
	}
	for i := range 8 {
		if v, _ := sys.Get(fmt.Sprintf("%s/cpu%d/cpufreq/scaling_governor", CPUDir, i)); v != "performance\n" {
			t.Fatalf("cpu%d governor %q", i, v)
		}
	}
	if f, _ := sys.Get("/etc/default/grub.d/90-bcd-cpu.cfg"); !strings.Contains(f, "isolcpus=managed_irq,domain,4-7 nohz_full=4-7 rcu_nocbs=4-7") {
		t.Fatalf("drop-in:\n%s", f)
	}
	if got := sys.Commands(); !slices.Equal(got, []string{"update-grub"}) {
		t.Fatalf("commands %q", got)
	}
	// After the reboot the kernel shows them isolated: converged, nothing rewritten.
	sys.Ran = nil
	sys.Set(CPUIsolated, "4-7\n")
	if n, err := runAll(t, r, sys, cfg); err != nil || n != 0 {
		t.Fatalf("converged: %d %v", n, err)
	}
	// Dropped from the spec: the arguments go.
	if _, err := runAll(t, r, sys); err != nil {
		t.Fatal(err)
	}
	if _, ok := sys.Get("/etc/default/grub.d/90-bcd-cpu.cfg"); ok {
		t.Fatal("drop-in left")
	}
	for _, bad := range []string{`{"isolate":"0-3"}`, `{"governor":"turbo"}`, `{"isolate":"x"}`} {
		if _, err := runAll(t, r, sys, unit("cpu", bad)); !errors.Is(err, converge.ErrTerminal) {
			t.Fatalf("%s: %v", bad, err)
		}
	}
	// A governor the driver does not offer is terminal; a VM without cpufreq has nothing to set.
	if _, err := runAll(t, r, sys, unit("cpu", `{"governor":"schedutil"}`)); !errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("schedutil: %v", err)
	}
	vm := NewFakeSystem()
	vm.Set(CPUDir+"/cpu0/online", "1\n")
	if n, err := runAll(t, r, vm, unit("cpu", `{"governor":"performance"}`)); err != nil || n != 0 {
		t.Fatalf("vm: %d %v", n, err)
	}
}

func TestIOMMU(t *testing.T) {
	sys := NewFakeSystem()
	sys.Set("/proc/cpuinfo", "processor\t: 0\nvendor_id\t: AuthenticAMD\n")
	sys.Programs["grubby"] = true
	r := Builtin(Options{})
	_, err := runAll(t, r, sys, unit("iommu", `{}`))
	if err == nil || errors.Is(err, converge.ErrTerminal) || !strings.Contains(err.Error(), "reboot the node") {
		t.Fatalf("err = %v", err)
	}
	if got := sys.Commands(); !slices.Equal(got, []string{"grubby --update-kernel=ALL --args=amd_iommu=on iommu=pt"}) {
		t.Fatalf("commands %q", got)
	}
	// Booted with it: converged. Passthrough off replaces the arguments.
	sys.Ran = nil
	sys.Set(IOMMUClass+"/ivhd0/type", "x")
	if n, err := runAll(t, r, sys, unit("iommu", `{}`)); err != nil || n != 0 {
		t.Fatalf("converged: %d %v", n, err)
	}
	if _, err := runAll(t, r, sys, unit("iommu", `{"passthrough":false}`)); err != nil {
		t.Fatal(err)
	}
	if got := sys.Commands(); !slices.Equal(got, []string{
		"grubby --update-kernel=ALL --remove-args=amd_iommu=on iommu=pt",
		"grubby --update-kernel=ALL --args=amd_iommu=on",
	}) {
		t.Fatalf("commands %q", got)
	}
	sys.Set("/proc/cpuinfo", "vendor_id\t: SomethingElse\n")
	if _, err := runAll(t, r, sys, unit("iommu", `{}`)); !errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("unknown vendor: %v", err)
	}
}

func TestGPUSettings(t *testing.T) {
	sys := gpuHost("570.86.15")
	limits := map[string]string{"0": "700.00", "1": "650.00"}
	ecc := map[string][2]string{"0": {"Enabled", "Enabled"}, "1": {"Enabled", "Enabled"}}
	sys.Handler = func(_ context.Context, c Cmd) ([]byte, error) {
		if c.Name != "nvidia-smi" {
			return nil, nil
		}
		switch {
		case strings.HasPrefix(c.Args[0], "--query-gpu"):
			var b strings.Builder
			for _, i := range []string{"0", "1"} {
				fmt.Fprintf(&b, "%s, %s, 200.00, 700.00, %s, %s\n", i, limits[i], ecc[i][0], ecc[i][1])
			}
			return []byte(b.String()), nil
		case c.Args[2] == "-pl":
			limits[c.Args[1]] = c.Args[3] + ".00"
		case c.Args[2] == "-e":
			e := ecc[c.Args[1]]
			e[1] = map[string]string{"1": "Enabled", "0": "Disabled"}[c.Args[3]]
			ecc[c.Args[1]] = e
		}
		return nil, nil
	}
	r := Builtin(Options{})
	if _, err := runAll(t, r, sys, unit("gpu-settings", `{"powerLimitWatts":650}`)); err != nil {
		t.Fatal(err)
	}
	if got := sys.Commands(); !slices.Contains(got, "nvidia-smi -i 0 -pl 650") || slices.Contains(got, "nvidia-smi -i 1 -pl 650") {
		t.Fatalf("commands %q", got)
	}
	if n, err := runAll(t, r, sys, unit("gpu-settings", `{"powerLimitWatts":650}`)); err != nil || n != 0 {
		t.Fatalf("converged: %d %v", n, err)
	}
	if _, err := runAll(t, r, sys, unit("gpu-settings", `{"powerLimitWatts":900}`)); !errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("out of range: %v", err)
	}
	// ECC off: set pending on both, then a reboot is due; once pending, it is not set again.
	eccSets := func() int {
		n := 0
		for _, c := range sys.Commands() {
			if strings.Contains(c, " -e ") {
				n++
			}
		}
		return n
	}
	sys.Ran = nil
	_, err := runAll(t, r, sys, unit("gpu-settings", `{"ecc":false}`))
	if err == nil || !strings.Contains(err.Error(), "reboot the node") || eccSets() != 2 {
		t.Fatalf("ecc: %v %q", err, sys.Commands())
	}
	sys.Ran = nil
	if _, err := runAll(t, r, sys, unit("gpu-settings", `{"ecc":false}`)); err == nil || eccSets() != 0 {
		t.Fatalf("pending ecc re-set: %v %q", err, sys.Commands())
	}
	ecc["0"], ecc["1"] = [2]string{"Disabled", "Disabled"}, [2]string{"Disabled", "Disabled"}
	if n, err := runAll(t, r, sys, unit("gpu-settings", `{"ecc":false}`)); err != nil || n != 0 {
		t.Fatalf("after reboot: %d %v", n, err)
	}
}

func TestOSRelease(t *testing.T) {
	sys := NewFakeSystem()
	sys.Set("/etc/os-release", "ID=\"rocky\"\nID_LIKE=\"rhel centos fedora\"\nVERSION_ID=\"9.4\"\n")
	o, err := ReadOSRelease(sys)
	if err != nil || o.Family() != FamilyRHEL || o.VersionID != "9.4" {
		t.Fatalf("%+v %v", o, err)
	}
	_, pkgs, _ := driverPackages(o, "570", true)
	if !slices.Equal(pkgs, []string{"@nvidia-driver:570-open"}) {
		t.Fatalf("pkgs %q", pkgs)
	}
}
