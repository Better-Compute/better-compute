package fakehw

import (
	"math"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/nvml"
)

// GPUSnapshot is a live nvidia-smi reading of the fake machine of seed at t: every GPU's memory,
// utilization, temperature, power and clocks move smoothly with time (distinct per GPU), so an
// OTLP export from bcd sim shows plausible curves.
func GPUSnapshot(seed uint64, t time.Time) *nvml.Snapshot {
	inv := Inventory(seed)
	snap := &nvml.Snapshot{Section: inv.Gpus}
	if inv.Gpus == nil {
		return snap
	}
	for _, g := range inv.Gpus.Gpus {
		phase := float64(seed%97) + float64(g.Index)*0.7
		wave := (math.Sin(float64(t.Unix())/300+phase) + 1) / 2 // 0..1, a 30 min period
		util := uint32(math.Round(wave * 100))
		used := uint64(float64(g.VramBytes) * (0.05 + 0.9*wave))
		used -= used % (1 << 20)
		idle := min(uint32(70_000), g.PowerLimitMw)
		snap.Samples = append(snap.Samples, nvml.Sample{
			UUID:              g.Uuid,
			MemoryTotal:       g.VramBytes,
			MemoryUsed:        used,
			MemoryReserved:    346 << 20,
			MemoryFree:        g.VramBytes - used - 346<<20,
			UtilizationGPU:    util,
			UtilizationMemory: util / 2,
			TemperatureC:      32 + uint32(math.Round(wave*40)),
			PowerDrawMw:       idle + uint32(math.Round(wave*float64(g.PowerLimitMw-idle))),
			PowerLimitMw:      g.PowerLimitMw,
			SMClockMHz:        345 + uint32(math.Round(wave*1635)),
			MemClockMHz:       2619,
			PState:            "P0",
			Processes:         int(math.Round(wave * 2)),
		})
	}
	return snap
}
