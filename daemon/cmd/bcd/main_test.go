package main

import (
	"bytes"
	"encoding/base64"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func runBCD(args ...string) (code int, stdout, stderr string) {
	var out, errOut bytes.Buffer
	code = run(args, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestVersion(t *testing.T) {
	for _, args := range [][]string{{"version"}, {"--version"}} {
		code, stdout, _ := runBCD(args...)
		if code != exitOK || !strings.HasPrefix(stdout, "bcd "+version+" ") {
			t.Fatalf("bcd %v = %d, %q", args, code, stdout)
		}
	}
}

func TestHelpAndUsage(t *testing.T) {
	code, stdout, _ := runBCD("help")
	if code != exitOK || !strings.Contains(stdout, "Commands") {
		t.Fatalf("bcd help = %d, %q", code, stdout)
	}
	for _, c := range commands() {
		if !strings.Contains(stdout, "  "+c.name+" ") {
			t.Errorf("help does not list %s", c.name)
		}
	}
	if code, _, stderr := runBCD(); code != exitUsage || !strings.Contains(stderr, "Usage") {
		t.Fatalf("bcd = %d, %q; want usage and exit 2", code, stderr)
	}
	if code, _, stderr := runBCD("node", "-h"); code != exitOK || !strings.Contains(stderr, "-config") {
		t.Fatalf("bcd node -h = %d, %q", code, stderr)
	}
}

func TestUnimplementedModesExitTwo(t *testing.T) {
	phases := map[string]string{
		"site":    "v0.2",
		"ramdisk": "v0.2",
		"sim":     "v0.4",
	}
	for name, phase := range phases {
		code, _, stderr := runBCD(name)
		if code != exitUsage || !strings.Contains(stderr, "NOT_IMPLEMENTED: bcd "+name+" arrives in "+phase) {
			t.Errorf("bcd %s = %d, %q; want exit 2 naming %s", name, code, stderr, phase)
		}
	}
	// Flags still parse first.
	if code, _, stderr := runBCD("sim", "--nodes", "3", "--seed", "9"); code != exitUsage || !strings.Contains(stderr, "v0.4") {
		t.Fatalf("bcd sim --nodes 3 = %d, %q", code, stderr)
	}
	if code, _, _ := runBCD("node", "--no-such-flag"); code != exitUsage {
		t.Fatalf("bcd node --no-such-flag = %d, want 2", code)
	}
}

func TestArgumentsAreNeverEchoed(t *testing.T) {
	const token = "bcjt_0123456789.s3cr3t"
	code, stdout, stderr := runBCD("join", token)
	if code != exitUsage || !strings.Contains(stderr, "BCD_JOIN_TOKEN") {
		t.Fatalf("bcd join <token> = %d, %q", code, stderr)
	}
	if strings.Contains(stdout+stderr, token) {
		t.Fatal("bcd join echoed its argument")
	}
	code, stdout, stderr = runBCD(token)
	if code != exitUsage || strings.Contains(stdout+stderr, token) {
		t.Fatalf("bcd <token> = %d and echoed it: %q", code, stderr)
	}
	if code, _, stderr := runBCD("frobnicate"); code != exitUsage || !strings.Contains(stderr, `"frobnicate"`) {
		t.Fatalf("bcd frobnicate = %d, %q", code, stderr)
	}
}

func TestJoinAndNodeNeedAConfiguration(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing.toml")
	for _, name := range []string{"join", "node"} {
		if code, _, stderr := runBCD(name, "--config", missing); code != exitFailure || !strings.Contains(stderr, "bcd "+name+":") {
			t.Errorf("bcd %s without a config = %d, %q", name, code, stderr)
		}
	}
	// A node that never joined says so.
	dir := t.TempDir()
	pin := "sha256/" + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	text := "gateway_url = \"https://gw.example.com\"\nsite = \"lab\"\ndata_dir = \"" + filepath.ToSlash(dir) + "\"\n" +
		"serving_ca_spki_pin = \"" + pin + "\"\njoin_signing_key_pin = \"" + pin + "\"\njoin_encryption_key_pin = \"" + pin + "\"\n"
	file := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	if code, _, stderr := runBCD("node", "--config", file); code != exitFailure || !strings.Contains(stderr, "has not joined") {
		t.Fatalf("bcd node before join = %d, %q", code, stderr)
	}
	// bcd join without a token is a usage error, and one that is not a token is refused unechoed.
	t.Setenv("BCD_JOIN_TOKEN", "")
	stdin = strings.NewReader("")
	if code, _, stderr := runBCD("join", "--config", file); code != exitUsage || !strings.Contains(stderr, "no join token") {
		t.Fatalf("bcd join without a token = %d, %q", code, stderr)
	}
	stdin = strings.NewReader("not-a-token\n")
	if code, _, stderr := runBCD("join", "--config", file); code != exitUsage || strings.Contains(stderr, "not-a-token") {
		t.Fatalf("bcd join with garbage = %d, %q", code, stderr)
	}
}

func TestDoctor(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "missing.toml")
	code, stdout, _ := runBCD("doctor", "--config", missing)
	if code != exitFailure || !strings.Contains(stdout, "fail  config") {
		t.Fatalf("doctor without a config = %d, %q", code, stdout)
	}

	// The gateway check dials it: a local listener stands in.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	pin := "sha256/" + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	text := "gateway_url = \"https://" + ln.Addr().String() + "\"\nsite = \"lab\"\ndata_dir = \"" + filepath.ToSlash(dir) + "\"\n" +
		"serving_ca_spki_pin = \"" + pin + "\"\njoin_signing_key_pin = \"" + pin + "\"\njoin_encryption_key_pin = \"" + pin + "\"\n"
	file := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	code, stdout, _ = runBCD("doctor", "--config", file)
	if !strings.Contains(stdout, "ok    gateway") || !strings.Contains(stdout, "has not joined") {
		t.Fatalf("doctor host checks: %q", stdout)
	}
	// NVML is never built into the skeleton and host inventory arrives in v0.1: warnings, not failures.
	if code != exitOK || !strings.Contains(stdout, "ok    config") || !strings.Contains(stdout, "warn  nvml") {
		t.Fatalf("doctor = %d, %q", code, stdout)
	}
	if !strings.Contains(stdout, "hardware  "+hardwareBackend) {
		t.Fatalf("doctor does not report the %s backend: %q", hardwareBackend, stdout)
	}
}

func TestStatusWithoutAnAgent(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "bcd.sock")
	if code, _, stderr := runBCD("status", "--socket", socket); code != exitFailure || !strings.Contains(stderr, "not running") {
		t.Fatalf("bcd status without an agent = %d, %q", code, stderr)
	}
}
