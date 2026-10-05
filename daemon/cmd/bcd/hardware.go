package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// bcd hardware: what this binary sees of the machine it runs on, for bringing up a new server
// model before it joins. It prints the inventory bcd would report (a summary, or --json the whole
// sections) and bring-up findings (identifiers the control plane will miss, kernel features bcd
// relies on). --capture copies exactly the procfs/sysfs files it read into a directory that
// inventory.Collector{Root: dir} replays, so a new machine model becomes a test fixture
// (daemon/internal/inventory/testdata/hosts); --redact first replaces serials, UUIDs, MACs and the
// hostname with stable stand-ins.

// dmiSource fills the root-only DMI values (product UUID, serials) an unprivileged collection reads
// empty: set to bcd helper's dmi.read when bcd node runs under [helper] (agent.go). nil: none.
var dmiSource func() map[string]string

// helperDMI asks bcd helper for the root-only DMI values; a failure reads as none (the inventory
// then carries what an unprivileged read saw, and doctor says so).
func helperDMI(c helper.Client) func() map[string]string {
	return func() map[string]string {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		values, err := c.ReadDMI(ctx)
		if err != nil {
			return nil
		}
		return values
	}
}

func hardwareFlags(fs *flag.FlagSet) {
	fs.Bool("json", false, "print the full inventory as JSON")
	fs.String("capture", "", "copy the files the inventory was read from into this directory (a replayable fixture)")
	fs.Bool("redact", false, "with --capture: replace serials, UUIDs, MACs, WWNs and the hostname with stable stand-ins")
}

func runHardware(fs *flag.FlagSet, stdout, stderr io.Writer) int {
	capture := fs.Lookup("capture").Value.String()
	redact := fs.Lookup("redact").Value.String() == "true"
	asJSON := fs.Lookup("json").Value.String() == "true"
	if redact && capture == "" {
		fmt.Fprintln(stderr, "bcd hardware: --redact goes with --capture")
		return exitUsage
	}

	var inv *inventory.NodeInventory
	var err error
	if capture != "" {
		if hardwareBackend != "host" {
			fmt.Fprintln(stderr, "bcd hardware: --capture reads the real host; this is a "+hardwareBackend+" build")
			return exitUsage
		}
		dir := capture
		archive := strings.HasSuffix(capture, ".tar.gz")
		if archive {
			// A fixture for the repository: captured in a scratch directory, then archived (symlinks
			// do not survive a git checkout on Windows; the tarball does).
			if dir, err = os.MkdirTemp("", "bcd-capture-"); err != nil {
				fmt.Fprintf(stderr, "bcd hardware: %v\n", err)
				return exitFailure
			}
			defer os.RemoveAll(dir)
		}
		inv, err = inventory.Capture(dir, inventory.CaptureOptions{Redact: redact})
		if err == nil && archive {
			err = inventory.WriteFixture(dir, capture)
		}
		if err == nil {
			fmt.Fprintf(stderr, "captured into %s%s\n", capture, map[bool]string{true: " (redacted)", false: ""}[redact])
		}
	} else {
		inv, err = collectInventory()
	}
	if err != nil {
		fmt.Fprintf(stderr, "bcd hardware: %v\n", err)
		return exitFailure
	}

	if asJSON {
		b, err := json.MarshalIndent(inv, "", "  ")
		if err != nil {
			fmt.Fprintf(stderr, "bcd hardware: %v\n", err)
			return exitFailure
		}
		fmt.Fprintln(stdout, string(b))
		return exitOK
	}
	printHardware(stdout, inv)
	failed := false
	fmt.Fprintln(stdout, "\nFindings")
	for _, f := range inventory.HostFindings(inv, os.Geteuid() == 0) {
		if f.Status == "fail" {
			failed = true
		}
		fmt.Fprintf(stdout, "  %-4s  %-9s %s\n", f.Status, f.Check, f.Detail)
	}
	if failed {
		return exitFailure
	}
	return exitOK
}

func printHardware(w io.Writer, inv *inventory.NodeInventory) {
	fmt.Fprintf(w, "bcd %s (%s backend)\n", version, hardwareBackend)
	if s := inv.System; s != nil {
		fmt.Fprintf(w, "\nSystem    %s %s (board %s %s), BIOS %s %s, %s", s.Vendor, s.Product, s.BoardVendor, s.BoardProduct, s.BiosVendor, s.BiosVersion, bootMode(s))
		if s.Tpm != nil {
			fmt.Fprintf(w, ", TPM %s", s.Tpm.Version)
		}
		fmt.Fprintln(w)
	}
	if c := inv.Cpu; c != nil {
		fmt.Fprintf(w, "CPU       %s (%s %s): %d sockets, %d cores, %d threads\n", c.Model, c.Vendor, c.Architecture, c.Sockets, c.Cores, c.Threads)
		for _, n := range c.NumaNodes {
			fmt.Fprintf(w, "  node%d   cpus %s, %s\n", n.Id, n.Cpus, humanBytes(n.MemoryBytes))
		}
		if c.IsolatedCpus != "" {
			fmt.Fprintf(w, "  isolated cpus %s\n", c.IsolatedCpus)
		}
	}
	if m := inv.Memory; m != nil {
		fmt.Fprintf(w, "Memory    %s\n", humanBytes(m.TotalBytes))
	}
	if d := inv.Disks; d != nil {
		for _, disk := range d.Disks {
			fmt.Fprintf(w, "Disk      %-10s %-9s %s %s (serial %s, wwn %s)\n", disk.Name, humanBytes(disk.SizeBytes), transportName(disk.Transport), disk.Model, orDash(disk.Serial), orDash(disk.Wwn))
		}
	}
	if n := inv.Nics; n != nil {
		for _, nic := range n.Nics {
			speed := "?"
			if nic.SpeedMbps > 0 {
				speed = fmt.Sprintf("%d Mb/s", nic.SpeedMbps)
			}
			fmt.Fprintf(w, "NIC       %-10s %s %s %s %s\n", nic.Name, nic.Mac, orDash(nic.Driver), orDash(nic.PciAddress), speed)
		}
	}
	if g := inv.Gpus; g != nil {
		for _, gpu := range g.Gpus {
			fmt.Fprintf(w, "GPU %-5d %s %s %s\n", gpu.Index, gpu.Name, gpu.PciBusId, gpu.Uuid)
		}
	}
	if o := inv.Os; o != nil {
		fmt.Fprintf(w, "OS        %s %s, kernel %s, %s, runtimes %s\n", o.Distro, o.DistroVersion, o.Kernel, cgroupName(o.Cgroup), orDash(strings.Join(o.Runtimes, ",")))
	}
}

func humanBytes(b uint64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := uint64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(b)/float64(div), "KMGTPE"[exp])
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func bootMode(s *inventory.SystemSection) string {
	mode := "BIOS boot"
	if s.BootMode == inventory.BootMode_BOOT_MODE_UEFI {
		mode = "UEFI"
		if s.SecureBoot != nil && *s.SecureBoot {
			mode += " (Secure Boot)"
		}
	}
	return mode
}

func transportName(t inventory.DiskTransport) string {
	switch t {
	case inventory.DiskTransport_DISK_TRANSPORT_NVME:
		return "nvme"
	case inventory.DiskTransport_DISK_TRANSPORT_SATA:
		return "sata"
	case inventory.DiskTransport_DISK_TRANSPORT_SAS:
		return "sas"
	case inventory.DiskTransport_DISK_TRANSPORT_VIRTIO:
		return "virtio"
	case inventory.DiskTransport_DISK_TRANSPORT_USB:
		return "usb"
	}
	return "?"
}

func cgroupName(v inventory.CgroupVersion) string {
	if v == inventory.CgroupVersion_CGROUP_VERSION_V2 {
		return "cgroup v2"
	}
	return "cgroup v1"
}
