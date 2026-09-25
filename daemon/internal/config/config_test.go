package config

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/journal"
)

var testPin = PinPrefix + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xbc}, 32))

// required returns the five lines the install script always writes.
func required() string {
	return `gateway_url = "https://gw.eu-central.example.com"
site = "fsn1-dc14"
serving_ca_spki_pin = "` + testPin + `"
join_signing_key_pin = "` + testPin + `"
join_encryption_key_pin = "` + testPin + `"
`
}

func TestParseRequiredKeysOnly(t *testing.T) {
	cfg, err := Parse([]byte(required()))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.GatewayURL != "https://gw.eu-central.example.com" || cfg.Site != "fsn1-dc14" {
		t.Fatalf("gateway/site = %q/%q", cfg.GatewayURL, cfg.Site)
	}
	if cfg.ServingCASPKIPin != testPin || cfg.JoinSigningKeyPin != testPin || cfg.JoinEncryptionKeyPin != testPin {
		t.Fatalf("pins not read: %+v", cfg)
	}
	if cfg.DataDir != DefaultDataDir || cfg.SocketPath != DefaultSocketPath {
		t.Fatalf("paths = %q, %q; want the defaults", cfg.DataDir, cfg.SocketPath)
	}
	if cfg.Journal.MaxBytes != journal.DefaultMaxBytes || cfg.Journal.MaxEvents != journal.DefaultMaxEvents {
		t.Fatalf("journal = %+v; want the PLAN.md §6 caps", cfg.Journal)
	}
	if cfg.Log.Level != "info" || !cfg.Log.JSON {
		t.Fatalf("log = %+v; want info, JSON", cfg.Log)
	}
}

func TestParseEverySupportedForm(t *testing.T) {
	text := "\ufeff# written by the install script\r\n" + strings.ReplaceAll(required(), "\n", "\r\n") + `
data_dir = '/srv/bcd'   # a literal string
socket_path = "/run/bcd/\u0062cd.sock"

[journal]  # lowered caps
max_bytes = 1_048_576 # 1 MiB
max_events = +500

[log]
level = "debug"
json = false
`
	cfg, err := Parse([]byte(text))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.DataDir != "/srv/bcd" {
		t.Errorf("data_dir = %q", cfg.DataDir)
	}
	if cfg.SocketPath != "/run/bcd/bcd.sock" {
		t.Errorf("socket_path = %q", cfg.SocketPath)
	}
	if cfg.Journal.MaxBytes != 1048576 || cfg.Journal.MaxEvents != 500 {
		t.Errorf("journal = %+v", cfg.Journal)
	}
	if cfg.Log.Level != "debug" || cfg.Log.JSON {
		t.Errorf("log = %+v", cfg.Log)
	}
}

func TestParseRejectsWithLineNumbers(t *testing.T) {
	// Lines 1-5 are required(); the appended text starts on line 6.
	cases := []struct {
		name string
		text string
		line int
		want string
	}{
		{"unknown key", "colour = \"red\"\n", 6, "unknown key colour"},
		{"unknown section", "[gpu]\n", 6, "unknown section [gpu]"},
		{"duplicate key", "site = \"again\"\n", 6, "site appears twice"},
		{"duplicate section", "[log]\nlevel = \"info\"\n[log]\n", 8, "section [log] appears twice"},
		{"wrong type", "[journal]\nmax_events = \"10\"\n", 7, "journal.max_events must be an integer"},
		{"bool as string", "[log]\njson = \"yes\"\n", 7, "log.json must be true or false"},
		{"array", "[log]\nlevel = [\"info\"]\n", 7, "arrays and inline tables are not supported"},
		{"inline table", "data_dir = { a = 1 }\n", 6, "arrays and inline tables are not supported"},
		{"float", "[journal]\nmax_bytes = 1.5\n", 7, "unsupported value"},
		{"date", "data_dir = 1979-05-27\n", 6, "unsupported value"},
		{"hex integer", "[journal]\nmax_events = 0x10\n", 7, "leading zero"},
		{"leading zero", "[journal]\nmax_events = 010\n", 7, "leading zero"},
		{"bad underscore", "[journal]\nmax_events = 1__0\n", 7, "unsupported value"},
		{"multi-line string", "data_dir = \"\"\"/x\"\"\"\n", 6, "multi-line strings are not supported"},
		{"dotted key", "log.level = \"info\"\n", 6, "must be bare"},
		{"quoted key", "\"site\" = \"x\"\n", 6, "must be bare"},
		{"array of tables", "[[log]]\n", 6, "arrays of tables are not supported"},
		{"dotted section", "[log.file]\n", 6, "must be bare"},
		{"bad escape", "data_dir = \"\\q\"\n", 6, "invalid escape sequence"},
		{"bad unicode escape", "data_dir = \"\\uZZZZ\"\n", 6, "invalid unicode escape"},
		{"unterminated string", "data_dir = \"/x\n", 6, "unterminated string"},
		{"unterminated literal", "data_dir = '/x\n", 6, "unterminated literal string"},
		{"control character", "data_dir = \"/a\x01b\"\n", 6, "control characters must be escaped"},
		{"text after value", "data_dir = \"/x\" y\n", 6, "only a # comment may follow"},
		{"text after header", "[log] level\n", 6, "only a # comment may follow"},
		{"missing value", "data_dir =\n", 6, "missing value"},
		{"missing value before comment", "data_dir = # none\n", 6, "missing value"},
		{"no equals", "data_dir\n", 6, "expected key = value"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse([]byte(required() + tc.text))
			var cerr *Error
			if !errors.As(err, &cerr) {
				t.Fatalf("err = %v; want a *config.Error", err)
			}
			if cerr.Line != tc.line || !strings.Contains(cerr.Msg, tc.want) {
				t.Fatalf("err = %q; want line %d containing %q", err, tc.line, tc.want)
			}
		})
	}
}

func TestParseRequiresInstallScriptKeys(t *testing.T) {
	lines := strings.SplitAfter(required(), "\n")
	for i, key := range []string{"gateway_url", "site", "serving_ca_spki_pin", "join_signing_key_pin", "join_encryption_key_pin"} {
		text := strings.Join(lines[:i], "") + strings.Join(lines[i+1:], "")
		_, err := Parse([]byte(text))
		var cerr *Error
		if !errors.As(err, &cerr) || cerr.Line != 0 || cerr.Msg != key+" is required" {
			t.Errorf("without %s: err = %v", key, err)
		}
	}
}

func TestParseValidatesValues(t *testing.T) {
	short := PinPrefix + base64.StdEncoding.EncodeToString([]byte("too short"))
	cases := []struct {
		name string
		text string
		want string
	}{
		{"http gateway", strings.Replace(required(), "https://", "http://", 1), "gateway_url must be an https:// URL"},
		{"gateway credentials", strings.Replace(required(), "https://", "https://user:pw@", 1), "gateway_url must be an https:// URL"},
		{"site with space", strings.Replace(required(), "fsn1-dc14", "fsn1 dc14", 1), "site must be"},
		{"pin prefix", strings.Replace(required(), testPin, "sha1/abc", 1), "serving_ca_spki_pin: a pin must start with"},
		{"pin length", strings.Replace(required(), testPin, short, 1), "serving_ca_spki_pin: a pin must be sha256/"},
		{"relative data dir", required() + "data_dir = \"var/lib/bcd\"\n", "data_dir must be an absolute path"},
		{"journal above cap", required() + "[journal]\nmax_bytes = 67_108_865\n", "journal.max_bytes must be between 1 and"},
		{"journal zero", required() + "[journal]\nmax_events = 0\n", "journal.max_events must be between 1 and"},
		{"log level", required() + "[log]\nlevel = \"verbose\"\n", "log.level must be"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse([]byte(tc.text))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v; want it to contain %q", err, tc.want)
			}
		})
	}
}

func TestPluginsSection(t *testing.T) {
	cfg, err := Parse([]byte(required()))
	if err != nil || !cfg.Plugins.Sandbox || cfg.Plugins.User != "" {
		t.Fatalf("defaults = %+v, %v", cfg.Plugins, err)
	}
	cfg, err = Parse([]byte(required() + "[plugins]\ndir = \"/etc/bcd/plugins\"\nuser = \"bcx\"\nsandbox = false\ncgroup = \"/sys/fs/cgroup/bcd.plugins\"\nmemory_max = 1_073_741_824\npids_max = 256\n"))
	if err != nil || cfg.Plugins.User != "bcx" || cfg.Plugins.Sandbox || cfg.Plugins.Cgroup != "/sys/fs/cgroup/bcd.plugins" || cfg.Plugins.MemoryMax != 1<<30 || cfg.Plugins.PidsMax != 256 {
		t.Fatalf("plugins = %+v, %v", cfg.Plugins, err)
	}
	if _, err := Parse([]byte(required() + "[plugins]\ncgroup = \"relative\"\n")); err == nil {
		t.Fatal("a relative cgroup was accepted")
	}
	if _, err := Parse([]byte(required() + "[plugins]\nuser = \"root\"\n")); err == nil {
		t.Fatal("every plugin as root was accepted")
	}
	if cfg, err := Parse([]byte(required() + "[plugins]\nprivileged = \"kata\"\n")); err != nil || cfg.Plugins.Privileged != "kata" {
		t.Fatalf("privileged = %+v, %v", cfg.Plugins, err)
	}
}

func TestUpdateSection(t *testing.T) {
	cfg, err := Parse([]byte(required()))
	if pins, _ := cfg.Update.Pins(); err != nil || len(pins) != 0 || cfg.Update.Entrypoint != "/usr/local/bin/bcd" || cfg.Update.ReleaseThreshold != 1 {
		t.Fatalf("defaults = %+v, %v", cfg.Update, err)
	}
	cfg, err = Parse([]byte(required() + "[update]\nrelease_pins = \"" + testPin + ", " + testPin + "\"\nrelease_threshold = 2\nentrypoint = \"/opt/bcd/bcd\"\n"))
	if pins, _ := cfg.Update.Pins(); err != nil || len(pins) != 2 || cfg.Update.Entrypoint != "/opt/bcd/bcd" {
		t.Fatalf("update = %+v, %v", cfg.Update, err)
	}
	for _, bad := range []string{
		"release_pins = \"sha256/short\"\n",
		"release_pins = \"" + testPin + "\"\nrelease_threshold = 2\n",
		"release_threshold = 0\n",
		"entrypoint = \"bcd\"\n",
	} {
		if _, err := Parse([]byte(required() + "[update]\n" + bad)); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	rendered, err := Parse([]byte(Render(cfg)))
	if err != nil || rendered.Update != cfg.Update {
		t.Fatalf("Render lost [update]: %+v, %v", rendered.Update, err)
	}
}

func TestApproverSetSHA256(t *testing.T) {
	digest := strings.Repeat("ab", 32)
	cfg, err := Parse([]byte(required() + "approver_set_sha256 = \"" + digest + "\"\n"))
	if pin, perr := cfg.ApproverSetPin(); err != nil || perr != nil || len(pin) != 32 {
		t.Fatalf("approver_set_sha256 = %v %v", err, perr)
	}
	if back, err := Parse([]byte(Render(cfg))); err != nil || back.ApproverSetSHA256 != digest {
		t.Fatalf("Render lost approver_set_sha256: %v", err)
	}
	for _, bad := range []string{strings.Repeat("AB", 32), "abcd", strings.Repeat("zz", 32)} {
		if _, err := Parse([]byte(required() + "approver_set_sha256 = \"" + bad + "\"\n")); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestDecodePin(t *testing.T) {
	digest, err := DecodePin(testPin)
	if err != nil {
		t.Fatalf("DecodePin: %v", err)
	}
	if !bytes.Equal(digest, bytes.Repeat([]byte{0xbc}, 32)) {
		t.Fatalf("digest = %x", digest)
	}
}

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(file, []byte(required()), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(file)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Site != "fsn1-dc14" {
		t.Fatalf("site = %q", cfg.Site)
	}

	if _, err := Load(filepath.Join(dir, "missing.toml")); err == nil || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing file: err = %v; want os.ErrNotExist", err)
	}

	big := filepath.Join(dir, "big.toml")
	if err := os.WriteFile(big, bytes.Repeat([]byte("# padding\n"), 7000), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(big); err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Fatalf("oversized file: err = %v", err)
	}

	broken := filepath.Join(dir, "broken.toml")
	if err := os.WriteFile(broken, []byte(required()+"colour = 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = Load(broken)
	var cerr *Error
	if !errors.As(err, &cerr) || cerr.Line != 6 || !strings.Contains(err.Error(), broken) {
		t.Fatalf("broken file: err = %v; want line 6 and the path", err)
	}
}
