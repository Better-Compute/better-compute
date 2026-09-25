// Package health watches the node for the conditions of PLAN.md §10.1 that bcd reports in
// StatusReport: NVIDIA XID errors from the kernel log (as device conditions "Xid<n>", which the
// gateway's xidStatusHandler turns into health policy) and host pressure (PSI "some avg10" for CPU,
// memory and I/O, and CPU steal over the last interval).
package health

import (
	"bufio"
	"context"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// Pressure samples PSI and CPU steal under Root ("" is the real /proc).
type Pressure struct {
	Root string
	prev *cpuTimes
}

type cpuTimes struct{ total, steal uint64 }

func (p *Pressure) path(abs string) string {
	if p.Root == "" {
		return abs
	}
	return filepath.Join(p.Root, filepath.FromSlash(abs))
}

// Sample returns the current pressure, or nil when the kernel exposes no PSI. Steal is the share of
// CPU time stolen since the previous Sample (0 on the first).
func (p *Pressure) Sample() *agentv1.HostPressure {
	cpu, ok1 := p.some("/proc/pressure/cpu")
	mem, ok2 := p.some("/proc/pressure/memory")
	io, ok3 := p.some("/proc/pressure/io")
	if !ok1 && !ok2 && !ok3 {
		return nil
	}
	out := &agentv1.HostPressure{CpuSomeAvg10: cpu, MemorySomeAvg10: mem, IoSomeAvg10: io}
	if now, ok := p.cpu(); ok {
		if p.prev != nil && now.total > p.prev.total {
			out.StealPct = float32(float64(now.steal-p.prev.steal) * 100 / float64(now.total-p.prev.total))
		}
		p.prev = &now
	}
	return out
}

// some reads "some avg10=<v>" from a PSI file.
func (p *Pressure) some(abs string) (float32, bool) {
	b, err := os.ReadFile(p.path(abs))
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(line, "some ") {
			continue
		}
		for _, f := range strings.Fields(line) {
			if v, ok := strings.CutPrefix(f, "avg10="); ok {
				x, err := strconv.ParseFloat(v, 32)
				return float32(x), err == nil
			}
		}
	}
	return 0, false
}

// cpu reads the aggregate "cpu" line of /proc/stat: user nice system idle iowait irq softirq steal.
func (p *Pressure) cpu() (cpuTimes, bool) {
	b, err := os.ReadFile(p.path("/proc/stat"))
	if err != nil {
		return cpuTimes{}, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 9 || fields[0] != "cpu" {
			continue
		}
		var t cpuTimes
		for i, f := range fields[1:9] {
			v, _ := strconv.ParseUint(f, 10, 64)
			t.total += v
			if i == 7 {
				t.steal = v
			}
		}
		return t, true
	}
	return cpuTimes{}, false
}

// Xid is one NVIDIA XID event from the kernel log.
type Xid struct {
	// Bus is the PCI address as the driver prints it, normalized to NVML's form (00000000:18:00.0).
	Bus     string
	Code    int
	Message string
}

// "NVRM: Xid (PCI:0000:18:00): 79, pid=1234, name=python, GPU has fallen off the bus."
var xidLine = regexp.MustCompile(`NVRM: Xid \(PCI:([0-9A-Fa-f]{4,8}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2})(?:\.\d)?\): (\d+),\s*(.*)$`)

// ParseXid reads an XID from a kernel log line (a /dev/kmsg record or a dmesg line).
func ParseXid(line string) (Xid, bool) {
	m := xidLine.FindStringSubmatch(strings.TrimSpace(line))
	if m == nil {
		return Xid{}, false
	}
	code, err := strconv.Atoi(m[2])
	if err != nil {
		return Xid{}, false
	}
	domain, rest, _ := strings.Cut(strings.ToUpper(m[1]), ":")
	for len(domain) < 8 {
		domain = "0" + domain
	}
	return Xid{Bus: domain + ":" + rest + ".0", Code: code, Message: strings.TrimSpace(m[3])}, true
}

// WatchKmsg reads kernel log records from r (an open /dev/kmsg positioned at its end) until ctx is
// done or r fails, calling fn for each XID. /dev/kmsg records are "<prio>,<seq>,<usec>,<flags>;<text>".
func WatchKmsg(ctx context.Context, r io.Reader, fn func(Xid)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 8192), 1<<20)
	for sc.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		line := sc.Text()
		if _, text, ok := strings.Cut(line, ";"); ok {
			line = text
		}
		if x, ok := ParseXid(line); ok {
			fn(x)
		}
	}
	return sc.Err()
}
