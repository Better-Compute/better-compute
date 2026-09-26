package helper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// cloud-hypervisor for an unprivileged bcd node (ch.<verb>). The node keeps its instances' files and
// lets each VMM's user at them with ACLs (runtime.CloudHypervisor.Privileged); root does only what
// needs root, each from what it checks itself:
//   - ch.taps / ch.untaps: TapName(instance, i) exactly, created owned by the node (so the node opens
//     it and hands the VMM the fd) on a bridge of [helper] instance_bridges, deleted by those names;
//   - ch.vfio / ch.unvfio: the IOMMU groups of the instance's GPUs (this host's, not busy as root sees
//     it, their whole group this host's GPU functions or bridges) on vfio-pci, their /dev/vfio group
//     given to the VMM's user; back to root:root 0600 and unbound;
//   - ch.launch: the VMM's unit, built by root (runtime.CHLaunch) from the record it validates, under
//     a lock so no two launches take one VMM user; never a command line of the node's;
//   - ch.stop: the unit stopped, its VFIO devices back to root; the answer is its ActiveState.
// The node still drives the VMM over its API socket: what it asks there (vm.create's disks and
// firmware, vm.add-disk) the VMM reaches only as its own user, in its mount namespace, through its
// ACLs, so nothing of root's.

// CHRequest is a ch.<verb>'s arguments.
type CHRequest struct {
	// Instance is the instance id (DomainName).
	Instance string `json:"instance"`
	// Networks are ch.taps's bridges, one per NIC; NICs is how many taps ch.untaps deletes; Addrs the
	// PCI addresses ch.unvfio gives back.
	Networks []string `json:"networks,omitempty"`
	NICs     int      `json:"nics,omitempty"`
	Addrs    []string `json:"addrs,omitempty"`
}

// CHPolicy is the host's side of what the ch.* ops may touch.
type CHPolicy struct {
	// Root is what an instance's record is checked against (runtime.CHRecord); its LiveUIDs is
	// filled in from Run when unset.
	Root runtime.CHRootPolicy
	// Bridges are the bridges a tap may join ([helper] instance_bridges).
	Bridges map[string]bool
	// NodeUID owns the taps.
	NodeUID int
	// Run runs ip and systemctl/systemd-run as root.
	Run func(ctx context.Context, name string, args ...string) ([]byte, error)
	// VFIO binds and releases IOMMU groups (runtime.SysfsVFIO).
	VFIO runtime.VFIOBinder
	// Sys prefixes /sys and /dev ("": the real ones; tests set a directory).
	Sys string
	// Busy is which GPUs (UUIDs) hold work as root sees it (default rootBusyGPUs).
	Busy func(ctx context.Context) map[string]bool
}

const maxNICs = 16

var pciAddr = regexp.MustCompile(`^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$`)

func (p CHPolicy) path(abs string) string {
	if p.Sys == "" {
		return abs
	}
	return filepath.Join(p.Sys, abs)
}

// ch serves ch.<verb>.
func (s *Server) ch(ctx context.Context, verb string, req *CHRequest) (any, error) {
	if s.CHPolicy == nil {
		return nil, errors.New("cloud-hypervisor operations are not configured on this helper")
	}
	if req == nil || !DomainName.MatchString(req.Instance) {
		return nil, errors.New("ch: an instance id")
	}
	p, err := s.CHPolicy()
	if err != nil {
		return nil, err
	}
	if p.Run == nil {
		return nil, errors.New("ch: no command runner configured")
	}
	if p.Root.LiveUIDs == nil {
		p.Root.LiveUIDs = func(ctx context.Context) (map[string]uint32, error) { return liveVMMs(ctx, p.Run) }
	}
	id := req.Instance
	switch verb {
	case "taps":
		return nil, s.chTaps(ctx, p, id, req.Networks)
	case "untaps":
		if req.NICs < 0 || req.NICs > maxNICs {
			return nil, fmt.Errorf("ch.untaps: %d NICs", req.NICs)
		}
		for i := 0; i < req.NICs; i++ {
			if err := deleteTap(ctx, p, runtime.TapName(id, i)); err != nil {
				return nil, err
			}
		}
		return nil, nil
	case "vfio":
		return nil, s.chVFIO(ctx, p, id)
	case "unvfio":
		return nil, chUnVFIO(ctx, p, id, req.Addrs)
	case "launch":
		s.chMu.Lock()
		defer s.chMu.Unlock()
		args, err := runtime.CHLaunch(ctx, p.Root, id)
		if err != nil {
			return nil, err
		}
		_, err = p.Run(ctx, "systemd-run", args...)
		return nil, err
	case "stop":
		unit := "bcd-ch-" + id + ".service"
		_, _ = p.Run(ctx, "systemctl", "stop", unit)
		out, err := p.Run(ctx, "systemctl", "show", "--property=ActiveState", "--value", unit)
		if err != nil {
			return nil, err
		}
		state := strings.TrimSpace(string(out))
		if state == "inactive" || state == "failed" {
			// Its VFIO devices back to root (the VMM is gone).
			if _, gpus, err := runtime.CHGPUs(p.Root, id); err == nil {
				for _, g := range gpus {
					_ = giveGroup(p, g.Addr, 0)
				}
			}
		}
		return state, nil
	}
	return nil, fmt.Errorf("unknown operation ch.%s", verb)
}

// isTap reports whether an interface of that name exists, and whether it is a tun/tap device.
func isTap(p CHPolicy, name string) (exists, tap bool) {
	if _, err := os.Lstat(p.path("/sys/class/net/" + name)); err != nil {
		return false, false
	}
	_, err := os.Stat(p.path("/sys/class/net/" + name + "/tun_flags"))
	return true, err == nil
}

func deleteTap(ctx context.Context, p CHPolicy, name string) error {
	exists, tap := isTap(p, name)
	if !exists {
		return nil
	}
	if !tap {
		return fmt.Errorf("%s is not a tap: not bcd's to delete", name)
	}
	_, err := p.Run(ctx, "ip", "link", "delete", name)
	return err
}

func (s *Server) chTaps(ctx context.Context, p CHPolicy, id string, networks []string) error {
	if len(networks) > maxNICs {
		return fmt.Errorf("ch.taps: %d NICs", len(networks))
	}
	for i, bridge := range networks {
		if !p.Bridges[bridge] {
			return fmt.Errorf("ch.taps: %q is not an instance bridge of this host ([helper] instance_bridges)", bridge)
		}
		name := runtime.TapName(id, i)
		// A tap of that name from an earlier start is recreated; anything else of that name is refused.
		if err := deleteTap(ctx, p, name); err != nil {
			return err
		}
		for _, args := range [][]string{
			{"tuntap", "add", "dev", name, "mode", "tap", "user", strconv.Itoa(p.NodeUID)},
			{"link", "set", name, "master", bridge},
			{"link", "set", name, "up"},
		} {
			if _, err := p.Run(ctx, "ip", args...); err != nil {
				_ = deleteTap(ctx, p, name)
				return err
			}
		}
	}
	return nil
}

// groupOf is a PCI device's IOMMU group.
func groupOf(p CHPolicy, addr string) (string, error) {
	link, err := os.Readlink(p.path("/sys/bus/pci/devices/" + addr + "/iommu_group"))
	if err != nil {
		return "", fmt.Errorf("%s has no IOMMU group: %w", addr, err)
	}
	g := filepath.Base(link)
	if _, err := strconv.Atoi(g); err != nil {
		return "", fmt.Errorf("%s: IOMMU group %q", addr, g)
	}
	return g, nil
}

// checkGroup refuses a group with a device that is neither one of this host's GPUs, a function of
// one (its audio), nor a PCI bridge: giving the group's device to a VMM gives it all of them.
func checkGroup(p CHPolicy, addr string) error {
	entries, err := os.ReadDir(p.path("/sys/bus/pci/devices/" + addr + "/iommu_group/devices"))
	if err != nil {
		return fmt.Errorf("%s: its IOMMU group: %w", addr, err)
	}
	slots := map[string]bool{}
	for a := range p.Root.PCI {
		slots[a[:len(a)-1]] = true // "0000:3b:00.": the GPU's other functions
	}
	for _, e := range entries {
		dev := e.Name()
		if p.Root.PCI[dev] || (pciAddr.MatchString(dev) && slots[dev[:len(dev)-1]]) {
			continue
		}
		class, _ := os.ReadFile(p.path("/sys/bus/pci/devices/" + dev + "/class"))
		if strings.HasPrefix(strings.TrimSpace(string(class)), "0x0604") {
			continue // a bridge stays on its driver
		}
		return fmt.Errorf("the IOMMU group of %s also holds %s, which is not this host's GPU", addr, dev)
	}
	return nil
}

// giveGroup gives an address's /dev/vfio group to uid (0: back to root), 0600.
func giveGroup(p CHPolicy, addr string, uid int) error {
	g, err := groupOf(p, addr)
	if err != nil {
		return err
	}
	dev := p.path("/dev/vfio/" + g)
	if err := os.Lchown(dev, uid, uid); err != nil {
		return err
	}
	return os.Chmod(dev, 0o600)
}

func (s *Server) chVFIO(ctx context.Context, p CHPolicy, id string) error {
	uid, gpus, err := runtime.CHGPUs(p.Root, id)
	if err != nil {
		return err
	}
	busy := map[string]bool{}
	switch {
	case p.Busy != nil:
		busy = p.Busy(ctx)
	case s.HostSystem != nil:
		busy = rootBusyGPUs(ctx, s.HostSystem)
	case len(gpus) > 0:
		return errors.New("ch.vfio: root cannot see which GPUs hold work here")
	}
	if p.VFIO == nil && len(gpus) > 0 {
		return errors.New("ch.vfio: no VFIO binder configured")
	}
	for _, g := range gpus {
		if busy[anyGPU] || busy[g.UUID] {
			return fmt.Errorf("ch.vfio: GPU %s holds work", g.UUID)
		}
		if err := checkGroup(p, g.Addr); err != nil {
			return err
		}
		if err := p.VFIO.Bind(g.Addr); err != nil {
			return err
		}
		if err := giveGroup(p, g.Addr, int(uid)); err != nil {
			return err
		}
	}
	return nil
}

func chUnVFIO(ctx context.Context, p CHPolicy, id string, addrs []string) error {
	// Never one another running instance was given.
	taken := map[string]bool{}
	if live, err := p.Root.LiveUIDs(ctx); err == nil {
		for other := range live {
			if other == id {
				continue
			}
			if _, theirs, err := runtime.CHGPUs(p.Root, other); err == nil {
				for _, g := range theirs {
					taken[g.Addr] = true
				}
			}
		}
	} else {
		return fmt.Errorf("ch.unvfio: the running VMM units: %w", err)
	}
	var first error
	for _, addr := range addrs {
		if !pciAddr.MatchString(addr) || !p.Root.PCI[addr] {
			return fmt.Errorf("ch.unvfio: %q is not one of this host's GPUs", addr)
		}
		if taken[addr] {
			continue
		}
		if err := giveGroup(p, addr, 0); err != nil && first == nil {
			first = err
		}
		if p.VFIO != nil {
			if err := p.VFIO.Release(addr); err != nil && first == nil {
				first = err
			}
		}
	}
	return first
}

var vmmUnit = regexp.MustCompile(`^bcd-ch-(.+)\.service$`)

// liveVMMs are the running bcd-ch units' VMM users, by instance.
func liveVMMs(ctx context.Context, run func(ctx context.Context, name string, args ...string) ([]byte, error)) (map[string]uint32, error) {
	out, err := run(ctx, "systemctl", "list-units", "--type=service", "--state=active,activating,deactivating,reloading",
		"--no-legend", "--plain", "bcd-ch-*")
	if err != nil {
		return nil, err
	}
	live := map[string]uint32{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		m := vmmUnit.FindStringSubmatch(fields[0])
		if m == nil {
			continue
		}
		user, err := run(ctx, "systemctl", "show", "--property=User", "--value", fields[0])
		if err != nil {
			return nil, err
		}
		n, err := strconv.ParseUint(strings.TrimSpace(string(user)), 10, 32)
		if err != nil {
			return nil, fmt.Errorf("unit %s runs as %q", fields[0], strings.TrimSpace(string(user)))
		}
		live[m[1]] = uint32(n)
	}
	return live, nil
}

// CH runs a ch.<verb> through the helper; ch.stop answers the unit's ActiveState.
func (c Client) CH(ctx context.Context, verb string, req CHRequest) (string, error) {
	raw, err := c.Call(ctx, Request{Op: "ch." + verb, CH: &req})
	if err != nil || len(raw) == 0 {
		return "", err
	}
	var state string
	_ = json.Unmarshal(raw, &state)
	return state, nil
}
