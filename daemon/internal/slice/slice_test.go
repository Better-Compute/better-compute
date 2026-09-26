package slice

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type recorder struct{ calls []string }

func (r *recorder) run(_ context.Context, name string, args ...string) error {
	r.calls = append(r.calls, name+" "+strings.Join(args, " "))
	return nil
}

func TestApplySetsTheHoldsLimits(t *testing.T) {
	root := t.TempDir()
	name := Name("alloc_1")
	dir := Dir(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	r := &recorder{}
	l := Limits{CPUs: "8-15", Mems: "1", CPUMillis: 4001, MemoryBytes: 10 << 30, Hugepages1Gi: 4}
	if err := Apply(context.Background(), r.run, root, name, l); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"systemctl start bcd-alloc-alloc_1.slice",
		"systemctl set-property --runtime bcd-alloc-alloc_1.slice AllowedCPUs=8-15 AllowedMemoryNodes=1 CPUQuota=401% MemoryMax=10737418240 MemoryHigh=9663676416",
	}
	if strings.Join(r.calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls:\n%s", strings.Join(r.calls, "\n"))
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, "hugetlb.1GB.max")); string(raw) != "4294967296" {
		t.Fatalf("hugetlb.1GB.max = %q", raw)
	}
	if raw, _ := os.ReadFile(filepath.Join(root, "/sys/fs/cgroup/bcd.slice/cgroup.subtree_control")); string(raw) != "+hugetlb" {
		t.Fatalf("hugetlb not enabled on the ancestors: %q", raw)
	}
}

func TestCheckRefusesWhatBcdDoesNotWrite(t *testing.T) {
	for name, l := range map[string]Limits{
		"bcd-alloc-x.slice":               {CPUs: "1;reboot"},
		"system.slice":                    {},
		"bcd-alloc-a-b.slice":             {},
		"bcd-alloc-ok.slice/../etc.slice": {},
	} {
		if err := Check(name, l); err == nil {
			t.Errorf("%s %+v accepted", name, l)
		}
	}
	if err := Check(Name("alloc_9"), Limits{CPUs: "0-3,8", Mems: "0"}); err != nil {
		t.Fatal(err)
	}
}

func TestRemoveNeverKillsAWorkload(t *testing.T) {
	root := t.TempDir()
	name := Name("alloc_1")
	r := &recorder{}
	// Absent: nothing to do.
	if err := Remove(context.Background(), r.run, root, name); err != nil || len(r.calls) != 0 {
		t.Fatalf("absent slice: %v %v", err, r.calls)
	}
	dir := Dir(root, name)
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "cgroup.events"), []byte("populated 1\nfrozen 0\n"), 0o644)
	if err := Remove(context.Background(), r.run, root, name); !errors.Is(err, ErrBusy) || len(r.calls) != 0 {
		t.Fatalf("busy slice: %v %v", err, r.calls)
	}
	_ = os.WriteFile(filepath.Join(dir, "cgroup.events"), []byte("populated 0\nfrozen 0\n"), 0o644)
	if err := Remove(context.Background(), r.run, root, name); err != nil || strings.Join(r.calls, "") != "systemctl stop bcd-alloc-alloc_1.slice" {
		t.Fatalf("empty slice: %v %v", err, r.calls)
	}
}
