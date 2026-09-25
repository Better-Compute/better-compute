package health

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseXid(t *testing.T) {
	x, ok := ParseXid("NVRM: Xid (PCI:0000:18:00): 79, pid=1234, name=python, GPU has fallen off the bus.")
	if !ok || x.Bus != "00000000:18:00.0" || x.Code != 79 || !strings.Contains(x.Message, "fallen off the bus") {
		t.Fatalf("xid = %+v %v", x, ok)
	}
	if _, ok := ParseXid("NVRM: loading NVIDIA UNIX x86_64 Kernel Module"); ok {
		t.Fatal("parsed a non-XID line")
	}
}

func TestWatchKmsgReadsRecords(t *testing.T) {
	kmsg := strings.Join([]string{
		"6,1234,5678,-;usb 1-1: new device",
		"3,1235,5679,-;NVRM: Xid (PCI:0000:2a:00): 63, pid=0, Row Remapper: New row marked for remapping",
		"3,1236,5680,-;NVRM: Xid (PCI:0000:18:00): 48, pid=7, An uncorrectable double bit error",
	}, "\n") + "\n"
	var got []Xid
	if err := WatchKmsg(context.Background(), strings.NewReader(kmsg), func(x Xid) { got = append(got, x) }); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Code != 63 || got[0].Bus != "00000000:2A:00.0" || got[1].Code != 48 {
		t.Fatalf("xids = %+v", got)
	}
}

func TestPressureSamples(t *testing.T) {
	root := t.TempDir()
	write := func(p, s string) {
		full := filepath.Join(root, filepath.FromSlash(p))
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	p := &Pressure{Root: root}
	if p.Sample() != nil {
		t.Fatal("pressure without PSI")
	}
	write("/proc/pressure/cpu", "some avg10=12.50 avg60=3.00 avg300=1.00 total=100\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")
	write("/proc/pressure/memory", "some avg10=0.75 avg60=0 avg300=0 total=1\nfull avg10=0.10 avg60=0 avg300=0 total=1\n")
	write("/proc/pressure/io", "some avg10=4.00 avg60=0 avg300=0 total=1\n")
	write("/proc/stat", "cpu  100 0 100 700 0 0 0 100 0 0\ncpu0 1 1 1 1 1 1 1 1\n")
	first := p.Sample()
	if first == nil || first.CpuSomeAvg10 != 12.5 || first.MemorySomeAvg10 != 0.75 || first.IoSomeAvg10 != 4 || first.StealPct != 0 {
		t.Fatalf("first = %v", first)
	}
	// 100 more jiffies, 25 of them stolen.
	write("/proc/stat", "cpu  150 0 100 725 0 0 0 125 0 0\n")
	if second := p.Sample(); second.StealPct != 25 {
		t.Fatalf("steal = %v", second.StealPct)
	}
}
