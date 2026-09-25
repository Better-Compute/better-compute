//go:build linux

package bcx

import (
	"context"
	"os"
	goruntime "runtime"
	"strconv"
	"testing"

	driverv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1"
	"golang.org/x/sys/unix"
)

// probeDenied calls perf_event_open with no attributes: the kernel answers EFAULT, the seccomp filter
// EPERM.
func probeDenied() string {
	_, _, errno := unix.Syscall6(unix.SYS_PERF_EVENT_OPEN, 0, 0, ^uintptr(0), ^uintptr(0), 0, 0)
	return errno.Error()
}

// probeNamespaces tries to make a user namespace (in a throwaway thread: unshare applies to it).
func probeNamespaces() string {
	done := make(chan string)
	go func() {
		goruntime.LockOSThread() // never unlocked: the thread exits with the goroutine
		err := unix.Unshare(unix.CLONE_NEWUSER)
		if err == nil {
			done <- "created"
			return
		}
		done <- err.Error()
	}()
	return <-done
}

func TestOwnCgroup(t *testing.T) {
	got, err := ownCgroup("0::/system.slice/bcd.service\n")
	if err != nil || got != "/sys/fs/cgroup/system.slice/bcd.service" {
		t.Fatalf("own cgroup = %q, %v", got, err)
	}
	if _, err := ownCgroup("12:pids:/user.slice\n"); err == nil {
		t.Fatal("a cgroup v1 line was taken for v2")
	}
	if err := PrepareCgroup("/tmp/not-a-cgroup/plugins"); err == nil {
		t.Fatal("a directory outside the cgroup hierarchy was accepted")
	}
}

func TestSandboxedPlugin(t *testing.T) {
	exe, pin := selfPin(t)
	ctx := context.Background()
	start := func(o StartOptions) *Plugin {
		t.Helper()
		o.Sha256, o.Env, o.Stderr = pin, []string{"BCX_TEST_PLUGIN=1"}, os.Stderr
		p, err := Start(ctx, "echo", exe, o)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(p.Close)
		return p
	}
	probe := func(p *Plugin) string {
		t.Helper()
		out, err := p.Invoke(ctx, &driverv1.InvokeRequest{DriverId: "echo", Kind: "power", Operation: "probe"}, nil)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	// Unsandboxed, the kernel answers; through the shim, the filter does.
	if got := probe(start(StartOptions{})); got != `"`+unix.EFAULT.Error()+`"` {
		t.Fatalf("unsandboxed perf_event_open = %s", got)
	}
	sandboxed := start(StartOptions{Shim: exe})
	if got := probe(sandboxed); got != `"`+unix.EPERM.Error()+`"` {
		t.Fatalf("sandboxed perf_event_open = %s; want the seccomp filter's EPERM", got)
	}
	if err := sandboxed.Health(ctx); err != nil {
		t.Fatal(err)
	}
	// No namespaces: the way to root-in-a-namespace kernel surfaces (nf_tables, mounts).
	ns, err := sandboxed.Invoke(ctx, &driverv1.InvokeRequest{DriverId: "echo", Kind: "power", Operation: "probe-ns"}, nil)
	if err != nil || ns != `"`+unix.EPERM.Error()+`"` {
		t.Fatalf("sandboxed unshare(CLONE_NEWUSER) = %s, %v", ns, err)
	}
	// The plugin runs from the hashed file, not its path: /proc/<pid>/exe is the binary it verified.
	link, err := os.Readlink("/proc/" + strconv.Itoa(sandboxed.cmd.Process.Pid) + "/exe")
	if err != nil || link != exe {
		t.Fatalf("the plugin runs %q (%v), not %q", link, err, exe)
	}
}
