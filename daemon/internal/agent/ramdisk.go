package agent

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/pki"
)

// The ramdisk's commissioning and deploy kinds (PLAN.md §3.5, §11.1), under metal's names
// (packages/metal/src/commands.ts): disk.wipe, deploy.image, boot.kexec and diag.dcgm. Disks are
// addressed by WWN or serial, never by kernel name (names are not stable across boots).

// wipeSpan is how much of each end of a disk a quick wipe zeroes: partition tables (GPT keeps a
// backup at the end), filesystem, LVM, RAID and ZFS signatures all live there.
const wipeSpan = 1 << 20

// minRootDisk is the smallest disk a default root-disk choice considers.
const minRootDisk = 4 << 30

// diskID is a disk's stable id: its WWN, else its serial.
func diskID(d *inventory.Disk) string {
	if d.Wwn != "" {
		return d.Wwn
	}
	return d.Serial
}

func (a *Agent) disks() ([]*inventory.Disk, error) {
	if _, err := a.collect(true); err != nil {
		return nil, err
	}
	a.invMu.Lock()
	defer a.invMu.Unlock()
	if a.inv == nil || a.inv.Disks == nil {
		return nil, nil
	}
	return append([]*inventory.Disk(nil), a.inv.Disks.Disks...), nil
}

// ---- disk.wipe ---------------------------------------------------------------------------------

func (a *Agent) runDiskWipe(ctx context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &agentv1.WipeRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	mode := req.GetMode()
	if mode == agentv1.WipeMode_WIPE_MODE_UNSPECIFIED {
		mode = agentv1.WipeMode_WIPE_MODE_QUICK
	}
	all, err := a.disks()
	if err != nil {
		return journal.Result{}, &KindError{Code: "inventory-failed", Message: err.Error()}
	}
	var targets []*inventory.Disk
	if len(req.GetDisks()) == 0 {
		for _, d := range all {
			if !d.Removable {
				targets = append(targets, d)
			}
		}
	} else {
		for _, want := range req.GetDisks() {
			var found *inventory.Disk
			for _, d := range all {
				if d.Wwn == want || d.Serial == want {
					found = d
				}
			}
			if found == nil {
				return journal.Result{}, &KindError{Code: "disk-missing", Message: want + " is not present"}
			}
			targets = append(targets, found)
		}
	}
	if len(targets) == 0 {
		return journal.Result{}, &KindError{Code: "disk-missing", Message: "no disk to wipe"}
	}
	result := &agentv1.WipeResult{Mode: mode}
	failed := false
	for _, d := range targets {
		if ctx.Err() != nil {
			return journal.Result{}, ctx.Err()
		}
		w := &agentv1.DiskWipe{Id: diskID(d)}
		switch mode {
		case agentv1.WipeMode_WIPE_MODE_QUICK:
			w.Method = "quick"
			if err := quickWipe(a.host.Path("/dev/"+d.Name), d.SizeBytes); err != nil {
				w.Message = err.Error()
			} else if ok, err := zeroedEnds(a.host.Path("/dev/"+d.Name), d.SizeBytes); err != nil {
				w.Message = err.Error()
			} else {
				w.Verified = ok
			}
		default:
			method, verified, err := a.host.SecureErase(ctx, d, mode)
			w.Method, w.Verified = method, verified
			if err != nil {
				w.Message = err.Error()
			}
		}
		if !w.Verified {
			failed = true
		}
		a.log.Info("disk wiped", "disk", w.Id, "method", w.Method, "verified", w.Verified)
		result.Disks = append(result.Disks, w)
	}
	sort.Slice(result.Disks, func(i, j int) bool { return result.Disks[i].Id < result.Disks[j].Id })
	r, err := succeeded(result)
	if err == nil && failed {
		// The §11.1 invariant: `ready` follows only a verified wipe. The result still says what happened.
		r.Outcome, r.Reason, r.Message = journal.OutcomeFailed, "wipe-unverified", "a disk could not be wiped and verified"
	}
	return r, err
}

// quickWipe zeroes the first and last wipeSpan bytes of a block device (or disk image).
func quickWipe(path string, size uint64) error {
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	zero := make([]byte, wipeSpan)
	for _, off := range wipeOffsets(size) {
		if _, err := f.WriteAt(zero[:spanAt(off, size)], int64(off)); err != nil {
			return err
		}
	}
	return f.Sync()
}

// zeroedEnds reads the wiped spans back.
func zeroedEnds(path string, size uint64) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	buf := make([]byte, wipeSpan)
	for _, off := range wipeOffsets(size) {
		n := spanAt(off, size)
		if _, err := f.ReadAt(buf[:n], int64(off)); err != nil && !errors.Is(err, io.EOF) {
			return false, err
		}
		if !bytes.Equal(buf[:n], make([]byte, n)) {
			return false, nil
		}
	}
	return true, nil
}

func wipeOffsets(size uint64) []uint64 {
	if size <= wipeSpan {
		return []uint64{0}
	}
	return []uint64{0, size - wipeSpan}
}

func spanAt(off, size uint64) uint64 { return min(uint64(wipeSpan), size-off) }

// ---- deploy.image ------------------------------------------------------------------------------

// pickRootDisk applies RootDiskHint (first non-empty field wins; a hint matching nothing fails), or
// the default: the smallest non-removable disk of at least 4 GiB.
func pickRootDisk(disks []*inventory.Disk, hint *agentv1.RootDiskHint) (*inventory.Disk, error) {
	match := func(pred func(*inventory.Disk) bool, what string) (*inventory.Disk, error) {
		for _, d := range disks {
			if pred(d) {
				return d, nil
			}
		}
		return nil, &KindError{Code: "disk-missing", Message: "no disk matches " + what}
	}
	switch {
	case hint.GetWwn() != "":
		return match(func(d *inventory.Disk) bool { return d.Wwn == hint.GetWwn() }, "wwn "+hint.GetWwn())
	case hint.GetSerial() != "":
		return match(func(d *inventory.Disk) bool { return d.Serial == hint.GetSerial() }, "serial "+hint.GetSerial())
	case hint.GetDevice() != "":
		return match(func(d *inventory.Disk) bool { return "/dev/"+d.Name == hint.GetDevice() || d.Name == hint.GetDevice() }, hint.GetDevice())
	}
	floor := max(hint.GetMinSizeBytes(), minRootDisk)
	var best *inventory.Disk
	for _, d := range disks {
		if d.Removable || d.SizeBytes < floor {
			continue
		}
		if best == nil || d.SizeBytes < best.SizeBytes {
			best = d
		}
	}
	if best == nil {
		return nil, &KindError{Code: "disk-missing", Message: fmt.Sprintf("no non-removable disk of at least %d bytes", floor)}
	}
	return best, nil
}

// runDeployImage streams the image from the site cache through its SHA-256 and decompression
// straight onto the root disk, then installs the user data (fetched with SecretRequest, bound to
// the workflow step). A checksum mismatch zeroes the disk's ends again, so a half-written or
// substituted image can never boot.
func (a *Agent) runDeployImage(ctx context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &agentv1.DeployImageRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	u, err := url.Parse(req.GetUrl())
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return journal.Result{}, invalidPayload(errors.New("url must be an http(s) URL"))
	}
	if len(req.GetSha256()) != sha256.Size {
		return journal.Result{}, invalidPayload(errors.New("sha256 must be 32 bytes"))
	}
	if req.GetFormat() == agentv1.ImageFormat_IMAGE_FORMAT_QCOW2 {
		return journal.Result{}, &KindError{Code: "unsupported-format", Message: "qcow2 cannot be streamed to a disk; publish a raw image"}
	}
	disks, err := a.disks()
	if err != nil {
		return journal.Result{}, &KindError{Code: "inventory-failed", Message: err.Error()}
	}
	disk, err := pickRootDisk(disks, req.GetRootDisk())
	if err != nil {
		return journal.Result{}, err
	}
	start := time.Now()
	resp, err := a.fetchImage(ctx, u.String(), req.GetSha256())
	if err != nil {
		return journal.Result{}, &KindError{Code: "download-failed", Message: err.Error()}
	}
	defer resp.Body.Close()
	hasher := sha256.New()
	var body io.Reader = io.TeeReader(resp.Body, hasher)
	switch req.GetCompression() {
	case agentv1.ImageCompression_IMAGE_COMPRESSION_GZIP:
		gz, err := gzip.NewReader(body)
		if err != nil {
			return journal.Result{}, &KindError{Code: "download-failed", Message: err.Error()}
		}
		body = gz
	case agentv1.ImageCompression_IMAGE_COMPRESSION_ZSTD:
		zr, err := zstd.NewReader(body)
		if err != nil {
			return journal.Result{}, &KindError{Code: "download-failed", Message: err.Error()}
		}
		defer zr.Close()
		body = zr
	}
	device := a.host.Path("/dev/" + disk.Name)
	out, err := os.OpenFile(device, os.O_WRONLY, 0)
	if err != nil {
		return journal.Result{}, &KindError{Code: "disk-write-failed", Message: err.Error()}
	}
	written, copyErr := io.CopyBuffer(out, body, make([]byte, 4<<20))
	// Drain what the decompressor left, so the hash covers every byte of the stored image.
	_, _ = io.Copy(io.Discard, io.TeeReader(resp.Body, hasher))
	syncErr := out.Sync()
	out.Close()
	sum := hasher.Sum(nil)
	if copyErr != nil || syncErr != nil || !bytes.Equal(sum, req.GetSha256()) {
		_ = quickWipe(device, disk.SizeBytes)
		switch {
		case copyErr != nil:
			return journal.Result{}, &KindError{Code: "disk-write-failed", Message: copyErr.Error()}
		case syncErr != nil:
			return journal.Result{}, &KindError{Code: "disk-write-failed", Message: syncErr.Error()}
		}
		return journal.Result{}, &KindError{Code: "checksum-mismatch", Message: "image sha256 " + hex.EncodeToString(sum) + " is not the pinned one"}
	}
	if disk.SizeBytes > 0 && uint64(written) > disk.SizeBytes {
		return journal.Result{}, &KindError{Code: "disk-too-small", Message: fmt.Sprintf("%d bytes do not fit %s", written, diskID(disk))}
	}
	_ = a.host.RereadPartitions(ctx, disk)
	if ref := req.GetUserDataRef(); ref != "" {
		data, err := a.RequestSecret(ctx, ref, pki.SecretBinding{WorkflowID: cmd.WorkflowID, StepID: cmd.StepID})
		if err != nil {
			return journal.Result{}, &KindError{Code: "user-data-unavailable", Message: err.Error()}
		}
		if err := a.host.InstallUserData(ctx, disk, req.GetUserDataKind(), data); err != nil {
			return journal.Result{}, &KindError{Code: "user-data-failed", Message: err.Error()}
		}
	}
	a.mu.Lock()
	a.rootDisk = disk
	a.mu.Unlock()
	a.log.Info("image deployed", "disk", diskID(disk), "bytes", written, "in", time.Since(start).Round(time.Millisecond).String())
	return succeeded(&agentv1.DeployImageResult{
		WrittenBytes: uint64(written),
		Sha256:       sum,
		RootDisk:     diskID(disk),
		DurationMs:   uint32(min(time.Since(start).Milliseconds(), int64(^uint32(0)))),
	})
}

// fetchImage opens the image: from the site cache when it has the digest, else from its source.
func (a *Agent) fetchImage(ctx context.Context, source string, digest []byte) (*http.Response, error) {
	if base := a.o.ImageCache; base != "" {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+"/"+hex.EncodeToString(digest), nil)
		if err == nil {
			if resp, err := a.imageClient().Do(req); err == nil {
				if resp.StatusCode == http.StatusOK {
					a.log.Info("image from the site cache", "sha256", hex.EncodeToString(digest))
					return resp, nil
				}
				resp.Body.Close()
			}
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return nil, err
	}
	resp, err := a.imageClient().Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("GET returned %s", resp.Status)
	}
	return resp, nil
}

func (a *Agent) imageClient() *http.Client {
	if a.o.HTTPClient != nil {
		return a.o.HTTPClient
	}
	return &http.Client{} // images take as long as they take; the command's context bounds it
}

// ---- boot.kexec --------------------------------------------------------------------------------

// runKexec boots the installed OS without POST. Self-terminating: running{boot_id} is journaled
// right before; it completes when the agent rejoins with a new boot and role node.
func (a *Agent) runKexec(ctx context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &agentv1.KexecRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	a.mu.Lock()
	disk := a.rootDisk
	a.mu.Unlock()
	if disk == nil {
		disks, err := a.disks()
		if err != nil {
			return journal.Result{}, &KindError{Code: "inventory-failed", Message: err.Error()}
		}
		if disk, err = pickRootDisk(disks, nil); err != nil {
			return journal.Result{}, err
		}
	}
	if err := a.markRunning(cmd.ID); err != nil {
		return journal.Result{}, err
	}
	a.flush(2 * time.Second)
	a.log.Warn("kexec into the installed OS", "command", cmd.ID, "disk", diskID(disk))
	if err := a.host.Kexec(ctx, disk, req.GetKernelPath(), req.GetInitrdPath(), req.GetKernelCmdline()); err != nil {
		return journal.Result{}, &KindError{Code: "kexec-failed", Message: err.Error()}
	}
	<-ctx.Done()
	return journal.Result{}, ctx.Err()
}

// ---- diag.dcgm ---------------------------------------------------------------------------------

// runDiagDcgm runs the DCGM diagnostic at the requested level (1 seconds … 4 long).
func (a *Agent) runDiagDcgm(ctx context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &agentv1.DiagDcgmRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	level := req.GetLevel()
	if level == 0 {
		level = 1
	}
	if level > 4 {
		return journal.Result{}, invalidPayload(errors.New("level must be 1 to 4"))
	}
	if _, err := a.collect(true); err != nil {
		return journal.Result{}, &KindError{Code: "inventory-failed", Message: err.Error()}
	}
	a.invMu.Lock()
	var gpus []*inventory.Gpu
	if a.inv != nil && a.inv.Gpus != nil {
		gpus = append(gpus, a.inv.Gpus.Gpus...)
	}
	a.invMu.Unlock()
	result, err := a.host.RunDCGM(ctx, level, req.GetGpuUuids(), gpus)
	if err != nil {
		return journal.Result{}, &KindError{Code: "dcgm-failed", Message: err.Error()}
	}
	result.Level = level
	return succeeded(result)
}
