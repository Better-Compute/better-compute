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

// downloadVerified fetches url into <data_dir>/snapshots/<sha256 hex>, verifying its digest before
// the file becomes visible; an already verified copy is reused.
func (a *Agent) downloadVerified(ctx context.Context, rawURL string, digest []byte) (string, error) {
	dir := filepath.Join(a.o.DataDir, "snapshots")
	dst := filepath.Join(dir, hex.EncodeToString(digest))
	if _, err := os.Stat(dst); err == nil {
		return dst, nil
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return "", errors.New("not an http(s) URL")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := a.imageClient().Do(req)
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
	_, err = io.Copy(io.MultiWriter(tmp, h), resp.Body)
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
	tmp, err := os.CreateTemp("", "bcd-snapshot-*")
	if err != nil {
		return journal.Result{}, err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	h := sha256.New()
	cpu, err := rt.Snapshot(ctx, req.GetInstanceId(), req.GetIncludeMemory(), a.cpuModel(), io.MultiWriter(tmp, h))
	if err != nil {
		return journal.Result{}, &KindError{Code: "snapshot-failed", Message: err.Error()}
	}
	size, _ := tmp.Seek(0, io.SeekCurrent)
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return journal.Result{}, err
	}
	put, err := http.NewRequestWithContext(ctx, http.MethodPut, u.String(), tmp)
	if err != nil {
		return journal.Result{}, err
	}
	put.ContentLength = size
	put.Header.Set("Content-Type", "application/octet-stream")
	for _, hd := range req.GetUploadHeaders() {
		put.Header.Set(hd.GetName(), hd.GetValue())
	}
	resp, err := a.uploadClient().Do(put)
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
