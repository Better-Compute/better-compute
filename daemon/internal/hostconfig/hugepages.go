package hostconfig

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// Hugepages is the `hugepages` unit: the host's persistent huge page pools (the memory VM sandboxes
// back their guests with) and transparent huge pages.
//
// 2 MiB pages are allocated at runtime. 1 GiB pages are tried at runtime too (that works on a
// freshly booted host); when the kernel cannot find that much contiguous memory, the unit adds
// `hugepagesz=1G hugepages=N` to the kernel command line and reports a pending reboot. It never
// reboots. 1 GiB pages are mounted at /dev/hugepages1G; 2 MiB pages are systemd's /dev/hugepages.
type Hugepages struct{}

// Paths the hugepages unit reads and owns.
const (
	Hugepages2MDir   = "/sys/kernel/mm/hugepages/hugepages-2048kB"
	Hugepages1GDir   = "/sys/kernel/mm/hugepages/hugepages-1048576kB"
	Hugepages1GMount = "/dev/hugepages1G"
	THPEnabled       = "/sys/kernel/mm/transparent_hugepage/enabled"
	// GrubHugepagesFile is the GRUB drop-in (Debian family) holding the 1 GiB boot arguments.
	GrubHugepagesFile = "/etc/default/grub.d/90-bcd-hugepages.cfg"
	// HugepagesBootState records the 1 GiB count the boot loader was last set up for.
	HugepagesBootState = "/var/lib/bcd/hugepages-1g-boot"
)

type hugepagesSettings struct {
	Pages2M     *int64 `json:"pages2m"`
	Pages1G     *int64 `json:"pages1g"`
	Transparent string `json:"transparent"`
	// PerNuma makes the counts per NUMA node instead of host totals.
	PerNuma bool `json:"perNuma"`
}

func (Hugepages) Name() string { return "hugepages" }

func (h Hugepages) Plan(_ context.Context, sys System, settings json.RawMessage) ([]converge.Action, error) {
	var s hugepagesSettings
	if err := decode(h.Name(), settings, &s); err != nil {
		return nil, err
	}
	for _, n := range []*int64{s.Pages2M, s.Pages1G} {
		if n != nil && (*n < 0 || *n > 1<<24) {
			return nil, converge.Terminal(fmt.Errorf("hugepages: page counts are 0 to %d", 1<<24))
		}
	}
	switch s.Transparent {
	case "", "always", "madvise", "never":
	default:
		return nil, converge.Terminal(fmt.Errorf("hugepages.transparent: %q is not always, madvise or never", s.Transparent))
	}

	var actions []converge.Action
	if s.Pages2M != nil {
		a, err := planPools(sys, Hugepages2MDir, "2 MiB", *s.Pages2M, s.PerNuma, false)
		if err != nil {
			return nil, err
		}
		actions = append(actions, a...)
	}
	if s.Pages1G != nil {
		if _, err := sys.ReadDir(Hugepages1GDir); err != nil {
			if *s.Pages1G == 0 {
				return actions, nil
			}
			return nil, converge.Terminal(fmt.Errorf("hugepages.pages1g: this CPU or kernel has no 1 GiB pages"))
		}
		a, err := planPools(sys, Hugepages1GDir, "1 GiB", *s.Pages1G, s.PerNuma, true)
		if err != nil {
			return nil, err
		}
		actions = append(actions, a...)
		if *s.Pages1G > 0 {
			a, err := planHugetlbMount(sys)
			if err != nil {
				return nil, err
			}
			actions = append(actions, a...)
		}
	}
	if s.Transparent != "" {
		have, ok, err := readTrim(sys, THPEnabled)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, converge.Terminal(fmt.Errorf("hugepages.transparent: this kernel has no transparent huge pages"))
		}
		if selected(have) != s.Transparent {
			want := s.Transparent
			actions = append(actions, converge.Action{
				Description: "set transparent huge pages to " + want,
				Apply:       func(context.Context) error { return sys.WriteKernel(THPEnabled, want) },
			})
		}
	}
	return actions, nil
}

// selected returns the bracketed choice of a kernel selector ("always [madvise] never").
func selected(v string) string {
	for _, f := range strings.Fields(v) {
		if strings.HasPrefix(f, "[") && strings.HasSuffix(f, "]") {
			return strings.Trim(f, "[]")
		}
	}
	return strings.TrimSpace(v)
}

func readCount(sys System, abs string) (int64, error) {
	v, ok, err := readTrim(sys, abs)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, fmt.Errorf("%s does not exist", abs)
	}
	return strconv.ParseInt(v, 10, 64)
}

// NodeDir holds the NUMA nodes (node0, node1, ...).
const NodeDir = "/sys/devices/system/node"

var numaNode = regexp.MustCompile(`^node[0-9]+$`)

// planPools plans a page size's pools: the host's, or each NUMA node's with perNuma. With boot, a
// shortfall falls back to the boot loader, which reserves the host total (the kernel spreads boot
// pages over the nodes).
func planPools(sys System, dir, size string, want int64, perNuma, boot bool) ([]converge.Action, error) {
	type pool struct{ nr, label string }
	pools := []pool{{dir + "/nr_hugepages", size}}
	if perNuma {
		nodes, err := sys.ReadDir(NodeDir)
		if err != nil {
			return nil, err
		}
		pools = pools[:0]
		for _, n := range nodes {
			if numaNode.MatchString(n) {
				pools = append(pools, pool{NodeDir + "/" + n + "/hugepages/" + path.Base(dir) + "/nr_hugepages", size + " on " + n})
			}
		}
		if len(pools) == 0 {
			return nil, converge.Terminal(fmt.Errorf("hugepages.perNuma: the kernel shows no NUMA nodes"))
		}
	}
	var bootPlan func() ([]converge.Action, error)
	if boot {
		total := want * int64(len(pools))
		bootPlan = func() ([]converge.Action, error) { return planBootPages(sys, total) }
	}
	var actions []converge.Action
	for i, p := range pools {
		// The boot reservation is kept in step once, by the first pool; every pool falls back to it.
		a, err := planPool(sys, p.nr, p.label, want, bootPlan, i == 0)
		if err != nil {
			return nil, err
		}
		actions = append(actions, a...)
	}
	return actions, nil
}

// planPool sets a pool's nr_hugepages and checks what the kernel allocated. boot, when set, plans
// the boot loader's reservation (1 GiB pages): it is set up only once the kernel could not fill the
// pool at runtime, and kept in step with the count (or removed) once it was (syncBoot).
func planPool(sys System, nr, size string, want int64, boot func() ([]converge.Action, error), syncBoot bool) ([]converge.Action, error) {
	have, err := readCount(sys, nr)
	if err != nil {
		return nil, err
	}
	var actions []converge.Action
	if boot != nil && syncBoot {
		if state, _, err := readTrim(sys, HugepagesBootState); err != nil {
			return nil, err
		} else if state != "" {
			steps, err := boot()
			if err != nil {
				return nil, err
			}
			actions = append(actions, steps...)
		}
	}
	if have == want {
		return actions, nil
	}
	actions = append(actions, converge.Action{
		Description: fmt.Sprintf("set %s huge pages to %d", size, want),
		Apply: func(ctx context.Context) error {
			if err := sys.WriteKernel(nr, strconv.FormatInt(want, 10)); err != nil {
				return err
			}
			got, err := readCount(sys, nr)
			if err != nil {
				return err
			}
			if got >= want {
				return nil
			}
			short := fmt.Errorf("the kernel allocated %d of %d %s huge pages (memory is fragmented or short)", got, want, size)
			if boot == nil {
				return short
			}
			steps, err := boot()
			if err != nil {
				return fmt.Errorf("%w; %w", short, err)
			}
			for _, s := range steps {
				if err := s.Apply(ctx); err != nil {
					return fmt.Errorf("%w; %s: %w", short, s.Description, err)
				}
			}
			return fmt.Errorf("%w; the boot loader reserves them from the next boot: reboot the node", short)
		},
	})
	return actions, nil
}

// planBootPages keeps the kernel command line's 1 GiB reservation at want (none when 0): a GRUB
// drop-in and update-grub on the Debian family, grubby elsewhere.
func planBootPages(sys System, want int64) ([]converge.Action, error) {
	state, _, err := readTrim(sys, HugepagesBootState)
	if err != nil {
		return nil, err
	}
	if state == strconv.FormatInt(want, 10) || (state == "" && want == 0) {
		return nil, nil
	}
	args := fmt.Sprintf("hugepagesz=1G hugepages=%d", want)
	var steps []converge.Action
	switch {
	case sys.LookPath("update-grub"):
		if want == 0 {
			a, err := ensureAbsent(sys, GrubHugepagesFile)
			if err != nil {
				return nil, err
			}
			steps = append(steps, a...)
		} else {
			cfg := generatedHeader("hugepages") + `GRUB_CMDLINE_LINUX="$GRUB_CMDLINE_LINUX ` + args + "\"\n"
			steps = append(steps, converge.Action{
				Description: "write " + GrubHugepagesFile,
				Apply: func(context.Context) error {
					return sys.WriteFile(GrubHugepagesFile, []byte(cfg), 0o644)
				},
			})
		}
		steps = append(steps, run(sys, Cmd{Name: "update-grub"}))
	case sys.LookPath("grubby"):
		if state != "" && state != "0" {
			steps = append(steps, run(sys, Cmd{Name: "grubby", Args: []string{"--update-kernel=ALL", "--remove-args=hugepagesz=1G hugepages=" + state}}))
		}
		if want > 0 {
			steps = append(steps, run(sys, Cmd{Name: "grubby", Args: []string{"--update-kernel=ALL", "--args=" + args}}))
		}
	default:
		if want == 0 {
			return nil, nil
		}
		return nil, fmt.Errorf("hugepages.pages1g: neither update-grub nor grubby is installed to reserve 1 GiB pages at boot")
	}
	record := strconv.FormatInt(want, 10)
	steps = append(steps, converge.Action{
		Description: "record the boot reservation",
		Apply: func(context.Context) error {
			return sys.WriteFile(HugepagesBootState, []byte(record+"\n"), 0o644)
		},
	})
	return steps, nil
}

// planHugetlbMount mounts a hugetlbfs of 1 GiB pages for the VMMs.
func planHugetlbMount(sys System) ([]converge.Action, error) {
	mounts, _, err := readTrim(sys, "/proc/mounts")
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(mounts, "\n") {
		f := strings.Fields(line)
		if len(f) >= 4 && f[1] == Hugepages1GMount && f[2] == "hugetlbfs" && strings.Contains(","+f[3]+",", ",pagesize=1024M,") {
			return nil, nil
		}
	}
	return []converge.Action{
		run(sys, Cmd{Name: "mkdir", Args: []string{"-p", Hugepages1GMount}}),
		run(sys, Cmd{Name: "mount", Args: []string{"-t", "hugetlbfs", "-o", "pagesize=1G", "hugetlbfs", Hugepages1GMount}}),
	}, nil
}
