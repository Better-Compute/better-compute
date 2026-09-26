package hostconfig

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/pki"
)

// OSSystem is the machine bcd runs on.
type OSSystem struct {
	// Root prefixes every host path; "" or "/" is the real filesystem. Under a fake root (fakehw,
	// bcd sim) programs are not run: each is appended to CommandLog and answers with no output, and
	// LookPath looks under the root's bin directories.
	Root string
	// WriteFileFunc and RemoveFileFunc, when set, replace the file writes (bcd node without root
	// writes through bcd helper).
	WriteFileFunc  func(abs string, data []byte, mode fs.FileMode) error
	RemoveFileFunc func(abs string) error
	// Timeout bounds one program (default 20 minutes: a driver install builds kernel modules).
	Timeout time.Duration
}

// CommandLog is where a host under a fake root records the programs it was asked to run.
const CommandLog = "/run/bcd/hostconfig-commands.log"

func (s *OSSystem) fake() bool { return s.Root != "" && s.Root != "/" }

// Path maps an absolute host path under Root.
func (s *OSSystem) Path(abs string) string {
	if !s.fake() {
		return abs
	}
	return filepath.Join(s.Root, filepath.FromSlash(abs))
}

func (s *OSSystem) ReadFile(abs string) ([]byte, error) { return os.ReadFile(s.Path(abs)) }

func (s *OSSystem) ReadDir(abs string) ([]string, error) {
	entries, err := os.ReadDir(s.Path(abs))
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.Name())
	}
	sort.Strings(out)
	return out, nil
}

func (s *OSSystem) WriteFile(abs string, data []byte, mode fs.FileMode) error {
	if s.WriteFileFunc != nil {
		return s.WriteFileFunc(abs, data, mode)
	}
	p := s.Path(abs)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return pki.WriteFileAtomic(p, data, mode)
}

func (s *OSSystem) RemoveFile(abs string) error {
	if s.RemoveFileFunc != nil {
		return s.RemoveFileFunc(abs)
	}
	if err := os.Remove(s.Path(abs)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// WriteKernel writes a tunable in place (a kernel file cannot be replaced by a rename). Under a
// fake root the file is created.
func (s *OSSystem) WriteKernel(abs, value string) error {
	p := s.Path(abs)
	flags := os.O_WRONLY
	if s.fake() {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		flags |= os.O_CREATE | os.O_TRUNC
	}
	f, err := os.OpenFile(p, flags, 0o644)
	if err != nil {
		return err
	}
	_, werr := f.WriteString(value + "\n")
	cerr := f.Close()
	if werr != nil {
		return fmt.Errorf("write %s: %w", abs, werr)
	}
	return cerr
}

func (s *OSSystem) Run(ctx context.Context, c Cmd) ([]byte, error) {
	if s.fake() {
		p := s.Path(CommandLog)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
		if err != nil {
			return nil, err
		}
		_, err = fmt.Fprintln(f, c.String())
		f.Close()
		return nil, err
	}
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = 20 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.Name, c.Args...)
	cmd.Env = append(os.Environ(), c.Env...)
	if c.Stdin != nil {
		cmd.Stdin = bytes.NewReader(c.Stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return stdout.Bytes(), fmt.Errorf("%s: %v: %s", c.Name, err, tail(stderr.String(), stdout.String()))
	}
	return stdout.Bytes(), nil
}

// tail keeps the end of a failed program's output, where the reason usually is.
func tail(parts ...string) string {
	const max = 2048
	out := strings.TrimSpace(strings.Join(parts, "\n"))
	if len(out) > max {
		out = "…" + out[len(out)-max:]
	}
	return out
}

func (s *OSSystem) LookPath(name string) bool {
	if !s.fake() {
		_, err := exec.LookPath(name)
		return err == nil
	}
	for _, dir := range []string{"/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"} {
		if st, err := os.Stat(s.Path(dir + "/" + name)); err == nil && !st.IsDir() {
			return true
		}
	}
	return false
}
