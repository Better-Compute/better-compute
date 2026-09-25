package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/journal"
)

// Instance snapshots (v0.5, sandboxes warm pools): instance.snapshot uploads a running instance's
// disk (and memory) to a presigned URL, as logs.collect does; InstanceSpec.restore_from boots a new
// instance from one after verifying its sha256; a memory snapshot restores only with the same
// runtime and CPU model.

// cpuModel is this host's CPU model (the inventory label cpu.model).
func (a *Agent) cpuModel() string {
	a.invMu.Lock()
	defer a.invMu.Unlock()
	if a.inv == nil || a.inv.Cpu == nil {
		return ""
	}
	return a.inv.Cpu.Model
}

// snapshotDir holds downloaded snapshots (<sha256 hex>) and snapshots being uploaded: on the data
// disk, never in a tmpfs, since they are the size of an instance's disk and memory.
func (a *Agent) snapshotDir() string { return filepath.Join(a.o.DataDir, "snapshots") }

// downloadVerified fetches url into <data_dir>/snapshots/<sha256 hex>, verifying its digest before
// the file becomes visible; an already verified copy is reused. Only https: a snapshot may hold a
// tenant's memory.
func (a *Agent) downloadVerified(ctx context.Context, rawURL string, digest []byte) (string, error) {
	dir := a.snapshotDir()
	dst := filepath.Join(dir, hex.EncodeToString(digest))
	if _, err := os.Stat(dst); err == nil {
		return dst, nil
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return "", errors.New("not an https URL")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	ctx, watch, stop := withProgress(ctx, transferIdle, transferMinBytes, transferMax)
	defer stop()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	client := *a.imageClient()
	client.CheckRedirect = httpsOnly
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET returned %s", resp.Status)
	}
	tmp, err := os.CreateTemp(dir, ".pull-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(tmp, h), progressReader{resp.Body, watch})
	tmp.Close()
	if err != nil {
		return "", err
	}
	if !bytes.Equal(h.Sum(nil), digest) {
		return "", fmt.Errorf("sha256 %x is not the pinned %x", h.Sum(nil), digest)
	}
	return dst, os.Rename(tmp.Name(), dst)
}

// runInstanceSnapshot snapshots a managed instance and PUTs it to the presigned HTTPS URL.
func (a *Agent) runInstanceSnapshot(ctx context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &agentv1.InstanceSnapshotRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	u, err := url.Parse(req.GetUploadUrl())
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return journal.Result{}, invalidPayload(errors.New("upload_url must be a presigned https URL"))
	}
	var rt interface {
		Snapshot(context.Context, string, bool, string, io.Writer) (string, error)
		Name() string
	}
	for _, r := range a.o.Runtimes {
		domains, err := r.List(ctx)
		if err != nil {
			continue
		}
		for _, d := range domains {
			if d.ID == req.GetInstanceId() && d.Managed {
				rt = r
			}
		}
	}
	if rt == nil {
		return journal.Result{}, &KindError{Code: "not-found", Message: "instance " + req.GetInstanceId() + " is not on this host"}
	}
	if err := os.MkdirAll(a.snapshotDir(), 0o700); err != nil {
		return journal.Result{}, err
	}
	tmp, err := os.CreateTemp(a.snapshotDir(), ".upload-*")
	if err != nil {
		return journal.Result{}, err
	}
	a.uploads.Store(filepath.Base(tmp.Name()), true)
	defer a.uploads.Delete(filepath.Base(tmp.Name()))
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	h := sha256.New()
	ctx, watch, stop := withProgress(ctx, transferIdle, transferMinBytes, transferMax)
	defer stop()
	cpu, err := rt.Snapshot(ctx, req.GetInstanceId(), req.GetIncludeMemory(), a.cpuModel(), io.MultiWriter(tmp, h, touchWriter{watch}))
	if err != nil {
		return journal.Result{}, &KindError{Code: "snapshot-failed", Message: err.Error()}
	}
	size, _ := tmp.Seek(0, io.SeekCurrent)
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return journal.Result{}, err
	}
	put, err := http.NewRequestWithContext(ctx, http.MethodPut, u.String(), progressReader{tmp, watch})
	if err != nil {
		return journal.Result{}, err
	}
	put.ContentLength = size
	put.Header.Set("Content-Type", "application/octet-stream")
	for _, hd := range req.GetUploadHeaders() {
		put.Header.Set(hd.GetName(), hd.GetValue())
	}
	// No client timeout: a disk and memory image takes as long as it takes, as long as it moves
	// (withProgress). Redirects stay on https.
	client := *a.imageClient()
	client.CheckRedirect = httpsOnly
	resp, err := client.Do(put)
	if err != nil {
		return journal.Result{}, &KindError{Code: "upload-failed", Message: err.Error()}
	}
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return journal.Result{}, &KindError{Code: "upload-failed", Message: "PUT returned " + resp.Status}
	}
	a.log.Info("instance snapshot", "instance", req.GetInstanceId(), "bytes", size, "memory", req.GetIncludeMemory())
	return succeeded(&agentv1.InstanceSnapshotResult{UploadedBytes: uint64(size), Sha256: h.Sum(nil), Runtime: rt.Name(), CpuModel: cpu})
}

// collectSnapshots deletes downloaded snapshots no spec restores from any more (an instance's
// snapshot goes with the instance), and uploads a crash left behind.
func (a *Agent) collectSnapshots(keep map[string]bool) {
	entries, err := os.ReadDir(a.snapshotDir())
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		// Pulls run on the converger's goroutine, which is the one collecting: none is in flight.
		_, uploading := a.uploads.Load(name)
		stale := (strings.HasPrefix(name, ".upload-") && !uploading) || strings.HasPrefix(name, ".pull-")
		if (len(name) == 64 && !keep[name]) || stale {
			if err := os.Remove(filepath.Join(a.snapshotDir(), name)); err == nil {
				a.log.Info("snapshot file removed", "file", name)
			}
		}
	}
}

// restoreFetch is one snapshot download in the background (restoreFile).
type restoreFetch struct {
	done bool
	err  error
	at   time.Time
}

// restoreRetry is how long a failed snapshot download is reported before it is tried again.
const restoreRetry = time.Minute

// restoreFile returns the verified local copy of a snapshot, downloading it in the background: the
// instances converger never waits on a download (deletes and firewall loads go on meanwhile).
// pending means a download is running; the converger is triggered again when it ends.
func (a *Agent) restoreFile(rawURL string, digest []byte) (path string, pending bool, err error) {
	dst := filepath.Join(a.snapshotDir(), hex.EncodeToString(digest))
	if _, err := os.Stat(dst); err == nil {
		return dst, false, nil
	}
	key := hex.EncodeToString(digest)
	a.restoresMu.Lock()
	defer a.restoresMu.Unlock()
	if a.restores == nil {
		a.restores = map[string]*restoreFetch{}
	}
	if f := a.restores[key]; f != nil {
		if !f.done {
			return "", true, nil
		}
		if f.err != nil && time.Since(f.at) < restoreRetry {
			return "", false, f.err
		}
	}
	f := &restoreFetch{at: time.Now()}
	a.restores[key] = f
	go func() {
		_, err := a.downloadVerified(a.ctx, rawURL, digest)
		a.restoresMu.Lock()
		f.done, f.err, f.at = true, err, time.Now()
		a.restoresMu.Unlock()
		a.triggerConverge()
	}()
	return "", true, nil
}
