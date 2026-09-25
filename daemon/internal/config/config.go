// Package config reads /etc/bcd/config.toml, which the install script writes with mode 0600
// (PLAN.md §3.3, §6 "Install"). The file holds the gateway URL, the site, the gateway serving-CA
// SPKI pin and the JoinService signing and encryption key pins, plus optional local overrides. It
// never holds the join token: bcd join reads that from BCD_JOIN_TOKEN or stdin and consumes it.
//
// The format is a documented subset of TOML v1.0:
//
//   - comments start with # on their own line or after a value;
//   - [section] headers take a bare name (A-Z a-z 0-9 _ -); dotted names and [[arrays]] are rejected;
//   - key = value takes a bare key and a basic string "..." (escapes \b \t \n \f \r \" \\ \uXXXX
//     \UXXXXXXXX), a literal string '...', a decimal integer (optional sign, _ between digits) or
//     true/false.
//
// Everything else (arrays, inline tables, floats, dates, multi-line strings, dotted or quoted keys)
// is an error, and so are unknown keys and sections, duplicate keys and wrong value types, so a typo
// fails loudly instead of being ignored.
//
// Example:
//
//	gateway_url = "https://gw.eu-central.example.com"
//	site = "fsn1-dc14"
//	serving_ca_spki_pin = "sha256/<base64 of the SHA-256 of the CA's SubjectPublicKeyInfo>"
//	join_signing_key_pin = "sha256/<...>"
//	join_encryption_key_pin = "sha256/<...>"
//	data_dir = "/var/lib/bcd"   # optional
//
//	[journal]                   # optional; may lower the PLAN.md §6 caps, never raise them
//	max_bytes = 67_108_864
//	max_events = 10_000
//
//	[log]                       # optional
//	level = "info"
//	json = true
package config

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/journal"
)

// Paths the daemon uses unless the file overrides them.
const (
	DefaultPath       = "/etc/bcd/config.toml"
	DefaultDataDir    = "/var/lib/bcd"
	DefaultSocketPath = "/run/bcd/bcd.sock"
)

// PinPrefix starts every key pin. The rest is the standard base64 of the SHA-256 digest of a
// SubjectPublicKeyInfo, as in HPKP and curl --pinnedpubkey.
const PinPrefix = "sha256/"

// maxFileBytes bounds what Load reads (P12); the real file is a few hundred bytes.
const maxFileBytes = 64 << 10

// Config is the parsed configuration file.
type Config struct {
	// GatewayURL is the regional gateway the daemon dials: an https:// URL, port 443 by default.
	GatewayURL string

	// Site is the id of the site the node belongs to.
	Site string

	// ServingCASPKIPin pins the gateway serving CA (PLAN.md §7.1).
	ServingCASPKIPin string

	// JoinSigningKeyPin pins the JoinService key that signs JoinResponse.
	JoinSigningKeyPin string

	// JoinEncryptionKeyPin pins the JoinService key the join token is sealed to (JWE).
	JoinEncryptionKeyPin string

	// DataDir holds the journal, and the node key when there is no TPM (default /var/lib/bcd).
	DataDir string

	// SocketPath is the root-only unix socket that serves bcd status|doctor|support-bundle
	// (default /run/bcd/bcd.sock).
	SocketPath string

	// Journal bounds the journal.
	Journal Journal

	// Log configures the daemon's logs.
	Log Log

	// GatewayServerName, when set, is the name the gateway's certificate must carry instead of the
	// gateway_url host (a gateway reached by IP address, e.g. behind an L4 load balancer).
	GatewayServerName string

	// DevInsecureH2C allows an http:// gateway_url: cleartext HTTP/2 to a dev stack's gateway, which
	// names the node by a header instead of mTLS. Only fakehw builds of bcd accept it (the host build
	// refuses to start); never set it on a reachable machine.
	DevInsecureH2C bool
}

// Journal bounds the journal. Values may lower the PLAN.md §6 caps but never raise them.
type Journal struct {
	// MaxBytes caps the journal's size (default and maximum 64 MiB).
	MaxBytes int64

	// MaxEvents caps the unacked events it keeps (default and maximum 10k).
	MaxEvents int64
}

// Log configures the daemon's logs.
type Log struct {
	// Level is debug, info, warn or error (default info).
	Level string

	// JSON selects JSON lines (default true), as PLAN.md §14 expects.
	JSON bool
}

// Defaults returns the configuration before the file is applied.
func Defaults() *Config {
	return &Config{
		DataDir:    DefaultDataDir,
		SocketPath: DefaultSocketPath,
		Journal:    Journal{MaxBytes: journal.DefaultMaxBytes, MaxEvents: journal.DefaultMaxEvents},
		Log:        Log{Level: "info", JSON: true},
	}
}

// Error is a configuration error. Line is the 1-based line it was found on, or 0 when it concerns
// the file as a whole, such as a missing required key.
type Error struct {
	Line int
	Msg  string
}

func (e *Error) Error() string {
	if e.Line > 0 {
		return fmt.Sprintf("line %d: %s", e.Line, e.Msg)
	}
	return e.Msg
}

func errorAt(line int, format string, args ...any) error {
	return &Error{Line: line, Msg: fmt.Sprintf(format, args...)}
}

// Load reads and validates the configuration file at file.
func Load(file string) (*Config, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	if len(data) > maxFileBytes {
		return nil, fmt.Errorf("config %s: larger than %d bytes", file, maxFileBytes)
	}
	cfg, err := Parse(data)
	if err != nil {
		return nil, fmt.Errorf("config %s: %w", file, err)
	}
	return cfg, nil
}

// Parse parses and validates the contents of a configuration file.
func Parse(data []byte) (*Config, error) {
	doc, err := parseDocument(data)
	if err != nil {
		return nil, err
	}
	for _, h := range doc.sections {
		if !knownSection(h.name) {
			return nil, errorAt(h.line, "unknown section [%s]", h.name)
		}
	}
	cfg := Defaults()
	seen := make(map[*field]bool, len(fields))
	for _, e := range doc.entries {
		f := lookupField(e.section, e.key)
		if f == nil {
			return nil, errorAt(e.value.line, "unknown key %s", qualified(e.section, e.key))
		}
		if e.value.kind != f.kind {
			return nil, errorAt(e.value.line, "%s must be %s", qualified(e.section, e.key), f.kind)
		}
		f.set(cfg, e.value)
		seen[f] = true
	}
	for i := range fields {
		if fields[i].required && !seen[&fields[i]] {
			return nil, errorAt(0, "%s is required", qualified(fields[i].section, fields[i].key))
		}
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Validate checks every value. Parse calls it; callers that build a Config by hand should too.
func (c *Config) Validate() error {
	u, err := url.Parse(c.GatewayURL)
	secure := u != nil && (u.Scheme == "https" || (u.Scheme == "http" && c.DevInsecureH2C))
	if err != nil || !secure || u.Host == "" || u.User != nil {
		return fmt.Errorf("gateway_url must be an https:// URL without credentials, got %q", c.GatewayURL)
	}
	if c.Site == "" || strings.ContainsAny(c.Site, " \t\r\n") {
		return fmt.Errorf("site must be a non-empty id without whitespace, got %q", c.Site)
	}
	pins := []struct {
		key   string
		value string
	}{
		{"serving_ca_spki_pin", c.ServingCASPKIPin},
		{"join_signing_key_pin", c.JoinSigningKeyPin},
		{"join_encryption_key_pin", c.JoinEncryptionKeyPin},
	}
	for _, p := range pins {
		if _, err := DecodePin(p.value); err != nil {
			return fmt.Errorf("%s: %w", p.key, err)
		}
	}
	if !path.IsAbs(c.DataDir) {
		return fmt.Errorf("data_dir must be an absolute path, got %q", c.DataDir)
	}
	if !path.IsAbs(c.SocketPath) {
		return fmt.Errorf("socket_path must be an absolute path, got %q", c.SocketPath)
	}
	if c.Journal.MaxBytes <= 0 || c.Journal.MaxBytes > journal.DefaultMaxBytes {
		return fmt.Errorf("journal.max_bytes must be between 1 and %d, got %d", journal.DefaultMaxBytes, c.Journal.MaxBytes)
	}
	if c.Journal.MaxEvents <= 0 || c.Journal.MaxEvents > journal.DefaultMaxEvents {
		return fmt.Errorf("journal.max_events must be between 1 and %d, got %d", journal.DefaultMaxEvents, c.Journal.MaxEvents)
	}
	switch c.Log.Level {
	case "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("log.level must be debug, info, warn or error, got %q", c.Log.Level)
	}
	return nil
}

// DecodePin returns the SHA-256 digest a pin carries.
func DecodePin(pin string) ([]byte, error) {
	encoded, ok := strings.CutPrefix(pin, PinPrefix)
	if !ok {
		return nil, fmt.Errorf("a pin must start with %q", PinPrefix)
	}
	digest, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(digest) != sha256.Size {
		return nil, errors.New("a pin must be sha256/ followed by the standard base64 of a 32-byte digest")
	}
	return digest, nil
}

// field maps one key of the file onto Config.
type field struct {
	section  string
	key      string
	kind     kind
	required bool
	set      func(c *Config, v value)
}

var fields = []field{
	{key: "gateway_url", kind: kindString, required: true, set: func(c *Config, v value) { c.GatewayURL = v.str }},
	{key: "site", kind: kindString, required: true, set: func(c *Config, v value) { c.Site = v.str }},
	{key: "serving_ca_spki_pin", kind: kindString, required: true, set: func(c *Config, v value) { c.ServingCASPKIPin = v.str }},
	{key: "join_signing_key_pin", kind: kindString, required: true, set: func(c *Config, v value) { c.JoinSigningKeyPin = v.str }},
	{key: "join_encryption_key_pin", kind: kindString, required: true, set: func(c *Config, v value) { c.JoinEncryptionKeyPin = v.str }},
	{key: "data_dir", kind: kindString, set: func(c *Config, v value) { c.DataDir = v.str }},
	{key: "socket_path", kind: kindString, set: func(c *Config, v value) { c.SocketPath = v.str }},
	{section: "journal", key: "max_bytes", kind: kindInt, set: func(c *Config, v value) { c.Journal.MaxBytes = v.num }},
	{section: "journal", key: "max_events", kind: kindInt, set: func(c *Config, v value) { c.Journal.MaxEvents = v.num }},
	{section: "log", key: "level", kind: kindString, set: func(c *Config, v value) { c.Log.Level = v.str }},
	{section: "log", key: "json", kind: kindBool, set: func(c *Config, v value) { c.Log.JSON = v.boolean }},
	{key: "gateway_server_name", kind: kindString, set: func(c *Config, v value) { c.GatewayServerName = v.str }},
	{key: "dev_insecure_h2c", kind: kindBool, set: func(c *Config, v value) { c.DevInsecureH2C = v.boolean }},
}

func lookupField(section, key string) *field {
	for i := range fields {
		if fields[i].section == section && fields[i].key == key {
			return &fields[i]
		}
	}
	return nil
}

func knownSection(name string) bool {
	for i := range fields {
		if fields[i].section == name {
			return true
		}
	}
	return false
}

func qualified(section, key string) string {
	if section == "" {
		return key
	}
	return section + "." + key
}
