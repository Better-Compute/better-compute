package inventory

import (
	"encoding/binary"
	"regexp"
)

// Disk health. NVMe drives report it in the SMART / Health Information log page (log id 0x02, 512
// bytes), which bcd reads with one admin command (NVMeHealth on Linux; root, as for smartctl).
// SATA and SAS drives (SMART over SG_IO) are not read yet: their Smart stays absent.

// nvmeController names a controller character device (/dev/nvme0).
var nvmeController = regexp.MustCompile(`^nvme[0-9]+$`)

// nvmeCriticalTransient is the critical-warning bit for temperature: it comes and goes with the
// airflow, so it does not make a drive unhealthy (nor move the inventory hash with the weather).
const nvmeCriticalTransient = 0x02

// parseNVMeHealth reads a SMART / Health Information log page: healthy unless a lasting critical
// warning is set (spare below threshold, reliability degraded, read-only, backup or PMR failure),
// wear as Percentage Used (it may pass 100), media errors from the 128-bit counter (low 64 bits).
func parseNVMeHealth(page []byte) *SmartStatus {
	if len(page) < 512 {
		return nil
	}
	wear := uint32(page[5])
	media := binary.LittleEndian.Uint64(page[160:168])
	if binary.LittleEndian.Uint64(page[168:176]) != 0 {
		media = ^uint64(0) // past 2^64: saturate
	}
	return &SmartStatus{
		Healthy:     page[0]&^nvmeCriticalTransient == 0,
		WearPercent: &wear,
		MediaErrors: &media,
	}
}

// nvmeControllerOf is the controller behind an NVMe namespace's block device (its device link:
// /sys/block/nvme0n1/device -> nvme0).
func (c Collector) nvmeControllerOf(base string) string {
	if ctrl := c.link(base + "/device"); nvmeController.MatchString(ctrl) {
		return ctrl
	}
	return ""
}
