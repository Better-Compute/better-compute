//go:build linux

package hostconfig

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
)

// TestRealKernel runs units against this machine's kernel (as root, BCD_HOSTCONFIG_REAL=1): the
// formats FakeSystem imitates (/proc/sys, the THP selector, nr_hugepages) are the kernel's. Every
// value it changes is put back.
func TestRealKernel(t *testing.T) {
	if os.Getenv("BCD_HOSTCONFIG_REAL") != "1" || os.Geteuid() != 0 {
		t.Skip("BCD_HOSTCONFIG_REAL=1 as root")
	}
	ctx := context.Background()
	sys := &OSSystem{}
	apply := func(r *Registry, cfg ...Config) int {
		t.Helper()
		actions, err := r.Plan(ctx, sys, cfg)
		if err != nil {
			t.Fatal(err)
		}
		for _, a := range actions {
			if err := a.Apply(ctx); err != nil {
				t.Fatalf("%s: %v", a.Description, err)
			}
		}
		return len(actions)
	}

	// sysctl: a live value set and put back (the drop-in removed after).
	orig, _, err := readTrim(sys, "/proc/sys/vm/swappiness")
	if err != nil {
		t.Fatal(err)
	}
	other := "37"
	if orig == other {
		other = "38"
	}
	r := NewRegistry(Sysctl{})
	t.Cleanup(func() {
		_ = sys.WriteKernel("/proc/sys/vm/swappiness", orig)
		_ = sys.RemoveFile(SysctlFile)
	})
	if n := apply(r, Config{Unit: "sysctl", Settings: json.RawMessage(`{"vm.swappiness":` + other + `}`)}); n != 1 {
		t.Fatalf("sysctl actions = %d", n)
	}
	if v, _, _ := readTrim(sys, "/proc/sys/vm/swappiness"); v != other {
		t.Fatalf("swappiness = %s", v)
	}
	if n := apply(r, Config{Unit: "sysctl", Settings: json.RawMessage(`{"vm.swappiness":` + other + `}`)}); n != 0 {
		t.Fatalf("converged pass took %d actions", n)
	}
	// A multi-value tunable the kernel shows tab-separated converges on the first pass.
	ports, _, _ := readTrim(sys, "/proc/sys/net/ipv4/ip_local_port_range")
	spaced := strings.Join(strings.Fields(ports), " ")
	settings, _ := json.Marshal(map[string]any{"vm.swappiness": other, "net.ipv4.ip_local_port_range": spaced})
	apply(r, Config{Unit: "sysctl", Settings: settings})
	if n := apply(r, Config{Unit: "sysctl", Settings: settings}); n != 0 {
		t.Fatalf("port range did not converge: %d actions", n)
	}

	// Transparent huge pages: the selector format, set and put back.
	if thp, ok, _ := readTrim(sys, THPEnabled); ok {
		was := selected(thp)
		t.Cleanup(func() { _ = sys.WriteKernel(THPEnabled, was) })
		want := "madvise"
		if was == want {
			want = "never"
		}
		h := NewRegistry(Hugepages{})
		apply(h, Config{Unit: "hugepages", Settings: json.RawMessage(`{"transparent":"` + want + `"}`)})
		if now, _, _ := readTrim(sys, THPEnabled); selected(now) != want {
			t.Fatalf("thp = %q", now)
		}
	}

	// Root never writes under a directory someone else can write (/tmp included), or a symlink.
	if err := sys.WriteFile(t.TempDir()+"/state", []byte("1"), 0o644); err == nil {
		t.Fatal("root wrote under /tmp")
	}
	base := "/run/bcd-hostconfig-test-" + strconv.Itoa(os.Getpid())
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	open, owned := base+"/open", base+"/owned"
	for _, d := range []string{open, owned} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(open, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := sys.WriteFile(open+"/x/state", []byte("1"), 0o644); err == nil || !strings.Contains(err.Error(), "only root can write") {
		t.Fatalf("world-writable parent: %v", err)
	}
	if err := os.Symlink("/etc", owned+"/link"); err != nil {
		t.Fatal(err)
	}
	if err := sys.WriteFile(owned+"/link/bcd-test", []byte("1"), 0o644); err == nil {
		_ = os.Remove("/etc/bcd-test")
		t.Fatal("wrote through a symlink")
	}
	if err := sys.WriteFile(owned+"/ok/state", []byte("1"), 0o644); err != nil {
		t.Fatalf("root's own directory: %v", err)
	}

	// 2 MiB huge pages: two more, then back.
	if n, err := readCount(sys, Hugepages2MDir+"/nr_hugepages"); err == nil {
		t.Cleanup(func() { _ = sys.WriteKernel(Hugepages2MDir+"/nr_hugepages", strconv.FormatInt(n, 10)) })
		h := NewRegistry(Hugepages{})
		apply(h, Config{Unit: "hugepages", Settings: json.RawMessage(`{"pages2m":` + strconv.FormatInt(n+2, 10) + `}`)})
		if got, _ := readCount(sys, Hugepages2MDir+"/nr_hugepages"); got != n+2 {
			t.Fatalf("2M pages = %d, want %d", got, n+2)
		}
	}
}
