package hostconfig

import (
	"context"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"
	"sync"
)

// FakeSystem is an in-memory host for tests: a file tree, the programs installed, and a handler
// that answers the programs run.
type FakeSystem struct {
	mu    sync.Mutex
	files map[string][]byte
	// Programs lists the programs LookPath finds.
	Programs map[string]bool
	// Handler answers Run; nil answers every command with empty output. It runs without the lock,
	// so it may call back into the FakeSystem.
	Handler func(ctx context.Context, cmd Cmd) ([]byte, error)
	// Ran records every command run, in order.
	Ran []Cmd
}

// NewFakeSystem returns an empty fake host.
func NewFakeSystem() *FakeSystem {
	return &FakeSystem{files: map[string][]byte{}, Programs: map[string]bool{}}
}

// Set writes a file (a test's setup, or a Handler's effect).
func (f *FakeSystem) Set(abs, data string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.files[path.Clean(abs)] = []byte(data)
}

// Get returns a file's content and whether it exists.
func (f *FakeSystem) Get(abs string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.files[path.Clean(abs)]
	return string(b), ok
}

// Delete removes a file.
func (f *FakeSystem) Delete(abs string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.files, path.Clean(abs))
}

// Commands returns the commands run, as "name arg ..." strings.
func (f *FakeSystem) Commands() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.Ran))
	for _, c := range f.Ran {
		out = append(out, c.String())
	}
	return out
}

func (f *FakeSystem) ReadFile(abs string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.files[path.Clean(abs)]
	if !ok {
		return nil, &fs.PathError{Op: "open", Path: abs, Err: fs.ErrNotExist}
	}
	return append([]byte(nil), b...), nil
}

func (f *FakeSystem) ReadDir(abs string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	dir := path.Clean(abs) + "/"
	seen := map[string]bool{}
	for p := range f.files {
		if rest, ok := strings.CutPrefix(p, dir); ok {
			name, _, _ := strings.Cut(rest, "/")
			seen[name] = true
		}
	}
	if len(seen) == 0 {
		return nil, &fs.PathError{Op: "open", Path: abs, Err: fs.ErrNotExist}
	}
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out, nil
}

func (f *FakeSystem) WriteFile(abs string, data []byte, _ fs.FileMode) error {
	f.Set(abs, string(data))
	return nil
}

func (f *FakeSystem) RemoveFile(abs string) error {
	f.Delete(abs)
	return nil
}

// WriteKernel stores the value followed by a newline, as the kernel shows most tunables. A tunable
// that does not exist is an error, as on a real host.
func (f *FakeSystem) WriteKernel(abs, value string) error {
	if _, ok := f.Get(abs); !ok {
		return fmt.Errorf("write %s: %w", abs, fs.ErrNotExist)
	}
	f.Set(abs, value+"\n")
	return nil
}

func (f *FakeSystem) Run(ctx context.Context, cmd Cmd) ([]byte, error) {
	f.mu.Lock()
	f.Ran = append(f.Ran, cmd)
	h := f.Handler
	f.mu.Unlock()
	if h == nil {
		return nil, nil
	}
	return h(ctx, cmd)
}

func (f *FakeSystem) LookPath(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Programs[name]
}
