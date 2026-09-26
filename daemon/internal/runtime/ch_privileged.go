package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
)

// cloud-hypervisor under bcd helper (an unprivileged bcd node). The node keeps owning every file of
// its instances and lets each VMM's user at its own instance's through POSIX ACLs (a file's owner
// may set them); root does only what needs root, each step from what it checks itself:
//   - the taps (created owned by the node, which then opens them, on bridges of root's config);
//   - VFIO (the IOMMU groups of this host's GPUs on vfio-pci, their devices given to the VMM's user);
//   - the VMM's unit, built by root (CHLaunch) from the record it validates: never a command line of
//     the node's.
// The node still talks to the VMM's API over its socket: whatever it asks there (vm.create's disks
// and firmware, vm.add-disk) the VMM can only reach as its own user, inside its mount namespace
// (its instance, its base image and volumes bound in, /var and /run hidden), with its ACLs; nothing
// there is root's.

// CHPrivileged does cloud-hypervisor's root-only steps (bcd helper's ch.* ops).
type CHPrivileged interface {
	// Taps creates TapName(id, i) for each network (a bridge), owned by the node, bridged and up.
	Taps(ctx context.Context, id string, networks []string) error
	// Untaps deletes TapName(id, 0..nics-1).
	Untaps(ctx context.Context, id string, nics int) error
	// BindVFIO puts the IOMMU groups of the record's GPUs on vfio-pci and gives their devices to the
	// record's VMM user; ReleaseVFIO takes them back (root's, unbound).
	BindVFIO(ctx context.Context, id string) error
	ReleaseVFIO(ctx context.Context, id string, addrs []string) error
	// Launch starts the VMM unit root builds from the instance's record; Stop stops it and answers
	// its ActiveState (its VFIO devices go back to root).
	Launch(ctx context.Context, id string) error
	Stop(ctx context.Context, id string) (string, error)
}

// ---- root's side --------------------------------------------------------------------------------

// CHRootPolicy is what root checks a cloud-hypervisor instance against.
type CHRootPolicy struct {
	// Dir is the runtime's directory (<data_dir>/cloud-hypervisor: instances/, images/) and Volumes
	// the volume store's (<data_dir>/volumes).
	Dir, Volumes string
	// Binary is root's cloud-hypervisor (an absolute path from root's configuration).
	Binary string
	// CheckFile checks a file of the node's as root: regular, the node's, one link, no symlink on the
	// way from its policy directory (helper.NodeFileCheck).
	CheckFile func(path string) error
	// GPUAddress maps a GPU of this host to its PCI address; PCI are the addresses root allows.
	GPUAddress func(uuid string) (string, bool)
	PCI        map[string]bool
	// LiveUIDs are the VMM users of the bcd-ch units running now, by instance.
	LiveUIDs func(ctx context.Context) (map[string]uint32, error)
}

var hexImage = regexp.MustCompile(`^[0-9a-f]{64}\.(qcow2|raw)$`)

// CHRecord reads and checks, as root, an instance's record (instances/<id>/vm.json, written by the
// node): what it names must be bcd's files of that instance, its VMM user in the VMM range.
func CHRecord(p CHRootPolicy, id string) (*chRecord, error) {
	if !instanceID.MatchString(id) {
		return nil, fmt.Errorf("instance id %q", id)
	}
	dir := filepath.Join(p.Dir, "instances", id)
	file := filepath.Join(dir, "vm.json")
	if p.CheckFile == nil {
		return nil, errors.New("no file check configured")
	}
	if err := p.CheckFile(file); err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var r chRecord
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	if r.ID != id || r.Managed != chManaged {
		return nil, fmt.Errorf("instances/%s is not bcd's", id)
	}
	if r.UID < vmmUIDBase || r.UID >= vmmUIDBase+vmmUIDs {
		return nil, fmt.Errorf("VMM user %d is outside bcd's range", r.UID)
	}
	if r.VCPU == 0 || r.VCPU > 1024 || r.MemoryBytes < 64<<20 || r.MemoryBytes > 64<<40 {
		return nil, fmt.Errorf("%d vCPUs and %d bytes of memory are out of bounds", r.VCPU, r.MemoryBytes)
	}
	// Nothing in the instance's directory may lead elsewhere.
	err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("%s is a symlink", path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, f := range []string{"disk.qcow2", "seed.iso"} {
		if _, statErr := os.Lstat(filepath.Join(dir, f)); statErr == nil {
			if err := p.CheckFile(filepath.Join(dir, f)); err != nil {
				return nil, err
			}
		}
	}
	if r.Base != "" {
		if filepath.Dir(r.Base) != filepath.Join(p.Dir, "images") || !hexImage.MatchString(filepath.Base(r.Base)) ||
			filepath.Ext(r.Base) != "."+r.BaseFormat {
			return nil, fmt.Errorf("base image %s is not one of bcd's", r.Base)
		}
		if err := p.CheckFile(r.Base); err != nil {
			return nil, err
		}
		if err := checkBase(r.Base, r.BaseFormat); err != nil {
			return nil, err
		}
	}
	disk := filepath.Join(dir, "disk.qcow2")
	if _, statErr := os.Lstat(disk); statErr == nil {
		if err := checkOverlay(disk, r.Base, r.BaseFormat); err != nil {
			return nil, err
		}
	}
	vols := &Volumes{Dir: p.Volumes}
	for _, v := range append(append([]AttachedVolume(nil), r.Volumes...), r.StartedVolumes...) {
		if !volumeIDPattern.MatchString(v.ID) || v.Path != vols.path(v.ID) {
			return nil, fmt.Errorf("volume %q at %s is not bcd's", v.ID, v.Path)
		}
		if err := p.CheckFile(v.Path); err != nil {
			return nil, err
		}
	}
	if pl := r.Placement; pl != nil {
		for _, list := range []string{pl.CPUList, pl.Mems} {
			if list != "" {
				if _, err := ParseCPUList(list); err != nil {
					return nil, err
				}
			}
		}
		pl.CPUs, _ = ParseCPUList(pl.CPUList)
		pl.MemNodes, _ = ParseCPUList(pl.Mems)
		if pl.HugepageSize != 0 && pl.HugepageSize != Hugepage2Mi && pl.HugepageSize != Hugepage1Gi {
			return nil, fmt.Errorf("hugepage size %d", pl.HugepageSize)
		}
	}
	for _, gpu := range r.GPUs {
		addr, ok := "", false
		if p.GPUAddress != nil {
			addr, ok = p.GPUAddress(gpu)
		}
		if !ok || !p.PCI[addr] {
			return nil, fmt.Errorf("GPU %s is not one of this host's", gpu)
		}
	}
	return &r, nil
}

// CHLaunch checks an instance as root (CHRecord) and returns the systemd-run arguments of its VMM
// unit, built from that check: its VMM user must be no other running unit's. The caller holds a lock
// across the check and the launch, so two launches cannot take one user.
func CHLaunch(ctx context.Context, p CHRootPolicy, id string) ([]string, error) {
	r, err := CHRecord(p, id)
	if err != nil {
		return nil, err
	}
	if p.LiveUIDs == nil {
		return nil, errors.New("no running-units check configured")
	}
	live, err := p.LiveUIDs(ctx)
	if err != nil {
		return nil, fmt.Errorf("the running VMM units: %w", err)
	}
	for other, uid := range live {
		if other != id && uid == r.UID {
			return nil, fmt.Errorf("VMM user %d is instance %s's", r.UID, other)
		}
	}
	if !filepath.IsAbs(p.Binary) {
		return nil, fmt.Errorf("the cloud-hypervisor binary %q is not an absolute path", p.Binary)
	}
	c := &CloudHypervisor{Dir: p.Dir, Binary: p.Binary, rootShared: true}
	return c.launchArgs(r), nil
}

// CHGPU is one GPU of a checked record.
type CHGPU struct{ UUID, Addr string }

// CHGPUs are a checked record's GPUs, and its VMM user (root's ch.vfio).
func CHGPUs(p CHRootPolicy, id string) (uid uint32, gpus []CHGPU, err error) {
	r, err := CHRecord(p, id)
	if err != nil {
		return 0, nil, err
	}
	for _, gpu := range r.GPUs {
		addr, _ := p.GPUAddress(gpu)
		gpus = append(gpus, CHGPU{UUID: gpu, Addr: addr})
	}
	return r.UID, gpus, nil
}

// ---- the node's side ----------------------------------------------------------------------------

func (c *CloudHypervisor) nodeUID() int {
	if c.NodeUID != 0 {
		return c.NodeUID
	}
	return os.Getuid()
}

// grantFiles lets the VMM's user at its instance's files (the node keeps them): the directory and
// what is in it, and, inherited, what the VMM creates there; the node gets what the VMM creates.
func (c *CloudHypervisor) grantFiles(r *chRecord) error {
	dir := c.instanceDir(r.ID)
	for _, uid := range []int{int(r.UID), c.nodeUID()} {
		if err := aclGrant(dir, uid, aclRWX, true); err != nil {
			return fmt.Errorf("%s: %w", dir, err)
		}
	}
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == dir {
			return err
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("%s is a symlink", path)
		}
		perm := uint16(aclRW)
		if d.IsDir() {
			perm = aclRWX
		}
		return aclGrant(path, int(r.UID), perm, d.IsDir())
	})
}

// giveTo lets the VMM's user at one path of the node's: an ACL entry under the helper, ownership
// when bcd is root.
func (c *CloudHypervisor) giveTo(path string, uid int) error {
	if !c.shared() {
		return c.chown(path, uid)
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	perm := uint16(aclRW)
	if info.IsDir() {
		perm = aclRWX
	}
	return aclGrant(path, uid, perm, info.IsDir())
}

// startedNICs: how many taps an instance may have (its NICs now and when it started).
func startedNICs(r *chRecord) int {
	return slices.Max([]int{len(r.Networks), r.StartedNICs})
}
