// Package slice keeps the cgroup-v2 slices of GPU holds (PLAN.md §3.8): a hold with
// DeviceAssignment.limits gets bcd-alloc-<allocation>.slice, with its CPUs (AllowedCPUs), NUMA
// nodes (AllowedMemoryNodes), CPU time (CPUQuota), memory (MemoryMax, MemoryHigh at 90%) and
// hugepages (hugetlb.<size>.max, written to cgroupfs: systemd has no property for them). The CDI
// spec names the slice, so containerd, Slurm or a wrapper place the workload inside it.
//
// Apply is idempotent (bcd runs it on every pass: runtime properties vanish on a reboot, the hold
// does not). Remove stops a slice only once it is empty: a release never kills a workload.
package slice

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Name is the slice of a hold's allocation.
func Name(allocationID string) string { return "bcd-alloc-" + allocationID + ".slice" }

// namePattern: allocation ids carry no "-", so the slice sits at bcd.slice/bcd-alloc.slice/<name>.
var namePattern = regexp.MustCompile(`^bcd-alloc-[A-Za-z0-9_]{1,80}\.slice$`)
var cpuList = regexp.MustCompile(`^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$`)

// Limits are a hold's limits, as DeviceAssignment.limits carries them.
type Limits struct {
	CPUs         string `json:"cpus,omitempty"`
	Mems         string `json:"mems,omitempty"`
	CPUMillis    uint32 `json:"cpuMillis,omitempty"`
	MemoryBytes  uint64 `json:"memoryBytes,omitempty"`
	Hugepages2Mi uint64 `json:"hugepages2Mi,omitempty"`
	Hugepages1Gi uint64 `json:"hugepages1Gi,omitempty"`
}

// Check refuses a name or limits that are not what bcd writes (the helper runs Apply as root).
func Check(name string, l Limits) error {
	if !namePattern.MatchString(name) {
		return fmt.Errorf("%q is not a hold's slice", name)
	}
	for field, list := range map[string]string{"cpus": l.CPUs, "mems": l.Mems} {
		if list != "" && (len(list) > 1024 || !cpuList.MatchString(list)) {
			return fmt.Errorf("%s %q is not a cpulist", field, list)
		}
	}
	return nil
}

// Runner runs a command (systemctl), as root.
type Runner func(ctx context.Context, name string, args ...string) error

// Properties are the systemd properties of a slice with these limits.
func Properties(l Limits) []string {
	var props []string
	if l.CPUs != "" {
		props = append(props, "AllowedCPUs="+l.CPUs)
	}
	if l.Mems != "" {
		props = append(props, "AllowedMemoryNodes="+l.Mems)
	}
	if l.CPUMillis > 0 {
		// Percent of one CPU, rounded up (CPUQuota takes whole percents).
		props = append(props, fmt.Sprintf("CPUQuota=%d%%", (uint64(l.CPUMillis)+9)/10))
	}
	if l.MemoryBytes > 0 {
		props = append(props, fmt.Sprintf("MemoryMax=%d", l.MemoryBytes), fmt.Sprintf("MemoryHigh=%d", l.MemoryBytes/10*9))
	}
	return props
}

// Dir is the slice's cgroup directory under the cgroup-v2 mount (root "" is "/").
func Dir(root, name string) string {
	return filepath.Join(root, "/sys/fs/cgroup/bcd.slice/bcd-alloc.slice", name)
}

// Apply starts the slice and sets its limits (runtime properties, and hugetlb in cgroupfs).
func Apply(ctx context.Context, run Runner, root, name string, l Limits) error {
	if err := Check(name, l); err != nil {
		return err
	}
	if err := run(ctx, "systemctl", "start", name); err != nil {
		return fmt.Errorf("start %s: %w", name, err)
	}
	if props := Properties(l); len(props) > 0 {
		args := append([]string{"set-property", "--runtime", name}, props...)
		if err := run(ctx, "systemctl", args...); err != nil {
			return fmt.Errorf("set the limits of %s: %w", name, err)
		}
	}
	return applyHugetlb(root, name, l)
}

// applyHugetlb writes the slice's hugepage limits. systemd enables only the controllers it manages,
// so hugetlb is enabled on the slice's ancestors first (each write is a no-op when already on).
func applyHugetlb(root, name string, l Limits) error {
	if l.Hugepages2Mi == 0 && l.Hugepages1Gi == 0 {
		return nil
	}
	dir := Dir(root, name)
	base := filepath.Join(root, "/sys/fs/cgroup")
	for _, ancestor := range []string{base, filepath.Join(base, "bcd.slice"), filepath.Join(base, "bcd.slice/bcd-alloc.slice")} {
		if err := os.WriteFile(filepath.Join(ancestor, "cgroup.subtree_control"), []byte("+hugetlb"), 0o644); err != nil {
			return fmt.Errorf("enable hugetlb under %s: %w", ancestor, err)
		}
	}
	for size, pages := range map[string]uint64{"2MB": l.Hugepages2Mi, "1GB": l.Hugepages1Gi} {
		if pages == 0 {
			continue
		}
		bytes := pages * (2 << 20)
		if size == "1GB" {
			bytes = pages * (1 << 30)
		}
		file := filepath.Join(dir, "hugetlb."+size+".max")
		if err := os.WriteFile(file, []byte(strconv.FormatUint(bytes, 10)), 0o644); err != nil {
			return fmt.Errorf("limit %s hugepages of %s: %w", size, name, err)
		}
	}
	return nil
}

// ErrBusy: the slice still runs a workload; it is left, with its limits, until that exits.
var ErrBusy = errors.New("the slice still runs processes")

// Remove stops the slice once nothing runs in it (cgroup.events "populated 0"); an absent slice is
// fine.
func Remove(ctx context.Context, run Runner, root, name string) error {
	if !namePattern.MatchString(name) {
		return fmt.Errorf("%q is not a hold's slice", name)
	}
	events, err := os.ReadFile(filepath.Join(Dir(root, name), "cgroup.events"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(events), "\n") {
		if strings.TrimSpace(line) == "populated 1" {
			return ErrBusy
		}
	}
	return run(ctx, "systemctl", "stop", name)
}
