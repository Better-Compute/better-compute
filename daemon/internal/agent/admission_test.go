package agent

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// fakeHostMemory writes a /proc/meminfo with total GiB (and a hugepage pool of poolKiB) and per-node
// free 2 MiB hugepages, and points host admission at it.
func fakeHostMemory(t *testing.T, totalGiB uint64, poolKiB uint64, free2Mi map[int]uint64) {
	t.Helper()
	root := t.TempDir()
	write := func(path, content string) {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("proc/meminfo", "MemTotal:       "+itoa(totalGiB<<20)+" kB\nMemAvailable:   1024 kB\nHugetlb:        "+itoa(poolKiB)+" kB\n")
	total := uint64(0)
	for node, n := range free2Mi {
		write("sys/devices/system/node/node"+itoa(uint64(node))+"/hugepages/hugepages-2048kB/free_hugepages", itoa(n)+"\n")
		total += n
	}
	write("sys/kernel/mm/hugepages/hugepages-2048kB/free_hugepages", itoa(total)+"\n")
	write("sys/kernel/mm/hugepages/hugepages-2048kB/resv_hugepages", "0\n")
	old := hostMemoryRoot
	hostMemoryRoot = root
	t.Cleanup(func() { hostMemoryRoot = old })
}

func itoa(n uint64) string { return strconv.FormatUint(n, 10) }

func instance(id string, memory uint64, p *agentv1.InstancePlacement) *agentv1.InstanceSpec {
	return &agentv1.InstanceSpec{InstanceId: id, Vcpu: 2, MemoryBytes: memory, Placement: p,
		DesiredState: agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_RUNNING}
}

func TestHostAdmissionCountsCommittedMemoryNotUse(t *testing.T) {
	// 64 GiB, of which 8 GiB is the hugepage pool: 55 GiB of normal memory after the headroom.
	fakeHostMemory(t, 64, 8<<20, map[int]uint64{0: 2048, 1: 2048})
	domains := map[string]runtime.Domain{
		// Committed though it touched nothing yet (MemAvailable says the host is almost full: ignored).
		"inst_a": {ID: "inst_a", Managed: true, State: runtime.StateRunning, MemoryBytes: 32 << 30},
		// A stopped domain commits nothing; a paused one does.
		"inst_b": {ID: "inst_b", Managed: true, State: runtime.StateStopped, MemoryBytes: 32 << 30},
		"inst_c": {ID: "inst_c", Managed: true, State: runtime.StatePaused, MemoryBytes: 8 << 30},
		// Not bcd's: never counted.
		"other": {ID: "other", State: runtime.StateRunning, MemoryBytes: 32 << 30},
	}
	m, err := probeHostMemory(domains)
	if err != nil {
		t.Fatal(err)
	}
	// 40 GiB + overheads committed of 55 GiB: 8 GiB fits once, not twice.
	if err := m.admit(instance("inst_d", 8<<30, nil), false); err != nil {
		t.Fatalf("8 GiB refused: %v", err)
	}
	err = m.admit(instance("inst_e", 8<<30, nil), false)
	if err == nil || !strings.HasPrefix(err.Error(), ResourcesExhausted) {
		t.Fatalf("the second 8 GiB start: %v", err)
	}
}

func TestHostAdmissionTakesHugepagesFromThePlacementNodes(t *testing.T) {
	fakeHostMemory(t, 64, 16<<20, map[int]uint64{0: 4096, 1: 1024})
	m, err := probeHostMemory(nil)
	if err != nil {
		t.Fatal(err)
	}
	onNode1 := &agentv1.InstancePlacement{Mems: "1", HugepageSizeBytes: runtime.Hugepage2Mi}
	// Node 1 holds 1024 free 2 MiB pages (2 GiB): a 2 GiB guest fits, a second does not, though node 0
	// has plenty (a strict binding never spills over).
	if err := m.admit(instance("inst_a", 2<<30, onNode1), false); err != nil {
		t.Fatalf("2 GiB on node 1 refused: %v", err)
	}
	err = m.admit(instance("inst_b", 2<<30, onNode1), false)
	if err == nil || !strings.Contains(err.Error(), "NUMA node(s) 1") {
		t.Fatalf("a second 2 GiB on node 1: %v", err)
	}
	// Anywhere on the host: node 0's pages serve it.
	if err := m.admit(instance("inst_c", 4<<30, &agentv1.InstancePlacement{HugepageSizeBytes: runtime.Hugepage2Mi}), false); err != nil {
		t.Fatalf("4 GiB host-wide refused: %v", err)
	}
	// A memory restore on normal pages (cloud-hypervisor) takes no hugepages, whatever its placement:
	// node 1 has none left, and it is admitted from normal memory.
	before := m.committed
	if err := m.admit(instance("inst_r", 2<<30, onNode1), true); err != nil {
		t.Fatalf("a normal-pages restore refused: %v", err)
	}
	if m.committed-before != 2<<30+vmmOverhead(2<<30) {
		t.Fatalf("restore charged %d", m.committed-before)
	}
	m.committed = before
	// Guest memory in hugepages is not normal memory: only the admitted VMMs' overhead is charged
	// (the refused start is not).
	if m.committed != vmmOverhead(2<<30)+vmmOverhead(4<<30) {
		t.Fatalf("committed %d", m.committed)
	}
}

func TestStartsOnlyWhatIsNotAlreadyRunning(t *testing.T) {
	spec := instance("inst_a", 1<<30, nil)
	if !starts(spec, runtime.Domain{}, false) || !starts(spec, runtime.Domain{State: runtime.StateStopped}, true) {
		t.Fatal("a new or stopped domain starts")
	}
	if starts(spec, runtime.Domain{State: runtime.StatePaused}, true) {
		t.Fatal("a resume is not a start")
	}
	spec.DesiredState = agentv1.InstanceDesiredState_INSTANCE_DESIRED_STATE_STOPPED
	if starts(spec, runtime.Domain{}, false) {
		t.Fatal("stopping starts nothing")
	}
}
