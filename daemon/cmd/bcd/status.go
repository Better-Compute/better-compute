package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/agent"
)

// serveStatus answers `bcd status` on the node agent's root-only unix socket (0600 in a 0700 dir).
// It returns a stop function; failures are logged, never fatal: the agent runs without it.
func serveStatus(path string, a *agent.Agent, log *slog.Logger) func() {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		log.Warn("status socket unavailable", "error", err.Error())
		return func() {}
	}
	_ = os.Remove(path) // a stale socket of an earlier process
	ln, err := net.Listen("unix", path)
	if err != nil {
		log.Warn("status socket unavailable", "error", err.Error())
		return func() {}
	}
	_ = os.Chmod(path, 0o600)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(a.Status())
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		_ = os.Remove(path)
	}
}

func runStatus(fs *flag.FlagSet, stdout, stderr io.Writer) int {
	path := fs.Lookup("socket").Value.String()
	asJSON := fs.Lookup("json").Value.String() == "true"
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", path)
		}},
	}
	resp, err := client.Get("http://bcd/status")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), "no such file") || strings.Contains(err.Error(), "connection refused") {
			fmt.Fprintf(stderr, "bcd status: the node agent is not running (no socket at %s)\n", path)
		} else {
			fmt.Fprintf(stderr, "bcd status: %v\n", err)
		}
		return exitFailure
	}
	defer resp.Body.Close()
	var st agent.Status
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&st); err != nil {
		fmt.Fprintf(stderr, "bcd status: %v\n", err)
		return exitFailure
	}
	if asJSON {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(st)
		return exitOK
	}
	connected := "disconnected"
	if st.Connected {
		connected = fmt.Sprintf("connected (epoch %d, clock offset %d ms)", st.Epoch, st.ClockOffsetMs)
	}
	fmt.Fprintf(stdout, "node       %s (site %s, role %s)\n", st.NodeID, st.SiteID, st.Role)
	fmt.Fprintf(stdout, "bcd        %s, boot %s\n", st.Version, st.BootID)
	fmt.Fprintf(stdout, "session    %s\n", connected)
	fmt.Fprintf(stdout, "spec       applied %d, observed %d\n", st.AppliedGeneration, st.ObservedGeneration)
	for _, s := range st.Sections {
		line := fmt.Sprintf("  %-10s %s", s.Section, strings.TrimPrefix(s.State, "SECTION_STATE_"))
		if s.Reason != "" {
			line += " " + s.Reason
		}
		if s.Message != "" {
			line += ": " + s.Message
		}
		fmt.Fprintln(stdout, line)
	}
	fmt.Fprintf(stdout, "commands   %d running, %d waiting for a spec\n", len(st.Running), len(st.Deferred))
	fmt.Fprintf(stdout, "events     %d unacked, %d waiting, %d metrics dropped\n", st.PendingEvents, st.WaitingEvents, st.DroppedMetrics)
	signing := "not enforced"
	if st.CommandSigning {
		signing = "enforced"
	}
	fmt.Fprintf(stdout, "identity   certificate until %s, trust bundle v%d, signed intent %s\n",
		st.CertificateNotAfter.UTC().Format(time.RFC3339), st.TrustVersion, signing)
	return exitOK
}
