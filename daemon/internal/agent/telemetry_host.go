package agent

import (
	"context"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/runtime"
	"github.com/better-compute/better-compute/daemon/internal/telemetry"
)

// hostMemoryMetrics are the host's memory and hugepage pools (/proc/meminfo,
// /sys/kernel/mm/hugepages): what VMs, sandboxes and GPU holds book against (PLAN.md §3.8).
//
//	bcd.host.memory.total / available   bytes
//	bcd.host.hugepages.total / free     pages, by page.size (bytes)
func (a *Agent) hostMemoryMetrics() []telemetry.Metric {
	var out []telemetry.Metric
	i64 := func(v uint64) *int64 { n := int64(v); return &n }
	if fields, err := a.meminfo(); err == nil {
		for _, m := range []struct{ name, key string }{
			{"bcd.host.memory.total", "MemTotal"},
			{"bcd.host.memory.available", "MemAvailable"},
		} {
			if v, ok := fields[m.key]; ok {
				out = append(out, telemetry.Metric{Name: m.name, Unit: "By", Points: []telemetry.Point{{Int: i64(v)}}})
			}
		}
	}
	dir := a.host.Path("/sys/kernel/mm/hugepages")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	total := telemetry.Metric{Name: "bcd.host.hugepages.total", Unit: "{page}"}
	free := telemetry.Metric{Name: "bcd.host.hugepages.free", Unit: "{page}"}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		size, ok := strings.CutPrefix(name, "hugepages-")
		size, ok2 := strings.CutSuffix(size, "kB")
		kib, err := strconv.ParseUint(size, 10, 64)
		if !ok || !ok2 || err != nil {
			continue
		}
		attrs := map[string]string{"page.size": strconv.FormatUint(kib*1024, 10)}
		read := func(file string) (uint64, bool) {
			b, err := os.ReadFile(dir + "/" + name + "/" + file)
			if err != nil {
				return 0, false
			}
			n, err := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
			return n, err == nil
		}
		if n, ok := read("nr_hugepages"); ok {
			total.Points = append(total.Points, telemetry.Point{Attrs: attrs, Int: i64(n)})
		}
		if n, ok := read("free_hugepages"); ok {
			free.Points = append(free.Points, telemetry.Point{Attrs: attrs, Int: i64(n)})
		}
	}
	for _, m := range []telemetry.Metric{total, free} {
		if len(m.Points) > 0 {
			out = append(out, m)
		}
	}
	return out
}

// meminfo reads the host's /proc/meminfo, in bytes.
func (a *Agent) meminfo() (map[string]uint64, error) {
	b, err := os.ReadFile(a.host.Path("/proc/meminfo"))
	if err != nil {
		return nil, err
	}
	fields := map[string]uint64{}
	for _, line := range strings.Split(string(b), "\n") {
		key, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}
		if n, err := strconv.ParseUint(f[0], 10, 64); err == nil {
			if len(f) > 1 && f[1] == "kB" {
				n *= 1024
			}
			fields[key] = n
		}
	}
	return fields, nil
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// instanceMetrics are the VMs and sandboxes the runtimes hold (managed or not):
//
//	bcd.instances             count, by runtime and state
//	bcd.instance.vcpu         configured vCPUs, by instance.id and runtime
//	bcd.instance.memory       configured memory bytes, by instance.id, runtime and hugepages
//	bcd.instance.memory.balloon  what a ballooned guest's balloon leaves it, by instance.id, runtime
func (a *Agent) instanceMetrics(ctx context.Context) []telemetry.Metric {
	if len(a.o.Runtimes) == 0 {
		return nil
	}
	counts := map[[2]string]int64{}
	vcpu := telemetry.Metric{Name: "bcd.instance.vcpu", Unit: "{cpu}"}
	memory := telemetry.Metric{Name: "bcd.instance.memory", Unit: "By"}
	// Live usage, from runtimes that read it (runtime.UsageReader): cumulative sums and a gauge.
	cpuTime := telemetry.Metric{Name: "bcd.instance.cpu.time", Unit: "s", Sum: true}
	memUsed := telemetry.Metric{Name: "bcd.instance.memory.used", Unit: "By"}
	ioRead := telemetry.Metric{Name: "bcd.instance.io.read", Unit: "By", Sum: true}
	ioWrite := telemetry.Metric{Name: "bcd.instance.io.write", Unit: "By", Sum: true}
	netRx := telemetry.Metric{Name: "bcd.instance.network.receive", Unit: "By", Sum: true}
	netTx := telemetry.Metric{Name: "bcd.instance.network.transmit", Unit: "By", Sum: true}
	balloon := telemetry.Metric{Name: "bcd.instance.memory.balloon", Unit: "By"}
	for _, r := range a.o.Runtimes {
		domains, err := r.List(ctx)
		if err != nil {
			continue
		}
		if reader, ok := r.(runtime.UsageReader); ok {
			if usage, err := reader.Usage(ctx); err == nil {
				for _, id := range sortedKeys(usage) {
					u := usage[id]
					attrs := map[string]string{"instance.id": id, "runtime": r.Name()}
					n := func(m *telemetry.Metric, v uint64) {
						x := int64(v)
						m.Points = append(m.Points, telemetry.Point{Attrs: attrs, Int: &x})
					}
					cpuTime.Points = append(cpuTime.Points, telemetry.Point{Attrs: attrs, Double: u.CPUSeconds})
					n(&memUsed, u.MemoryBytes)
					n(&ioRead, u.IOReadBytes)
					n(&ioWrite, u.IOWriteBytes)
					n(&netRx, u.NetRxBytes)
					n(&netTx, u.NetTxBytes)
				}
			}
		}
		if b, ok := r.(runtime.Ballooner); ok {
			if sizes, err := b.Balloons(ctx); err == nil {
				for _, id := range sortedKeys(sizes) {
					v := int64(sizes[id])
					balloon.Points = append(balloon.Points, telemetry.Point{Attrs: map[string]string{"instance.id": id, "runtime": r.Name()}, Int: &v})
				}
			}
		}
		for _, d := range domains {
			counts[[2]string{r.Name(), d.State}]++
			attrs := map[string]string{"instance.id": d.ID, "runtime": r.Name(), "managed": strconv.FormatBool(d.Managed)}
			v, m := int64(d.VCPU), int64(d.MemoryBytes)
			vcpu.Points = append(vcpu.Points, telemetry.Point{Attrs: attrs, Int: &v})
			memAttrs := with(attrs, "hugepages", strconv.FormatUint(d.HugepageSize, 10))
			memory.Points = append(memory.Points, telemetry.Point{Attrs: memAttrs, Int: &m})
		}
	}
	instances := telemetry.Metric{Name: "bcd.instances", Unit: "{instance}"}
	keys := make([][2]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i][0]+"/"+keys[i][1] < keys[j][0]+"/"+keys[j][1] })
	for _, k := range keys {
		n := counts[k]
		instances.Points = append(instances.Points, telemetry.Point{Attrs: map[string]string{"runtime": k[0], "state": k[1]}, Int: &n})
	}
	var out []telemetry.Metric
	for _, m := range []telemetry.Metric{instances, vcpu, memory, balloon, cpuTime, memUsed, ioRead, ioWrite, netRx, netTx} {
		if len(m.Points) > 0 {
			out = append(out, m)
		}
	}
	return out
}
