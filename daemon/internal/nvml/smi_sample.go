package nvml

import (
	"context"
	"strings"
)

// The live samples are read often (the OTLP export, every 5 s at the shortest; bcd status), and a
// full Snapshot runs nvidia-smi six times, -q -x walking every field of every GPU: on an 8-GPU board
// that takes seconds of driver time per sample. Samples asks only for what a sample holds, in one
// CSV query plus one for the compute processes.

// sampleFields are the --query-gpu fields of a Sample, in column order.
var sampleFields = []string{
	"uuid", "memory.total", "memory.used", "memory.reserved", "memory.free",
	"utilization.gpu", "utilization.memory", "temperature.gpu", "power.draw", "power.limit",
	"clocks.sm", "clocks.mem", "pstate", "mig.mode.current",
}

// computeProcesses counts a -q -x GPU's compute processes.
func computeProcesses(x smiGPU) int {
	n := 0
	for _, p := range x.Processes.Infos {
		if strings.Contains(p.Type, "C") {
			n++
		}
	}
	return n
}

// Samples reads every GPU's live state. A GPU in MIG mode needs its MIG devices' memory, which only
// -q -x gives, and a driver may refuse a field it predates (memory.reserved before R510): both fall
// back to the full Snapshot.
func (s SMI) Samples(ctx context.Context) (*Snapshot, error) {
	out, err := s.run(ctx, "--query-gpu="+strings.Join(sampleFields, ","), "--format=csv,noheader,nounits")
	if err != nil {
		if err == ErrNoDriver {
			return nil, err
		}
		return s.Snapshot(ctx)
	}
	var samples []Sample
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Split(line, ",")
		if len(f) != len(sampleFields) {
			if strings.TrimSpace(line) == "" {
				continue
			}
			return s.Snapshot(ctx)
		}
		for i := range f {
			f[i] = strings.TrimSpace(f[i])
		}
		if enabled(f[13]) {
			return s.Snapshot(ctx)
		}
		util, _ := number(f[5])
		memUtil, _ := number(f[6])
		temp, _ := number(f[7])
		sm, _ := number(f[10])
		memClock, _ := number(f[11])
		sample := Sample{
			UUID:              f[0],
			MemoryTotal:       mib(f[1]),
			MemoryUsed:        mib(f[2]),
			MemoryReserved:    mib(f[3]),
			MemoryFree:        mib(f[4]),
			UtilizationGPU:    uint32(util),
			UtilizationMemory: uint32(memUtil),
			TemperatureC:      uint32(temp),
			PowerDrawMw:       milliwatts(f[8]),
			PowerLimitMw:      milliwatts(f[9]),
			SMClockMHz:        uint32(sm),
			MemClockMHz:       uint32(memClock),
		}
		if !na(f[12]) {
			sample.PState = f[12]
		}
		samples = append(samples, sample)
	}
	if apps, err := s.run(ctx, "--query-compute-apps=gpu_uuid", "--format=csv,noheader"); err == nil {
		perGPU := map[string]int{}
		for _, line := range strings.Split(string(apps), "\n") {
			if uuid := strings.TrimSpace(line); strings.HasPrefix(uuid, "GPU-") {
				perGPU[uuid]++
			}
		}
		for i := range samples {
			samples[i].Processes = perGPU[samples[i].UUID]
		}
	}
	return &Snapshot{Samples: samples}, nil
}
