package inventory

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"regexp"
	"time"
)

// SATA and SAS drive health through smartctl (smartmontools), where it is installed: its JSON output
// carries the drive's own verdict and the counters that predict a failure, with the ATA and SCSI
// pass-through details handled. Root only, as for any SMART read.

// smartctlDisk names the block devices smartctl is asked about ("sda", "sdab"): never a path.
var smartctlDisk = regexp.MustCompile(`^sd[a-z]{1,3}$`)

type smartctlOutput struct {
	Smartctl struct {
		ExitStatus int `json:"exit_status"`
	} `json:"smartctl"`
	SmartStatus *struct {
		Passed bool `json:"passed"`
	} `json:"smart_status"`
	ATAAttributes *struct {
		Table []struct {
			ID    int `json:"id"`
			Value int `json:"value"`
			Raw   struct {
				Value uint64 `json:"value"`
			} `json:"raw"`
		} `json:"table"`
	} `json:"ata_smart_attributes"`
	EnduranceUsed *struct {
		CurrentPercent *uint32 `json:"current_percent"`
	} `json:"endurance_used"`
	SCSIEnduranceUsed *uint32 `json:"scsi_percentage_used_endurance_indicator"`
	SCSIErrors        *struct {
		Read, Write, Verify struct {
			Uncorrected uint64 `json:"total_uncorrected_errors"`
		}
	} `json:"scsi_error_counter_log"`
	SCSIGrownDefects *uint64 `json:"scsi_grown_defect_list"`
}

// smartctl's exit status bit 3 is "SMART status check returned DISK FAILING".
const smartctlDiskFailing = 1 << 3

// parseSmartctl reads `smartctl -j -H -A -l devstat` output: nil when it carries no health verdict
// (no SMART support, the device could not be opened).
func parseSmartctl(out []byte) *SmartStatus {
	var o smartctlOutput
	if err := json.Unmarshal(out, &o); err != nil || o.SmartStatus == nil {
		return nil
	}
	s := &SmartStatus{Healthy: o.SmartStatus.Passed && o.Smartctl.ExitStatus&smartctlDiskFailing == 0}
	var media uint64
	counted := false
	if a := o.ATAAttributes; a != nil {
		for _, attr := range a.Table {
			switch attr.ID {
			case 197, 198: // Current_Pending_Sector, Offline_Uncorrectable: sectors that cannot be read
				media += attr.Raw.Value
				counted = true
			case 177, 231, 233: // wear levelling / SSD life left / media wearout: normalized, 100 = new
				if s.WearPercent == nil && attr.Value > 0 && attr.Value <= 100 {
					w := uint32(100 - attr.Value)
					s.WearPercent = &w
				}
			}
		}
	}
	// The device statistics' Percentage Used is the drive's own wear figure: it wins.
	if e := o.EnduranceUsed; e != nil && e.CurrentPercent != nil {
		s.WearPercent = e.CurrentPercent
	}
	if o.SCSIEnduranceUsed != nil {
		s.WearPercent = o.SCSIEnduranceUsed
	}
	if e := o.SCSIErrors; e != nil {
		media += e.Read.Uncorrected + e.Write.Uncorrected + e.Verify.Uncorrected
		counted = true
	}
	if counted {
		s.MediaErrors = &media
	}
	return s
}

// SmartctlHealth asks smartctl about a SATA or SAS disk ("sda"); nil without smartctl, privilege or
// a verdict.
func SmartctlHealth(disk string) *SmartStatus {
	if !smartctlDisk.MatchString(disk) {
		return nil
	}
	bin, err := exec.LookPath("smartctl")
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	// -n standby: never spin up a sleeping disk for an inventory read.
	out, err := exec.CommandContext(ctx, bin, "-j", "-H", "-A", "-l", "devstat", "-n", "standby", "/dev/"+disk).Output()
	var exit *exec.ExitError
	if err != nil && !errors.As(err, &exit) {
		return nil
	}
	// Bits 0-1: the command line or the device open failed; the rest still come with a report.
	if exit != nil && exit.ExitCode()&0x3 != 0 {
		return nil
	}
	return parseSmartctl(out)
}
