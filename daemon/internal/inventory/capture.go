package inventory

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

// Capture runs the collector against the real filesystem (src, "" or "/") and copies every path it
// looked at into dst, so that Collector{Root: dst} sees the same machine: regular files with their
// content, directories, and symlinks with their targets (every symlink on the way to a path, so the
// sysfs links that tell a disk's transport or a NIC's driver survive). Device nodes become empty files
// (the collector only asks whether they exist). It is how a real server becomes a test fixture:
//
//	bcd hardware --capture ./testdata/hosts/<name> [--redact]
//
// With Redact, identifiers are replaced by stable stand-ins of the same shape (serials, UUIDs, MACs,
// WWNs, the hostname, GPU UUIDs): a fixture shared outside the machine's owner tells nothing about it.
type CaptureOptions struct {
	// Src is the root to read ("" = /). Tests point it at a fake tree.
	Src string
	// Redact replaces identifiers in the copied files.
	Redact bool
}

// Capture copies what the collector reads from opts.Src into dst and returns the inventory it saw (of
// the source, before redaction).
func Capture(dst string, opts CaptureOptions) (*NodeInventory, error) {
	if dst == "" {
		return nil, errors.New("capture needs a destination directory")
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return nil, err
	}
	m := &mirror{src: opts.Src, dst: dst, done: map[string]bool{}}
	c := Collector{Root: opts.Src, Trace: func(abs string) { m.path(abs) }}
	inv, err := c.Collect()
	if err != nil {
		return nil, err
	}
	if m.err != nil {
		return nil, m.err
	}
	if opts.Redact {
		if err := redactTree(dst); err != nil {
			return nil, err
		}
	}
	return inv, nil
}

type mirror struct {
	src, dst string
	done     map[string]bool
	err      error
}

func (m *mirror) real(abs string) string {
	if m.src == "" || m.src == "/" {
		return filepath.FromSlash(abs)
	}
	return filepath.Join(m.src, filepath.FromSlash(abs))
}

func (m *mirror) out(abs string) string { return filepath.Join(m.dst, filepath.FromSlash(abs)) }

// path mirrors abs, resolving symlinks component by component and recreating each one it crosses.
func (m *mirror) path(abs string) {
	clean := path.Clean("/" + abs)
	m.walk(clean, 0)
	if strings.HasSuffix(abs, "/") {
		// A listing: the collector sees the entries' names, so every entry is mirrored too (each as a
		// link, a file with its content, or an empty directory; not recursively).
		entries, err := os.ReadDir(m.real(clean))
		if err != nil {
			return
		}
		for _, e := range entries {
			m.walk(path.Join(clean, e.Name()), 0)
		}
	}
}

func (m *mirror) walk(abs string, depth int) {
	if depth > 40 || m.done[abs] || m.err != nil {
		return
	}
	m.done[abs] = true
	parts := strings.Split(strings.TrimPrefix(abs, "/"), "/")
	cur := "/"
	for i, part := range parts {
		if part == "" {
			continue
		}
		next := path.Join(cur, part)
		st, err := os.Lstat(m.real(next))
		if err != nil {
			return // absent: nothing to mirror (the collector sees it absent too)
		}
		last := i == len(parts)-1
		if st.Mode()&fs.ModeSymlink != 0 {
			target, err := os.Readlink(m.real(next))
			if err != nil {
				return
			}
			target = filepath.ToSlash(target)
			m.link(next, target)
			// Continue from where the link points, with the components still to go.
			resolved := target
			if !path.IsAbs(target) {
				resolved = path.Join(cur, target)
			}
			rest := strings.Join(parts[i+1:], "/")
			m.walk(path.Join(resolved, rest), depth+1)
			return
		}
		if last {
			m.leaf(next, st)
			return
		}
		if !st.IsDir() {
			return
		}
		m.mkdir(next)
		cur = next
	}
}

func (m *mirror) mkdir(abs string) {
	if err := os.MkdirAll(m.out(abs), 0o755); err != nil && m.err == nil {
		m.err = err
	}
}

func (m *mirror) link(abs, target string) {
	out := m.out(abs)
	if _, err := os.Lstat(out); err == nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		m.err = err
		return
	}
	if err := os.Symlink(filepath.FromSlash(target), out); err != nil && m.err == nil {
		m.err = err
	}
}

func (m *mirror) leaf(abs string, st fs.FileInfo) {
	out := m.out(abs)
	switch {
	case st.IsDir():
		m.mkdir(abs)
	case st.Mode().IsRegular():
		// procfs and sysfs report size 0: read, never trust Size. Unreadable (root-only DMI serials
		// under an unprivileged run) stays absent, as the collector saw it.
		b, err := os.ReadFile(m.real(abs))
		if err != nil {
			return
		}
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			m.err = err
			return
		}
		if err := os.WriteFile(out, b, 0o644); err != nil {
			m.err = err
		}
	default:
		// A device node (/dev/kvm) or socket: its presence is what counts.
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			m.err = err
			return
		}
		if err := os.WriteFile(out, nil, 0o644); err != nil {
			m.err = err
		}
	}
}

// ---- redaction -----------------------------------------------------------------------------------

var (
	macPattern  = regexp.MustCompile(`(?i)\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b`)
	uuidPattern = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)
)

// stable is a short, deterministic stand-in for an identifier (same input, same output).
func stable(s string, n int) string {
	sum := sha256.Sum256([]byte("bcd-capture/" + s))
	h := hex.EncodeToString(sum[:])
	for len(h) < n {
		h += h
	}
	return h[:n]
}

// placeholders are DMI values vendors leave unset; they carry nothing to hide and the control plane
// recognizes them, so a fixture keeps them as they are.
var placeholders = map[string]bool{
	"": true, "to be filled by o.e.m.": true, "default string": true, "not specified": true, "none": true,
	"system serial number": true, "chassis serial number": true, "0123456789": true, "0": true, "n/a": true,
}

// redactFile names, relative to the capture root, the files whose whole content is an identifier.
func redactWhole(rel string) bool {
	switch {
	case strings.HasPrefix(rel, "sys/class/dmi/id/") || strings.HasPrefix(rel, "sys/devices/virtual/dmi/id/"):
		base := path.Base(rel)
		return strings.HasSuffix(base, "_serial") || base == "product_uuid" || base == "board_asset_tag" || base == "chassis_asset_tag"
	case strings.HasSuffix(rel, "/serial"), strings.HasSuffix(rel, "/wwid"), strings.HasSuffix(rel, "/wwn"):
		return true
	case rel == "proc/sys/kernel/hostname":
		return true
	}
	return false
}

func redactTree(root string) error {
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Type()&fs.ModeSymlink != 0 {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		text := string(b)
		out := text
		value := strings.TrimSpace(text)
		switch {
		case redactWhole(rel) && !placeholders[strings.ToLower(value)]:
			out = redactValue(rel, value) + "\n"
		case strings.HasSuffix(rel, "/address") || strings.HasSuffix(rel, "/perm_hwaddr"):
			out = macPattern.ReplaceAllStringFunc(text, func(mac string) string { return redactMAC(mac) })
		case strings.HasPrefix(rel, "proc/driver/nvidia/gpus/") && strings.HasSuffix(rel, "/information"):
			out = gpuUUIDPattern.ReplaceAllStringFunc(text, func(u string) string { return "GPU-" + redactUUID(strings.TrimPrefix(u, "GPU-")) })
		}
		if out == text {
			return nil
		}
		return os.WriteFile(p, []byte(out), 0o644)
	})
}

var gpuUUIDPattern = regexp.MustCompile(`GPU-[0-9a-fA-F-]+`)

func redactValue(rel, value string) string {
	switch {
	case uuidPattern.MatchString(value) && len(value) == 36:
		return redactUUID(value)
	case strings.HasSuffix(rel, "hostname"):
		return "host-" + stable(value, 8)
	}
	// Keep a recognizable prefix (eui., naa., t10.) so transport-specific parsing still sees it.
	if i := strings.Index(value, "."); i > 0 && i <= 4 {
		return value[:i+1] + strings.ToUpper(stable(value, max(8, len(value)-i-1)))
	}
	return "R" + strings.ToUpper(stable(value, max(7, len(value)-1)))
}

func redactUUID(u string) string {
	h := stable(strings.ToLower(u), 32)
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])
}

// redactMAC keeps the multicast/locally-administered bits meaningful: a stand-in is a locally
// administered unicast address.
func redactMAC(mac string) string {
	h := stable(strings.ToLower(mac), 12)
	return "02:" + h[2:4] + ":" + h[4:6] + ":" + h[6:8] + ":" + h[8:10] + ":" + h[10:12]
}
