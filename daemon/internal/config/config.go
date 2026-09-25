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
//
//	[update]                    # optional; self-update needs release pins
//	release_pins = "sha256/<...>,sha256/<...>"
//	release_threshold = 1
//	entrypoint = "/usr/local/bin/bcd"
package config

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"strconv"
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

	// ApproverSetSHA256 pins the approver set a daemon without approver keys may take (lowercase hex
	// of sha256(approver set input); review 7 M2, written by the install script). Empty: the first
	// set is taken as it comes.
	ApproverSetSHA256 string

	// DataDir holds the journal, and the node key when there is no TPM (default /var/lib/bcd).
	DataDir string

	// SocketPath is the root-only unix socket that serves bcd status|doctor|support-bundle
	// (default /run/bcd/bcd.sock).
	SocketPath string

	// Journal bounds the journal.
	Journal Journal

	// Log configures the daemon's logs.
	Log Log

	// Boot configures a site agent's boot server ([boot]; bcd site only).
	Boot Boot

	// PluginsDir holds the bcx driver plugins and their sha256 pins ([plugins] dir); empty: none.
	PluginsDir string

	// Plugins sandbox the bcx plugins (PLAN.md §5.5).
	Plugins Plugins

	// Update configures self-update ([update]).
	Update Update

	// IMDSListen is where a VPS host serves its instances' metadata service ([imds] listen, e.g.
	// "169.254.169.254:80" on the instances' bridge); empty disables it.
	IMDSListen string

	// GatewayServerName, when set, is the name the gateway's certificate must carry instead of the
	// gateway_url host (a gateway reached by IP address, e.g. behind an L4 load balancer).
	GatewayServerName string

	// InstallFiles are files a ramdisk installs into the OS it deploys (set by bcd ramdisk; not a
	// file key).
	InstallFiles map[string][]byte

	// ImageCache is the site image cache a ramdisk tries first (set by bcd ramdisk from bc.cache; not
	// a file key).
	ImageCache string

	// DevInsecureH2C allows an http:// gateway_url: cleartext HTTP/2 to a dev stack's gateway, which
	// names the node by a header instead of mTLS. Only fakehw builds of bcd accept it (the host build
	// refuses to start); never set it on a reachable machine.
	DevInsecureH2C bool
}

// Boot configures the site agent's boot server: where iPXE fetches scripts, and the site's ramdisk.
type Boot struct {
	// Listen is the HTTP address of the boot server (e.g. "0.0.0.0:8080"); empty disables it.
	Listen string
	// Kernel and Initrd are the URLs of the site's ramdisk artifacts.
	Kernel string
	Initrd string
	// Cmdline is appended to the ramdisk's kernel command line.
	Cmdline string
	// URL is how machines reach this boot server (e.g. http://10.20.0.2:8080): iPXE chains to it and
	// its image cache is passed to the ramdisks it boots.
	URL string
	// ServerIP is this agent's address on the provisioning network (proxyDHCP, TFTP next-server).
	ServerIP string
	// ProxyDHCP turns on the proxyDHCP server on UDP 67 and 4011 (beside the site's DHCP server).
	ProxyDHCP bool
	// TFTP is the TFTP server's UDP address (e.g. ":69") and TFTPRoot the iPXE builds it serves.
	TFTP     string
	TFTPRoot string
	// CacheMaxBytes bounds the site image cache (0 = unbounded); least recently used images outside
	// the pools' keep set are evicted.
	CacheMaxBytes int64
}

// Plugins is how bcx plugins run ([plugins]).
type Plugins struct {
	// User is who they run as when bcd runs as root; empty (the default) gives each plugin its own
	// uid in a block bcd keeps (0x7FFE0000-0x7FFEFFFF), so no plugin can read another's memory.
	User string
	// Privileged names the plugins (comma-separated) that run as root without the seccomp filter:
	// a runtime plugin that makes namespaces and mounts (Kata). Every other plugin is confined.
	Privileged string
	// Sandbox runs them with no new privileges and a seccomp filter (default true).
	Sandbox bool
	// Cgroup is a delegated cgroup v2 directory (e.g. /sys/fs/cgroup/bcd.plugins, with Delegate=yes);
	// each plugin runs in its own child, limited by MemoryMax bytes and PidsMax tasks.
	Cgroup    string
	MemoryMax int64
	PidsMax   int64
}

// Update is self-update ([update], PLAN.md §6 "Self-update"). Without release pins bcd takes no new
// binary: a release must be signed by the pinned keys, never only by the control plane's word.
type Update struct {
	// ReleasePins are the release keys' "sha256/<base64>" SPKI pins, comma-separated.
	ReleasePins string
	// ReleaseThreshold is how many distinct pinned keys must have signed a release (default 1).
	ReleaseThreshold int64
	// ReleaseSequence is the release this node was installed at (the install script's
	// --release-sequence): no release manifest below it is taken (0: unknown).
	ReleaseSequence int64
	// Entrypoint is the path bcd.service starts (default /usr/local/bin/bcd); the first update makes
	// it a symlink to <data_dir>/bin/current.
	Entrypoint string
}

// Pins decodes ReleasePins, each distinct pin once (a pin listed twice is still one key).
func (u Update) Pins() ([][]byte, error) {
	var pins [][]byte
	seen := map[string]bool{}
	for _, p := range strings.Split(u.ReleasePins, ",") {
		if p = strings.TrimSpace(p); p == "" {
			continue
		}
		digest, err := DecodePin(p)
		if err != nil {
			return nil, fmt.Errorf("update.release_pins: %w", err)
		}
		if !seen[string(digest)] {
			seen[string(digest)] = true
			pins = append(pins, digest)
		}
	}
	return pins, nil
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
		Plugins:    Plugins{Sandbox: true},
		Update:     Update{ReleaseThreshold: 1, Entrypoint: "/usr/local/bin/bcd"},
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
	if _, err := c.ApproverSetPin(); err != nil {
		return err
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
	if c.Plugins.Cgroup != "" && !path.IsAbs(c.Plugins.Cgroup) {
		return fmt.Errorf("plugins.cgroup must be an absolute path, got %q", c.Plugins.Cgroup)
	}
	if c.Plugins.User == "root" || c.Plugins.User == "0" {
		return errors.New("plugins.user may not be root; name the plugins that need root in plugins.privileged")
	}
	if c.Plugins.MemoryMax < 0 || c.Plugins.PidsMax < 0 {
		return errors.New("plugins.memory_max and plugins.pids_max may not be negative")
	}
	releasePins, err := c.Update.Pins()
	if err != nil {
		return err
	}
	if c.Update.ReleaseThreshold < 1 || (len(releasePins) > 0 && c.Update.ReleaseThreshold > int64(len(releasePins))) || c.Update.ReleaseThreshold > 16 {
		return fmt.Errorf("update.release_threshold must be between 1 and the number of distinct release pins, got %d", c.Update.ReleaseThreshold)
	}
	if c.Update.ReleaseSequence < 0 {
		return fmt.Errorf("update.release_sequence may not be negative, got %d", c.Update.ReleaseSequence)
	}
	if !path.IsAbs(c.Update.Entrypoint) {
		return fmt.Errorf("update.entrypoint must be an absolute path, got %q", c.Update.Entrypoint)
	}
	switch c.Log.Level {
	case "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("log.level must be debug, info, warn or error, got %q", c.Log.Level)
	}
	return nil
}

// ApproverSetPin decodes approver_set_sha256 (nil when unset).
func (c *Config) ApproverSetPin() ([]byte, error) {
	if c.ApproverSetSHA256 == "" {
		return nil, nil
	}
	pin, err := hex.DecodeString(c.ApproverSetSHA256)
	if err != nil || len(pin) != sha256.Size || strings.ToLower(c.ApproverSetSHA256) != c.ApproverSetSHA256 {
		return nil, errors.New("approver_set_sha256 must be 64 lowercase hex digits")
	}
	return pin, nil
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
	{key: "approver_set_sha256", kind: kindString, set: func(c *Config, v value) { c.ApproverSetSHA256 = v.str }},
	{key: "data_dir", kind: kindString, set: func(c *Config, v value) { c.DataDir = v.str }},
	{key: "socket_path", kind: kindString, set: func(c *Config, v value) { c.SocketPath = v.str }},
	{section: "journal", key: "max_bytes", kind: kindInt, set: func(c *Config, v value) { c.Journal.MaxBytes = v.num }},
	{section: "journal", key: "max_events", kind: kindInt, set: func(c *Config, v value) { c.Journal.MaxEvents = v.num }},
	{section: "log", key: "level", kind: kindString, set: func(c *Config, v value) { c.Log.Level = v.str }},
	{section: "log", key: "json", kind: kindBool, set: func(c *Config, v value) { c.Log.JSON = v.boolean }},
	{section: "plugins", key: "dir", kind: kindString, set: func(c *Config, v value) { c.PluginsDir = v.str }},
	{section: "plugins", key: "user", kind: kindString, set: func(c *Config, v value) { c.Plugins.User = v.str }},
	{section: "plugins", key: "privileged", kind: kindString, set: func(c *Config, v value) { c.Plugins.Privileged = v.str }},
	{section: "plugins", key: "sandbox", kind: kindBool, set: func(c *Config, v value) { c.Plugins.Sandbox = v.boolean }},
	{section: "plugins", key: "cgroup", kind: kindString, set: func(c *Config, v value) { c.Plugins.Cgroup = v.str }},
	{section: "plugins", key: "memory_max", kind: kindInt, set: func(c *Config, v value) { c.Plugins.MemoryMax = v.num }},
	{section: "plugins", key: "pids_max", kind: kindInt, set: func(c *Config, v value) { c.Plugins.PidsMax = v.num }},
	{section: "update", key: "release_pins", kind: kindString, set: func(c *Config, v value) { c.Update.ReleasePins = v.str }},
	{section: "update", key: "release_threshold", kind: kindInt, set: func(c *Config, v value) { c.Update.ReleaseThreshold = v.num }},
	{section: "update", key: "release_sequence", kind: kindInt, set: func(c *Config, v value) { c.Update.ReleaseSequence = v.num }},
	{section: "update", key: "entrypoint", kind: kindString, set: func(c *Config, v value) { c.Update.Entrypoint = v.str }},
	{section: "imds", key: "listen", kind: kindString, set: func(c *Config, v value) { c.IMDSListen = v.str }},
	{section: "boot", key: "listen", kind: kindString, set: func(c *Config, v value) { c.Boot.Listen = v.str }},
	{section: "boot", key: "kernel", kind: kindString, set: func(c *Config, v value) { c.Boot.Kernel = v.str }},
	{section: "boot", key: "initrd", kind: kindString, set: func(c *Config, v value) { c.Boot.Initrd = v.str }},
	{section: "boot", key: "server_ip", kind: kindString, set: func(c *Config, v value) { c.Boot.ServerIP = v.str }},
	{section: "boot", key: "proxy_dhcp", kind: kindBool, set: func(c *Config, v value) { c.Boot.ProxyDHCP = v.boolean }},
	{section: "boot", key: "tftp", kind: kindString, set: func(c *Config, v value) { c.Boot.TFTP = v.str }},
	{section: "boot", key: "cache_max_bytes", kind: kindInt, set: func(c *Config, v value) { c.Boot.CacheMaxBytes = v.num }},
	{section: "boot", key: "tftp_root", kind: kindString, set: func(c *Config, v value) { c.Boot.TFTPRoot = v.str }},
	{section: "boot", key: "url", kind: kindString, set: func(c *Config, v value) { c.Boot.URL = v.str }},
	{section: "boot", key: "cmdline", kind: kindString, set: func(c *Config, v value) { c.Boot.Cmdline = v.str }},
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

// Render writes the join-relevant part of c as a config.toml the parser accepts: the gateway, its
// server name, the site and the three pins (what a ramdisk hands the OS it installs, and what bcd
// join writes for a machine it bootstrapped from the well-known document).
func Render(c *Config) string {
	q := func(s string) string { return strconv.Quote(s) }
	lines := []string{
		"# Written by bcd (PLAN.md §3.5, §6 Install).",
		"gateway_url = " + q(c.GatewayURL),
	}
	if c.GatewayServerName != "" {
		lines = append(lines, "gateway_server_name = "+q(c.GatewayServerName))
	}
	lines = append(lines,
		"site = "+q(c.Site),
		"serving_ca_spki_pin = "+q(c.ServingCASPKIPin),
		"join_signing_key_pin = "+q(c.JoinSigningKeyPin),
		"join_encryption_key_pin = "+q(c.JoinEncryptionKeyPin),
	)
	if c.ApproverSetSHA256 != "" {
		lines = append(lines, "approver_set_sha256 = "+q(c.ApproverSetSHA256))
	}
	if c.DataDir != "" && c.DataDir != DefaultDataDir {
		lines = append(lines, "data_dir = "+q(c.DataDir))
	}
	if c.DevInsecureH2C {
		lines = append(lines, "dev_insecure_h2c = true")
	}
	if c.Update.ReleasePins != "" {
		// The installed OS takes releases signed by the same keys.
		lines = append(lines, "", "[update]", "release_pins = "+q(c.Update.ReleasePins),
			"release_threshold = "+strconv.FormatInt(c.Update.ReleaseThreshold, 10))
		if c.Update.ReleaseSequence > 0 {
			lines = append(lines, "release_sequence = "+strconv.FormatInt(c.Update.ReleaseSequence, 10))
		}
		if c.Update.Entrypoint != "" && c.Update.Entrypoint != Defaults().Update.Entrypoint {
			lines = append(lines, "entrypoint = "+q(c.Update.Entrypoint))
		}
	}
	return strings.Join(lines, "\n") + "\n"
}
