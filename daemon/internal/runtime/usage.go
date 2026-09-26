package runtime

import (
	"bufio"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Usage is one domain's live usage, from the guest's side: what it received and sent, read and
// wrote. Counters are cumulative since the domain started.
type Usage struct {
	CPUSeconds   float64 `json:"cpuSeconds"`
	MemoryBytes  uint64  `json:"memoryBytes"`
	IOReadBytes  uint64  `json:"ioReadBytes"`
	IOWriteBytes uint64  `json:"ioWriteBytes"`
	NetRxBytes   uint64  `json:"netRxBytes"`
	NetTxBytes   uint64  `json:"netTxBytes"`
}

// UsageReader is a runtime that reports its running domains' live usage (bcd's OTLP export,
// bcd.instance.*). A domain it cannot read is left out.
type UsageReader interface {
	Usage(ctx context.Context) (map[string]Usage, error)
}

// Where usage is read from; tests point them at a fake tree.
var (
	cgroupRoot  = "/sys/fs/cgroup"
	sysClassNet = "/sys/class/net"
)

// readUint reads one integer file.
func readUint(path string) (uint64, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	n, err := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
	return n, err == nil
}

// cgroupUsage reads a cgroup v2 directory: cpu.stat usage_usec, memory.current, io.stat rbytes/wbytes.
func cgroupUsage(dir string) (Usage, bool) {
	var u Usage
	cpu, err := os.ReadFile(filepath.Join(dir, "cpu.stat"))
	if err != nil {
		return u, false
	}
	for _, line := range strings.Split(string(cpu), "\n") {
		if v, ok := strings.CutPrefix(line, "usage_usec "); ok {
			if n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64); err == nil {
				u.CPUSeconds = float64(n) / 1e6
			}
		}
	}
	u.MemoryBytes, _ = readUint(filepath.Join(dir, "memory.current"))
	if io, err := os.ReadFile(filepath.Join(dir, "io.stat")); err == nil {
		// "259:0 rbytes=1 wbytes=2 rios=3 wios=4 dbytes=0 dios=0", one line per device.
		for _, line := range strings.Split(string(io), "\n") {
			for _, f := range strings.Fields(line) {
				k, v, ok := strings.Cut(f, "=")
				n, err := strconv.ParseUint(v, 10, 64)
				if !ok || err != nil {
					continue
				}
				switch k {
				case "rbytes":
					u.IOReadBytes += n
				case "wbytes":
					u.IOWriteBytes += n
				}
			}
		}
	}
	return u, true
}

// tapUsage adds a domain's taps' counters: a tap's tx is what the guest received.
func tapUsage(u *Usage, id string, nics int) {
	for i := 0; i < nics; i++ {
		dir := filepath.Join(sysClassNet, TapName(id, i), "statistics")
		if n, ok := readUint(filepath.Join(dir, "tx_bytes")); ok {
			u.NetRxBytes += n
		}
		if n, ok := readUint(filepath.Join(dir, "rx_bytes")); ok {
			u.NetTxBytes += n
		}
	}
}

// Usage reads each running VMM's cgroup (its transient unit in bcd-instances.slice) and its taps.
func (c *CloudHypervisor) Usage(ctx context.Context) (map[string]Usage, error) {
	domains, err := c.List(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]Usage{}
	for _, d := range domains {
		if !d.Managed || (d.State != StateRunning && d.State != StatePaused) {
			continue
		}
		u, ok := cgroupUsage(filepath.Join(cgroupRoot, "bcd-instances.slice", unitName(d.ID)))
		if !ok {
			continue
		}
		tapUsage(&u, d.ID, len(d.MACs))
		out[d.ID] = u
	}
	return out, nil
}

// Usage asks libvirt (virsh domstats: CPU time, the QEMU process's resident memory, block and
// interface counters), which works wherever virsh does, under bcd helper too.
func (l *Libvirt) Usage(ctx context.Context) (map[string]Usage, error) {
	out, err := l.virsh(ctx, "domstats", "--raw", "--state-running", "--cpu-total", "--balloon", "--interface", "--block")
	if err != nil {
		return nil, err
	}
	return parseDomstats(out), nil
}

// parseDomstats reads `virsh domstats --raw`:
//
//	Domain: 'inst_web'
//	  cpu.time=123456789000
//	  balloon.rss=524288
//	  net.0.rx.bytes=10
//	  block.0.rd.bytes=20
func parseDomstats(out []byte) map[string]Usage {
	usage := map[string]Usage{}
	current := ""
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if name, ok := strings.CutPrefix(line, "Domain: "); ok {
			current = strings.Trim(name, "'\"")
			usage[current] = Usage{}
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || current == "" {
			continue
		}
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			continue
		}
		u := usage[current]
		switch {
		case k == "cpu.time":
			u.CPUSeconds = float64(n) / 1e9
		case k == "balloon.rss":
			u.MemoryBytes = n * 1024
		case strings.HasPrefix(k, "net.") && strings.HasSuffix(k, ".rx.bytes"):
			u.NetRxBytes += n
		case strings.HasPrefix(k, "net.") && strings.HasSuffix(k, ".tx.bytes"):
			u.NetTxBytes += n
		case strings.HasPrefix(k, "block.") && strings.HasSuffix(k, ".rd.bytes"):
			u.IOReadBytes += n
		case strings.HasPrefix(k, "block.") && strings.HasSuffix(k, ".wr.bytes"):
			u.IOWriteBytes += n
		}
		usage[current] = u
	}
	return usage
}

// Usage of the fake: a running domain uses half its memory and a second of CPU per boot.
func (f *Fake) Usage(ctx context.Context) (map[string]Usage, error) {
	domains, err := f.List(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]Usage{}
	for _, d := range domains {
		if d.State != StateRunning {
			continue
		}
		out[d.ID] = Usage{CPUSeconds: float64(d.Boots), MemoryBytes: d.MemoryBytes / 2}
	}
	return out, nil
}
