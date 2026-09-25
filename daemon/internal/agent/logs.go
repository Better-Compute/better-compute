package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/url"
	"os"
	osexec "os/exec"
	"sort"
	"strconv"
	"strings"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"github.com/better-compute/better-compute/daemon/internal/support"
)

// defaultLookback is how far back logs.collect reads when the request leaves it unset.
const defaultLookback = 24 * time.Hour

// journalLogs reads a systemd unit's journal (journalctl), the RealHost default.
func journalLogs(ctx context.Context, unit string, since time.Duration) ([]byte, error) {
	cmd := osexec.CommandContext(ctx, "journalctl", "--no-pager", "-o", "short-iso", "-u", unit,
		"--since", fmt.Sprintf("-%ds", int(since.Seconds())))
	return cmd.Output()
}

// Logs reads a unit's logs (journalctl unless LogsFunc is set).
func (h *RealHost) Logs(ctx context.Context, unit string, since time.Duration) ([]byte, error) {
	if h.LogsFunc != nil {
		return h.LogsFunc(ctx, unit, since)
	}
	return journalLogs(ctx, unit, since)
}

// runLogsCollect gathers the requested units' logs (and, with support_bundle, the agent's state),
// removes every secret, truncates oldest first to max_bytes, and PUTs the bundle to the presigned
// HTTPS URL: logs never ride the session (P8).
func (a *Agent) runLogsCollect(ctx context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &agentv1.LogsCollectRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	u, err := url.Parse(req.GetUploadUrl())
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return journal.Result{}, invalidPayload(fmt.Errorf("upload_url must be a presigned https URL"))
	}
	units := req.GetUnits()
	if len(units) == 0 {
		units = []string{"bcd.service"}
	}
	since := time.Duration(req.GetLookbackSeconds()) * time.Second
	if since <= 0 {
		since = defaultLookback
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, "bcd %s node=%s boot=%s collected=%s\n", a.o.Version, a.NodeID(), a.bootID, a.serverNow().UTC().Format(time.RFC3339))
	fmt.Fprintf(&b, "lookback=%s units=%s\n", since, strings.Join(units, ","))
	for _, unit := range units {
		lctx, cancel := context.WithTimeout(ctx, time.Minute)
		out, err := a.host.Logs(lctx, unit, since)
		cancel()
		fmt.Fprintf(&b, "==> %s <==\n", unit)
		if err != nil {
			fmt.Fprintf(&b, "(unavailable: %v)\n", err)
		}
		b.Write(out)
		if len(out) > 0 && out[len(out)-1] != '\n' {
			b.WriteByte('\n')
		}
	}
	if req.GetSupportBundle() {
		b.WriteString(a.supportSummary())
	}
	// The environment's join token (if a process still has it) is a known value too.
	text, _ := support.Redact(b.String(), os.Getenv("BCD_JOIN_TOKEN"))
	bundle := []byte(text)
	truncated := false
	if max := req.GetMaxBytes(); max > 0 && uint64(len(bundle)) > max {
		bundle = bundle[uint64(len(bundle))-max:]
		if i := bytes.IndexByte(bundle, '\n'); i >= 0 && i+1 < len(bundle) {
			bundle = bundle[i+1:] // start on a whole line
		}
		truncated = true
	}
	put, err := http.NewRequestWithContext(ctx, http.MethodPut, u.String(), bytes.NewReader(bundle))
	if err != nil {
		return journal.Result{}, err
	}
	put.Header.Set("Content-Type", "text/plain")
	for _, h := range req.GetUploadHeaders() {
		put.Header.Set(h.GetName(), h.GetValue())
	}
	resp, err := a.uploadClient().Do(put)
	if err != nil {
		return journal.Result{}, &KindError{Code: "upload-failed", Message: err.Error()}
	}
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return journal.Result{}, &KindError{Code: "upload-failed", Message: "PUT returned " + resp.Status}
	}
	sum := sha256.Sum256(bundle)
	return succeeded(&agentv1.LogsCollectResult{
		UploadedBytes: uint64(len(bundle)),
		Sha256:        sum[:],
		Truncated:     truncated,
		ContentType:   "text/plain",
	})
}

func (a *Agent) uploadClient() *http.Client {
	if a.o.HTTPClient != nil {
		return a.o.HTTPClient
	}
	return &http.Client{Timeout: 5 * time.Minute}
}

// supportSummary is the support-bundle section: journal metadata, the command table, the event
// backlog, the applied spec and inventory hashes (never keys or certificates).
func (a *Agent) supportSummary() string {
	var b strings.Builder
	b.WriteString("==> support <==\n")
	a.mu.Lock()
	meta, _ := a.j.Meta()
	stats, _ := a.j.EventStats()
	commands, _ := a.j.Commands()
	fmt.Fprintf(&b, "journal=%s epoch=%d applied=%d observed=%d eventSeq=%d pendingEvents=%d droppedMetrics=%d\n",
		meta.JournalID, meta.LastEpoch, a.applied, a.observed, meta.EventSeq, stats.Count, stats.DroppedMetrics)
	fmt.Fprintf(&b, "certificate notAfter=%s role=%s site=%s trustVersion=%d\n",
		a.state.NotAfter.UTC().Format(time.RFC3339), a.state.Role, a.state.SiteID, a.state.TrustVersion)
	a.mu.Unlock()
	for _, c := range commands {
		outcome := ""
		if c.Result != nil {
			outcome = string(c.Result.Outcome) + " " + c.Result.Reason
		}
		fmt.Fprintf(&b, "command %s %s %s %s\n", c.ID, c.Kind, c.State, strings.TrimSpace(outcome))
	}
	hashes := a.inventoryHashes()
	names := make([]string, 0, len(hashes))
	for n := range hashes {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fmt.Fprintf(&b, "inventory %s %x\n", n, hashes[n])
	}
	b.WriteString("pid=" + strconv.Itoa(os.Getpid()) + "\n")
	return b.String()
}
