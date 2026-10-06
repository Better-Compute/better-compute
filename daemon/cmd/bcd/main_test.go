package main

import (
	"bytes"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/pki"
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

func TestSimNeedsNodesAndAConfiguration(t *testing.T) {
	if code, _, stderr := runBCD("sim", "--nodes", "0"); code != exitUsage || !strings.Contains(stderr, "at least 1") {
		t.Fatalf("bcd sim --nodes 0 = %d, %q", code, stderr)
	}
	missing := filepath.Join(t.TempDir(), "missing.toml")
	if code, _, stderr := runBCD("sim", "--nodes", "3", "--seed", "9", "--config", missing); code != exitFailure || !strings.Contains(stderr, "bcd sim:") {
		t.Fatalf("bcd sim without a configuration = %d, %q", code, stderr)
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

func TestRamdiskNeedsBootParameters(t *testing.T) {
	cmdline := filepath.Join(t.TempDir(), "cmdline")
	_ = os.WriteFile(cmdline, []byte("BOOT_IMAGE=/vmlinuz console=ttyS0\n"), 0o644)
	if code, _, stderr := runBCD("ramdisk", "--cmdline", cmdline, "--data-dir", t.TempDir()); code != exitUsage || !strings.Contains(stderr, "bc.gateway") {
		t.Fatalf("bcd ramdisk without boot parameters = %d, %q", code, stderr)
	}
}

func TestJoinEncryptionKeyFromFileOrWellKnown(t *testing.T) {
	key, _ := pki.GenerateKey()
	jwk, _ := pki.PublicJWK(&key.PublicKey)
	raw, _ := json.Marshal(jwk)
	pin, _ := pki.SPKISHA256(&key.PublicKey)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/compute/.well-known/better-compute" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"name":"better-compute","join":{"encryptionJwk":` + string(raw) + `}}`))
	}))
	defer srv.Close()
	prev := wellKnownClient
	wellKnownClient = srv.Client()
	defer func() { wellKnownClient = prev }()
	dir := t.TempDir()
	missing := filepath.Join(dir, "join-encryption.jwk")
	if got, err := joinEncryptionKey(missing, srv.URL+"/api/compute", pin); err != nil || !got.Equal(&key.PublicKey) {
		t.Fatalf("well-known key = %v", err)
	}
	other, _ := pki.GenerateKey()
	otherPin, _ := pki.SPKISHA256(&other.PublicKey)
	if _, err := joinEncryptionKey(missing, srv.URL+"/api/compute", otherPin); err == nil {
		t.Fatal("a well-known key that does not match the pin was used")
	}
	if _, err := joinEncryptionKey(missing, "ftp://insecure", pin); err == nil {
		t.Fatal("a non-https control plane was trusted")
	}
	_ = os.WriteFile(missing, raw, 0o644)
	if got, err := joinEncryptionKey(missing, "", pin); err != nil || !got.Equal(&key.PublicKey) {
		t.Fatalf("file key = %v", err)
	}
}

// joinedState stores an identity in dir, as a completed join leaves it.
func joinedState(t *testing.T, dir, nodeID, siteID string) {
	t.Helper()
	key, _ := pki.GenerateKey()
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: nodeID}, NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	if err := agent.SaveState(dir, &agent.State{NodeID: nodeID, SiteID: siteID, Role: "node", Chain: [][]byte{der}, NotAfter: template.NotAfter}); err != nil {
		t.Fatal(err)
	}
	if err := pki.SavePrivateKey(filepath.Join(dir, agent.KeyFile), key); err != nil {
		t.Fatal(err)
	}
}

func TestJoinBootstrapsItsConfigurationFromTheWellKnownDocument(t *testing.T) {
	encKey, _ := pki.GenerateKey()
	jwk, _ := pki.PublicJWK(&encKey.PublicKey)
	rawJWK, _ := json.Marshal(jwk)
	encPin, _ := pki.SPKISHA256(&encKey.PublicKey)
	pin := func(digest []byte) string { return "sha256/" + base64.StdEncoding.EncodeToString(digest) }
	signPin := pin(bytes.Repeat([]byte{9}, 32))
	caPin := pin(bytes.Repeat([]byte{7}, 32))
	withGateway := false
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		doc := map[string]any{
			"name": "better-compute",
			"join": map[string]any{"encryptionJwk": json.RawMessage(rawJWK), "encryptionKeyPin": pin(encPin), "signingKeyPin": signPin},
		}
		if withGateway {
			doc["gateway"] = map[string]any{"url": "https://gw.example.com", "serverName": "gw.internal", "servingCaPin": caPin}
		}
		_ = json.NewEncoder(w).Encode(doc)
	}))
	defer srv.Close()
	prevClient := wellKnownClient
	wellKnownClient = srv.Client()
	defer func() { wellKnownClient = prevClient }()
	bootstrapDataDir := t.TempDir()

	etc := filepath.Join(t.TempDir(), "etc", "bcd")
	file := filepath.Join(etc, "config.toml")
	tokenFile := filepath.Join(t.TempDir(), "join-token")
	_ = os.WriteFile(tokenFile, []byte("bcjt_01k5w0000000000000000000000.secret\n"), 0o600)
	pins := []string{"--serving-ca-pin", caPin, "--join-signing-pin", signPin, "--join-encryption-pin", pin(encPin), "--data-dir", bootstrapDataDir}
	join := func(nodeID string, extra ...string) (int, string, string) {
		args := append([]string{"join", "--config", file, "--server", srv.URL, "--token-file", tokenFile, "--node-id", nodeID}, pins...)
		return runBCD(append(args, extra...)...)
	}

	// A control plane that does not say where its gateway is cannot bootstrap a machine.
	if code, _, stderr := join("node_1"); code != exitFailure || !strings.Contains(stderr, "does not publish its gateway") {
		t.Fatalf("join without a published gateway = %d, %q", code, stderr)
	}
	withGateway = true
	// The install's pins win over the document: one that differs refuses the join, and so does a
	// partial set (only a development build joins with none at all).
	other := pin(bytes.Repeat([]byte{3}, 32))
	if code, _, stderr := join("node_1", "--join-encryption-pin", other); code != exitFailure || !strings.Contains(stderr, "does not match --join-encryption-pin") {
		t.Fatalf("join with a substituted encryption key = %d, %q", code, stderr)
	}
	if code, _, stderr := runBCD("join", "--config", file, "--server", srv.URL, "--token-file", tokenFile, "--serving-ca-pin", caPin); code != exitFailure || !strings.Contains(stderr, "needs --serving-ca-pin, --join-signing-pin and --join-encryption-pin") {
		t.Fatalf("join with a partial set of pins = %d, %q", code, stderr)
	}
	// A redirect is never followed.
	redirect := httptest.NewTLSServer(http.RedirectHandler(srv.URL+"/.well-known/better-compute", http.StatusFound))
	defer redirect.Close()
	if code, _, stderr := runBCD(append([]string{"join", "--config", file, "--server", redirect.URL, "--token-file", tokenFile}, pins...)...); code != exitFailure || !strings.Contains(stderr, "302") {
		t.Fatalf("join through a redirect = %d, %q", code, stderr)
	}
	if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a configuration was written before joining")
	}

	// A machine that already joined (a re-run after a reboot) succeeds without spending a token, writes
	// the configuration the node agent reads and removes the token file.
	joinedState(t, bootstrapDataDir, "node_1", "site_a")
	if code, _, stderr := join("node_2"); code != exitFailure || !strings.Contains(stderr, "already joined as node_1") {
		t.Fatalf("join as another node = %d, %q", code, stderr)
	}
	if code, stdout, stderr := join("node_1"); code != exitOK || !strings.Contains(stdout, "already joined as node_1") {
		t.Fatalf("re-join = %d, %q %q", code, stdout, stderr)
	}
	cfg, err := config.Load(file)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GatewayURL != "https://gw.example.com" || cfg.GatewayServerName != "gw.internal" || cfg.Site != "site_a" ||
		cfg.ServingCASPKIPin != caPin || cfg.JoinSigningKeyPin != signPin || cfg.JoinEncryptionKeyPin != pin(encPin) || cfg.DataDir != bootstrapDataDir {
		t.Fatalf("bootstrapped configuration = %+v", cfg)
	}
	if info, err := os.Stat(file); err != nil || (goruntime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Fatalf("config.toml mode = %v, %v", info, err)
	}
	if got, err := os.ReadFile(filepath.Join(etc, joinKeyFile)); err != nil || !bytes.Equal(got, rawJWK) {
		t.Fatalf("join-encryption.jwk = %q, %v", got, err)
	}
	if _, err := os.Stat(tokenFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the token file stayed on disk")
	}
	// From now on the written configuration is used; the token file is gone and nothing is needed.
	if code, stdout, stderr := join("node_1"); code != exitOK || !strings.Contains(stdout, "already joined") {
		t.Fatalf("second re-join = %d, %q %q", code, stdout, stderr)
	}
}

// config.toml: 0600, or 0640 for the --unprivileged install (root:bcd, read by bcd node) are fine;
// anything others can read, or its group can write, is a warning.
func TestPermissionWarning(t *testing.T) {
	if goruntime.GOOS == "windows" {
		t.Skip("no mode bits")
	}
	file := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(file, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	for mode, warn := range map[os.FileMode]bool{0o600: false, 0o640: false, 0o644: true, 0o660: true, 0o604: true} {
		if err := os.Chmod(file, mode); err != nil {
			t.Fatal(err)
		}
		if got := permissionWarning(file) != ""; got != warn {
			t.Errorf("mode %04o: warning %v, want %v", mode, got, warn)
		}
	}
}