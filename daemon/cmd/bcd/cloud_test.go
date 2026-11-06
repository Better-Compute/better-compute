package main

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

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
