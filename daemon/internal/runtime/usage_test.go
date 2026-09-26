package runtime

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseDomstats(t *testing.T) {
	got := parseDomstats([]byte(`Domain: 'inst_web'
  state.state=1
  cpu.time=2500000000
  balloon.rss=524288
  net.count=2
  net.0.rx.bytes=100
  net.0.tx.bytes=10
  net.1.rx.bytes=5
  net.1.tx.bytes=1
  block.count=1
  block.0.rd.bytes=4096
  block.0.wr.bytes=8192

Domain: 'inst_db'
  cpu.time=1000000000
`))
	web := got["inst_web"]
	if web != (Usage{CPUSeconds: 2.5, MemoryBytes: 512 << 20, NetRxBytes: 105, NetTxBytes: 11, IOReadBytes: 4096, IOWriteBytes: 8192}) {
		t.Fatalf("web = %+v", web)
	}
	if got["inst_db"].CPUSeconds != 1 || len(got) != 2 {
		t.Fatalf("usage = %+v", got)
	}
}

func TestCgroupAndTapUsage(t *testing.T) {
	root := t.TempDir()
	oldCg, oldNet := cgroupRoot, sysClassNet
	cgroupRoot, sysClassNet = filepath.Join(root, "cgroup"), filepath.Join(root, "net")
	t.Cleanup(func() { cgroupRoot, sysClassNet = oldCg, oldNet })
	write := func(path, content string) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	dir := filepath.Join(cgroupRoot, "bcd-instances.slice", unitName("inst_1"))
	write(filepath.Join(dir, "cpu.stat"), "usage_usec 3500000\nuser_usec 3000000\n")
	write(filepath.Join(dir, "memory.current"), "1073741824\n")
	write(filepath.Join(dir, "io.stat"), "259:0 rbytes=100 wbytes=200 rios=1 wios=2\n8:0 rbytes=1 wbytes=2\n")
	write(filepath.Join(sysClassNet, TapName("inst_1", 0), "statistics", "tx_bytes"), "700\n")
	write(filepath.Join(sysClassNet, TapName("inst_1", 0), "statistics", "rx_bytes"), "70\n")
	u, ok := cgroupUsage(dir)
	if !ok {
		t.Fatal("no usage")
	}
	tapUsage(&u, "inst_1", 1)
	if u != (Usage{CPUSeconds: 3.5, MemoryBytes: 1 << 30, IOReadBytes: 101, IOWriteBytes: 202, NetRxBytes: 700, NetTxBytes: 70}) {
		t.Fatalf("usage = %+v", u)
	}
	if _, ok := cgroupUsage(filepath.Join(root, "absent")); ok {
		t.Fatal("an absent cgroup read as usage")
	}
}
