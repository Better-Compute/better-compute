//go:build linux

package bcx

import (
	"context"
	"os"
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
	// The plugin runs from the hashed file, not its path: /proc/<pid>/exe is the binary it verified.
	link, err := os.Readlink("/proc/" + strconv.Itoa(sandboxed.cmd.Process.Pid) + "/exe")
	if err != nil || link != exe {
		t.Fatalf("the plugin runs %q (%v), not %q", link, err, exe)
	}
}
