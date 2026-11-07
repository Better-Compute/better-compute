package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/cloud/aws"
)

// fakeCloud points cloudIMDS at a fake root whose DMI says vendor, and an IMDS that counts requests.
func fakeCloud(t *testing.T, vendor string) *atomic.Int32 {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "sys", "class", "dmi", "id")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sys_vendor"), []byte(vendor+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	prev := cloudIMDS
	cloudIMDS = func() *aws.Client { return &aws.Client{Root: root, Endpoint: srv.URL} }
	t.Cleanup(func() { cloudIMDS = prev })
	return &hits
}

func joinConfig(t *testing.T) string {
	dir := t.TempDir()
	pin := "sha256/" + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	text := "gateway_url = \"https://gw.example.com\"\nsite = \"lab\"\ndata_dir = \"" + filepath.ToSlash(dir) + "\"\n" +
		"serving_ca_spki_pin = \"" + pin + "\"\njoin_signing_key_pin = \"" + pin + "\"\njoin_encryption_key_pin = \"" + pin + "\"\n"
	file := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestJoinCloudIidRefusesOffEC2WithoutProbing(t *testing.T) {
	hits := fakeCloud(t, "QEMU")
	file := joinConfig(t)
	code, _, stderr := runBCD("join", "--config", file, "--attestor", "cloud-iid")
	if code != exitFailure || !strings.Contains(stderr, "needs an Amazon EC2 instance") {
		t.Fatalf("bcd join --attestor cloud-iid off EC2 = %d, %q", code, stderr)
	}
	if hits.Load() != 0 {
		t.Fatalf("%d metadata requests off EC2", hits.Load())
	}
}

func TestJoinCloudIidTakesNoToken(t *testing.T) {
	fakeCloud(t, "Amazon EC2")
	file := joinConfig(t)
	token := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(token, []byte("bcjt_x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := runBCD("join", "--config", file, "--attestor", "cloud-iid", "--token-file", token)
	if code != exitUsage || !strings.Contains(stderr, "drop --token-file") {
		t.Fatalf("bcd join --attestor cloud-iid --token-file = %d, %q", code, stderr)
	}
	// BCD_JOIN_TOKEN is not read (nor kept in the environment) for a cloud-iid join.
	t.Setenv("BCD_JOIN_TOKEN", "bcjt_join_01k5w0000000000000000000000."+strings.Repeat("A", 43))
	_, _, _ = runBCD("join", "--config", file, "--attestor", "cloud-iid")
	if v, ok := os.LookupEnv("BCD_JOIN_TOKEN"); ok && v != "" {
		t.Fatal("BCD_JOIN_TOKEN still set after a cloud-iid join")
	}
}

func TestCloudHostOnlyOnEC2(t *testing.T) {
	hits := fakeCloud(t, "QEMU")
	if cloudHost() != nil || hits.Load() != 0 {
		t.Fatal("a cloud host off EC2")
	}
	fakeCloud(t, "Amazon EC2")
	if cloudHost() == nil {
		t.Fatal("no cloud host on EC2")
	}
}

func TestEC2HostWatchesSpotNoticesOnlyOnSpot(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "sys", "class", "dmi", "id")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "sys_vendor"), []byte("Amazon EC2\n"), 0o644)
	var spotReads atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest/api/token":
			_, _ = w.Write([]byte("tok"))
		case "/latest/meta-data/spot/instance-action":
			spotReads.Add(1)
			_, _ = w.Write([]byte(`{"action":"hibernate","time":"2026-11-05T10:02:00Z"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	prevIMDS, prevInterval := cloudIMDS, spotInterval
	cloudIMDS = func() *aws.Client { return &aws.Client{Root: root, Endpoint: srv.URL} }
	spotInterval = 5 * time.Millisecond
	defer func() { cloudIMDS, spotInterval = prevIMDS, prevInterval }()

	host := cloudHost()
	// On-demand: returns at once, never reads the spot path.
	host.WatchInterruptions(context.Background(), &agentv1.CloudSection{Lifecycle: "on-demand"}, func(*agent.Interruption) {
		t.Fatal("a notice on an on-demand instance")
	})
	if spotReads.Load() != 0 {
		t.Fatal("the spot path was read on an on-demand instance")
	}
	ctx, cancel := context.WithCancel(context.Background())
	got := make(chan *agent.Interruption, 1)
	go host.WatchInterruptions(ctx, &agentv1.CloudSection{Lifecycle: "spot"}, func(n *agent.Interruption) { got <- n })
	defer cancel()
	select {
	case n := <-got:
		if n == nil || n.Action != "hibernate" || !n.Deadline.Equal(time.Date(2026, 11, 5, 10, 2, 0, 0, time.UTC)) {
			t.Fatalf("interruption %+v", n)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no interruption from the spot notice")
	}
}

// On EC2, 169.254.169.254 (and fd00:ec2::254) is AWS's metadata service: bcd's own guest metadata
// service bound there would make it a local address, so the host's cloud section, spot watch and
// cloud-iid join would read bcd's instead and get nothing. bcd node refuses to start (fail closed).
func TestNodeRefusesGuestMetadataOnTheAWSAddressOnEC2(t *testing.T) {
	for _, listen := range []string{"169.254.169.254:80", "[fd00:ec2::254]:80"} {
		hits := fakeCloud(t, "Amazon EC2")
		file := joinConfig(t)
		appendFile(t, file, "\n[imds]\nlisten = \""+listen+"\"\n")
		code, _, stderr := runBCD("node", "--config", file)
		if code != exitFailure || !strings.Contains(stderr, "EC2's own instance metadata service") {
			t.Fatalf("bcd node with [imds] listen %s on EC2 = %d, %q", listen, code, stderr)
		}
		if hits.Load() != 0 {
			t.Fatalf("%d metadata requests", hits.Load())
		}
	}
	// Off EC2, and on EC2 with another address, the listen is not refused for this.
	for _, tc := range []struct{ vendor, listen string }{{"QEMU", "169.254.169.254:80"}, {"Amazon EC2", "10.0.0.1:80"}} {
		fakeCloud(t, tc.vendor)
		file := joinConfig(t)
		appendFile(t, file, "\n[imds]\nlisten = \""+tc.listen+"\"\n")
		if _, _, stderr := runBCD("node", "--config", file); strings.Contains(stderr, "EC2's own instance metadata service") {
			t.Fatalf("%s %s refused: %q", tc.vendor, tc.listen, stderr)
		}
	}
}

func TestCloudMetadataAddrsOnlyOnEC2(t *testing.T) {
	fakeCloud(t, "QEMU")
	if got := cloudMetadata(); got != nil {
		t.Fatalf("metadata addresses off EC2: %v", got)
	}
	fakeCloud(t, "Amazon EC2")
	if got := strings.Join(cloudMetadata(), ","); got != "169.254.169.254,fd00:ec2::254" {
		t.Fatalf("metadata addresses on EC2: %q", got)
	}
}

func appendFile(t *testing.T, file, text string) {
	t.Helper()
	f, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(text); err != nil {
		t.Fatal(err)
	}
}
