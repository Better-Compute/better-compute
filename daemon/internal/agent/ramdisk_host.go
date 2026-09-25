package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
)

// The ramdisk's hardware operations on a real machine, through the standard tools a ramdisk image
// ships (nvme-cli, hdparm, util-linux, kexec-tools, dcgmi). Under a fake root (fakehw) they act on
// the disk image files and succeed, so the portable logic in ramdisk.go runs unchanged in tests.

func (h *RealHost) fake() bool { return h.Root != "" && h.Root != "/" }

func run(ctx context.Context, name string, args ...string) (string, error) {
	out, err := osexec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// SecureErase erases a whole disk with the drive's own command: NVMe format with secure (ses=1) or
// crypto (ses=2) erase, or the ATA security erase for SATA; crypto erase of a non-NVMe disk is
// refused. It reports the method and whether the drive confirmed it.
func (h *RealHost) SecureErase(ctx context.Context, d *inventory.Disk, mode agentv1.WipeMode) (string, bool, error) {
	dev := "/dev/" + d.Name
	crypto := mode == agentv1.WipeMode_WIPE_MODE_CRYPTO_ERASE
	if h.fake() {
		if err := zeroFile(h.Path(dev)); err != nil {
			return "fake-erase", false, err
		}
		return "fake-erase", true, nil
	}
	switch d.Transport {
	case inventory.DiskTransport_DISK_TRANSPORT_NVME:
		ses, method := "1", "nvme-format"
		if crypto {
			ses, method = "2", "crypto-erase"
		}
		if _, err := run(ctx, "nvme", "format", dev, "--ses="+ses, "--force"); err != nil {
			return method, false, err
		}
		return method, true, nil
	case inventory.DiskTransport_DISK_TRANSPORT_SATA:
		if crypto {
			return "crypto-erase", false, errors.New("crypto erase needs an NVMe or self-encrypting drive")
		}
		const pass = "bcwipe"
		if _, err := run(ctx, "hdparm", "--user-master", "u", "--security-set-pass", pass, dev); err != nil {
			return "ata-secure-erase", false, err
		}
		if _, err := run(ctx, "hdparm", "--user-master", "u", "--security-erase", pass, dev); err != nil {
			return "ata-secure-erase", false, err
		}
		return "ata-secure-erase", true, nil
	}
	if crypto {
		return "crypto-erase", false, fmt.Errorf("no crypto erase for %s", d.Name)
	}
	if _, err := run(ctx, "blkdiscard", "--secure", dev); err != nil {
		return "blkdiscard", false, err
	}
	return "blkdiscard", true, nil
}

func zeroFile(path string) error {
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	zero := make([]byte, 1<<20)
	for off := int64(0); off < st.Size(); off += int64(len(zero)) {
		n := min(int64(len(zero)), st.Size()-off)
		if _, err := f.WriteAt(zero[:n], off); err != nil {
			return err
		}
	}
	return f.Sync()
}

// RereadPartitions makes the kernel read a freshly written partition table.
func (h *RealHost) RereadPartitions(ctx context.Context, d *inventory.Disk) error {
	if h.fake() {
		return nil
	}
	_, err := run(ctx, "blockdev", "--rereadpt", "/dev/"+d.Name)
	_, _ = run(ctx, "udevadm", "settle")
	return err
}

// blockDevice is one lsblk entry.
type blockDevice struct {
	Name     string        `json:"name"`
	Size     json.Number   `json:"size"`
	Type     string        `json:"type"`
	FSType   string        `json:"fstype"`
	Label    string        `json:"label"`
	PartUUID string        `json:"partuuid"`
	UUID     string        `json:"uuid"`
	Children []blockDevice `json:"children"`
}

// partitions lists a disk's partitions, largest first (lsblk -J -b).
func partitions(lsblkJSON []byte) ([]blockDevice, error) {
	var doc struct {
		Blockdevices []blockDevice `json:"blockdevices"`
	}
	if err := json.Unmarshal(lsblkJSON, &doc); err != nil {
		return nil, err
	}
	var parts []blockDevice
	for _, d := range doc.Blockdevices {
		for _, c := range d.Children {
			if c.Type == "part" {
				parts = append(parts, c)
			}
		}
	}
	sort.SliceStable(parts, func(i, j int) bool {
		a, _ := strconv.ParseInt(parts[i].Size.String(), 10, 64)
		b, _ := strconv.ParseInt(parts[j].Size.String(), 10, 64)
		return a > b
	})
	return parts, nil
}

func (h *RealHost) diskPartitions(ctx context.Context, d *inventory.Disk) ([]blockDevice, error) {
	out, err := osexec.CommandContext(ctx, "lsblk", "-J", "-b", "-o", "NAME,SIZE,TYPE,FSTYPE,LABEL,PARTUUID,UUID", "/dev/"+d.Name).Output()
	if err != nil {
		return nil, fmt.Errorf("lsblk: %w", err)
	}
	return partitions(out)
}

// mountFirst mounts the first partition (largest first) whose filesystem holds want, and returns
// the mount point and its unmount.
func (h *RealHost) mountFirst(ctx context.Context, parts []blockDevice, readOnly bool, want func(dir string) bool) (string, blockDevice, func(), error) {
	for _, p := range parts {
		if p.FSType == "" || p.FSType == "swap" || strings.HasPrefix(p.FSType, "LVM") {
			continue
		}
		dir, err := os.MkdirTemp("", "bcd-mnt-")
		if err != nil {
			return "", p, nil, err
		}
		args := []string{"/dev/" + p.Name, dir}
		if readOnly {
			args = append([]string{"-o", "ro"}, args...)
		}
		if _, err := run(ctx, "mount", args...); err != nil {
			os.Remove(dir)
			continue
		}
		unmount := func() {
			_, _ = run(context.Background(), "umount", dir)
			os.Remove(dir)
		}
		if want(dir) {
			return dir, p, unmount, nil
		}
		unmount()
	}
	return "", blockDevice{}, nil, errors.New("no partition holds the installed system")
}

// InstallUserData writes the rendered user data where the installed OS reads it on first boot:
// cloud-init's NoCloud seed on the root filesystem, or Ignition's config on the boot partition.
func (h *RealHost) InstallUserData(ctx context.Context, d *inventory.Disk, kind string, data []byte) error {
	if h.fake() {
		return os.WriteFile(h.Path("/dev/"+d.Name)+".user-data", data, 0o600)
	}
	parts, err := h.diskPartitions(ctx, d)
	if err != nil {
		return err
	}
	switch kind {
	case "", "cloud-init":
		dir, _, unmount, err := h.mountFirst(ctx, parts, false, func(dir string) bool { return exists(filepath.Join(dir, "etc")) })
		if err != nil {
			return err
		}
		defer unmount()
		seed := filepath.Join(dir, "var/lib/cloud/seed/nocloud")
		if err := os.MkdirAll(seed, 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(seed, "user-data"), data, 0o600); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(seed, "meta-data"), []byte("instance-id: "+d.Name+"\n"), 0o600)
	case "ignition":
		boot := parts[:0:0]
		for _, p := range parts {
			if p.Label == "boot" {
				boot = append(boot, p)
			}
		}
		dir, _, unmount, err := h.mountFirst(ctx, boot, false, func(string) bool { return true })
		if err != nil {
			return errors.New("no partition labelled boot for the Ignition config")
		}
		defer unmount()
		if err := os.MkdirAll(filepath.Join(dir, "ignition"), 0o700); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dir, "ignition/config.ign"), data, 0o600)
	}
	return fmt.Errorf("user data kind %q is not supported by the ramdisk", kind)
}

// InstallFiles writes files into the installed root filesystem (the partition holding /etc).
func (h *RealHost) InstallFiles(ctx context.Context, d *inventory.Disk, files map[string][]byte) error {
	root := ""
	var unmount func()
	if h.fake() {
		root = h.Path("/dev/"+d.Name) + ".root"
		unmount = func() {}
	} else {
		parts, err := h.diskPartitions(ctx, d)
		if err != nil {
			return err
		}
		dir, _, um, err := h.mountFirst(ctx, parts, false, func(dir string) bool { return exists(filepath.Join(dir, "etc")) })
		if err != nil {
			return err
		}
		root, unmount = dir, um
	}
	defer unmount()
	for p, data := range files {
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(full, data, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// Kexec loads the installed kernel and initrd from the root disk and executes it. kernel and initrd
// are paths on the installed root filesystem (default: /boot/vmlinuz and /boot/initrd.img, else the
// newest /boot/vmlinuz-* with its initrd/initramfs); the command line gets root=UUID=<root>.
func (h *RealHost) Kexec(ctx context.Context, d *inventory.Disk, kernel, initrd string, cmdline []string) error {
	if h.KexecFunc != nil {
		return h.KexecFunc(ctx, d, kernel, initrd, cmdline)
	}
	if h.fake() {
		return h.Reboot("kexec")
	}
	parts, err := h.diskPartitions(ctx, d)
	if err != nil {
		return err
	}
	var k, i string
	dir, root, unmount, err := h.mountFirst(ctx, parts, true, func(dir string) bool {
		k, i = bootFiles(dir, kernel, initrd)
		return k != ""
	})
	if err != nil {
		return err
	}
	defer unmount()
	args := []string{"-l", filepath.Join(dir, k), "--command-line=" + strings.Join(append([]string{"root=UUID=" + root.UUID, "ro"}, cmdline...), " ")}
	if i != "" {
		args = append(args, "--initrd="+filepath.Join(dir, i))
	}
	if _, err := run(ctx, "kexec", args...); err != nil {
		return err
	}
	unmount()
	if _, err := run(ctx, "systemctl", "kexec"); err == nil {
		return nil
	}
	_, err = run(ctx, "kexec", "-e")
	return err
}

// bootFiles resolves the kernel and initrd on a mounted root ("" when there is no kernel).
func bootFiles(root, kernel, initrd string) (string, string) {
	if kernel != "" {
		if !exists(filepath.Join(root, kernel)) {
			return "", ""
		}
		return kernel, initrd
	}
	if exists(filepath.Join(root, "boot/vmlinuz")) {
		i := ""
		if exists(filepath.Join(root, "boot/initrd.img")) {
			i = "boot/initrd.img"
		}
		return "boot/vmlinuz", i
	}
	matches, _ := filepath.Glob(filepath.Join(root, "boot/vmlinuz-*"))
	if len(matches) == 0 {
		return "", ""
	}
	sort.Strings(matches)
	k := matches[len(matches)-1]
	version := strings.TrimPrefix(filepath.Base(k), "vmlinuz-")
	rel, _ := filepath.Rel(root, k)
	for _, cand := range []string{"boot/initrd.img-" + version, "boot/initramfs-" + version + ".img", "boot/initrd-" + version} {
		if exists(filepath.Join(root, cand)) {
			return rel, cand
		}
	}
	return rel, ""
}

// RunDCGM runs `dcgmi diag -r <level> -j` (or, under a fake root, passes every GPU).
func (h *RealHost) RunDCGM(ctx context.Context, level uint32, uuids []string, gpus []*inventory.Gpu) (*agentv1.DiagDcgmResult, error) {
	if h.fake() {
		return fakeDCGM(level, uuids, gpus), nil
	}
	args := []string{"diag", "-r", strconv.Itoa(int(level)), "-j"}
	if len(uuids) > 0 {
		var idx []string
		for _, u := range uuids {
			for _, g := range gpus {
				if g.Uuid == u {
					idx = append(idx, strconv.Itoa(int(g.Index)))
				}
			}
		}
		args = append(args, "-i", strings.Join(idx, ","))
	}
	out, err := osexec.CommandContext(ctx, "dcgmi", args...).Output()
	// dcgmi exits non-zero when a test fails; its JSON still says which.
	if len(out) == 0 && err != nil {
		return nil, err
	}
	return parseDCGM(out, uuids, gpus)
}

func fakeDCGM(level uint32, uuids []string, gpus []*inventory.Gpu) *agentv1.DiagDcgmResult {
	r := &agentv1.DiagDcgmResult{Passed: true, Level: level, Tests: []*agentv1.DiagnosticCheck{{Name: "dcgm.deployment", Passed: true}}}
	want := map[string]bool{}
	for _, u := range uuids {
		want[u] = true
	}
	for _, g := range gpus {
		if len(want) > 0 && !want[g.Uuid] {
			continue
		}
		r.Gpus = append(r.Gpus, &agentv1.GpuDiagnostic{Uuid: g.Uuid, Passed: true, Checks: []*agentv1.DiagnosticCheck{{Name: "memory", Passed: true}, {Name: "pcie", Passed: true}}})
	}
	sort.Slice(r.Gpus, func(i, j int) bool { return r.Gpus[i].Uuid < r.Gpus[j].Uuid })
	return r
}

// parseDCGM reads dcgmi's JSON: test categories of tests whose results are per GPU (gpu_id) or
// node-wide. "Pass" and "Skip" pass; anything else fails with its warnings as the message.
func parseDCGM(out []byte, uuids []string, gpus []*inventory.Gpu) (*agentv1.DiagDcgmResult, error) {
	var doc struct {
		Diag struct {
			Categories []struct {
				Category string `json:"category"`
				Tests    []struct {
					Name    string `json:"name"`
					Results []struct {
						GpuID    json.RawMessage `json:"gpu_id"`
						GpuIDs   json.RawMessage `json:"gpu_ids"`
						Status   string          `json:"status"`
						Warnings []struct {
							Warning string `json:"warning"`
						} `json:"warnings"`
						Info json.RawMessage `json:"info"`
					} `json:"results"`
				} `json:"tests"`
			} `json:"test_categories"`
		} `json:"DCGM GPU Diagnostic"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		return nil, fmt.Errorf("dcgmi output: %w", err)
	}
	byIndex := map[string]string{}
	for _, g := range gpus {
		byIndex[strconv.Itoa(int(g.Index))] = g.Uuid
	}
	per := map[string]*agentv1.GpuDiagnostic{}
	r := &agentv1.DiagDcgmResult{Passed: true}
	for _, cat := range doc.Diag.Categories {
		for _, test := range cat.Tests {
			name := strings.ToLower(strings.ReplaceAll(test.Name, " ", "-"))
			for _, res := range test.Results {
				ok := strings.EqualFold(res.Status, "pass") || strings.EqualFold(res.Status, "skip")
				var msgs []string
				for _, w := range res.Warnings {
					msgs = append(msgs, w.Warning)
				}
				check := &agentv1.DiagnosticCheck{Name: name, Passed: ok, Message: strings.Join(msgs, "; ")}
				id := strings.Trim(string(res.GpuID), `"`)
				if id == "" {
					id = strings.Trim(string(res.GpuIDs), `"`)
				}
				uuid := byIndex[id]
				if !ok {
					r.Passed = false
				}
				if uuid == "" {
					r.Tests = append(r.Tests, check)
					continue
				}
				gd := per[uuid]
				if gd == nil {
					gd = &agentv1.GpuDiagnostic{Uuid: uuid, Passed: true}
					per[uuid] = gd
				}
				gd.Checks = append(gd.Checks, check)
				gd.Passed = gd.Passed && ok
			}
		}
	}
	for _, u := range uuids {
		if per[u] == nil {
			per[u] = &agentv1.GpuDiagnostic{Uuid: u, Checks: []*agentv1.DiagnosticCheck{{Name: "gpu.present", Message: "not tested by DCGM"}}}
			r.Passed = false
		}
	}
	for _, gd := range per {
		r.Gpus = append(r.Gpus, gd)
	}
	sort.Slice(r.Gpus, func(i, j int) bool { return r.Gpus[i].Uuid < r.Gpus[j].Uuid })
	return r, nil
}
