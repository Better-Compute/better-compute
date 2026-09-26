package runtime

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// Persistent host volumes (agent memory; InstancesSection.volumes): disks kept on the host across
// the instances that attach them. Each is a sparse raw file, <id>.raw (0600, root's at rest), with
// its serial beside it in <id>.json. Raw, not qcow2: its format is fixed (never probed), it has no
// header a VMM could rewrite, and it grows by truncation, safely while attached (the guest sees the
// new size at its next start). A volume never shrinks, and a destroyed one's blocks are discarded
// before it is unlinked.

var (
	volumeIDPattern     = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
	volumeSerialPattern = regexp.MustCompile(`^[a-z0-9-]{1,20}$`)
)

// VolumeDir is where a data directory keeps its volumes (the agent and the runtimes share it).
func VolumeDir(dataDir string) string { return filepath.Join(dataDir, "volumes") }

// Volumes is the host's volume store.
type Volumes struct {
	Dir string
	// ReserveBytes is the space of the data directory's filesystem no volume may be promised (the
	// instances' overlays, bcd's journal and images); 0: 5% of it, at least 2 GiB.
	ReserveBytes uint64
	// statfs replaces the filesystem's reading in tests.
	statfs func(dir string) (total, avail uint64, err error)
}

// VolumeSpace is the data directory's filesystem as the volume store sees it. Volumes are sparse,
// so their unwritten space (Outstanding) is promised but not yet taken: a new volume or a growth
// must fit in Avail less Reserve less Outstanding, or a tenant filling its volume would leave the
// other volumes, the instances' overlays and bcd itself without space (ENOSPC).
type VolumeSpace struct {
	Total, Avail, Reserve uint64
	// Committed is the volumes' sizes, Outstanding the part of it not written yet.
	Committed, Outstanding uint64
}

// Promisable is what can still be promised to volumes.
func (s VolumeSpace) Promisable() uint64 {
	used := s.Reserve + s.Outstanding
	if s.Avail <= used {
		return 0
	}
	return s.Avail - used
}

// Space reads the data directory's filesystem and the volumes' commitments.
func (v *Volumes) Space() (VolumeSpace, error) {
	statfs := v.statfs
	if statfs == nil {
		statfs = statfsBytes
	}
	if err := os.MkdirAll(v.Dir, 0o700); err != nil {
		return VolumeSpace{}, err
	}
	total, avail, err := statfs(v.Dir)
	if err != nil {
		return VolumeSpace{}, err
	}
	s := VolumeSpace{Total: total, Avail: avail, Reserve: v.ReserveBytes}
	if s.Reserve == 0 {
		s.Reserve = max(total/20, 2<<30)
	}
	ids, err := v.List()
	if err != nil {
		return VolumeSpace{}, err
	}
	for _, id := range ids {
		info, err := os.Stat(v.path(id))
		if err != nil {
			continue
		}
		size, used := uint64(info.Size()), allocatedBytes(info)
		s.Committed += size
		if size > used {
			s.Outstanding += size - used
		}
	}
	return s, nil
}

// fits refuses growing a volume by need bytes when its filesystem cannot keep the promise.
func (v *Volumes) fits(id string, need uint64) error {
	s, err := v.Space()
	if errors.Is(err, errors.ErrUnsupported) {
		return nil // not a Linux host: nothing to read
	}
	if err != nil {
		return fmt.Errorf("volume %s: the data directory's free space: %w", id, err)
	}
	if left := s.Promisable(); need > left {
		return fmt.Errorf("volume %s: %d MiB needed, %d MiB can still be promised to volumes on this host (%d MiB free, %d MiB reserved, %d MiB promised to volumes' unwritten space)",
			id, need>>20, left>>20, s.Avail>>20, s.Reserve>>20, s.Outstanding>>20)
	}
	return nil
}

// Volume is one volume of the store.
type Volume struct {
	ID, Path, Serial string
	SizeBytes        uint64
}

// AttachedVolume is a volume as an instance attaches it.
type AttachedVolume struct {
	Volume
	ReadOnly bool
}

type volumeMeta struct {
	Serial string `json:"serial"`
}

func (v *Volumes) path(id string) string     { return filepath.Join(v.Dir, id+".raw") }
func (v *Volumes) metaPath(id string) string { return filepath.Join(v.Dir, id+".json") }

// Ensure creates hv when missing, grows it when its size grew, and records its serial. grew: an
// existing volume got bigger (running guests attaching it can be told, VolumeGrower).
func (v *Volumes) Ensure(hv *agentv1.HostVolume) (grew bool, err error) {
	id, size := hv.GetVolumeId(), hv.GetSizeBytes()
	if !volumeIDPattern.MatchString(id) {
		return false, fmt.Errorf("volume id %q", id)
	}
	if !volumeSerialPattern.MatchString(hv.GetSerial()) {
		return false, fmt.Errorf("volume %s: serial %q is not 1 to 20 of [a-z0-9-]", id, hv.GetSerial())
	}
	if size == 0 || size%512 != 0 {
		return false, fmt.Errorf("volume %s: %d bytes is not a whole number of 512-byte sectors", id, size)
	}
	if err := os.MkdirAll(v.Dir, 0o700); err != nil {
		return false, err
	}
	have := uint64(0)
	if info, err := os.Lstat(v.path(id)); err == nil {
		have = uint64(info.Size())
	}
	// Sparse, but promised: the filesystem must be able to hold what it grows by.
	if size > have {
		if err := v.fits(id, size-have); err != nil {
			return false, err
		}
	}
	f, err := os.OpenFile(v.path(id), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return false, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, fmt.Errorf("volume %s is not a regular file", id)
	}
	switch have := uint64(info.Size()); {
	case size < have:
		return false, fmt.Errorf("volume %s is %d bytes and never shrinks to %d", id, have, size)
	case size > have:
		if err := f.Truncate(int64(size)); err != nil { // sparse: no blocks until the guest writes
			return false, err
		}
		grew = have > 0
	}
	meta, _ := json.Marshal(volumeMeta{Serial: hv.GetSerial()})
	if old, err := os.ReadFile(v.metaPath(id)); err == nil && string(old) == string(meta) {
		return grew, nil
	}
	return grew, os.WriteFile(v.metaPath(id), meta, 0o600)
}

// Get is the volume id, or an error when this host has none by that id.
func (v *Volumes) Get(id string) (Volume, error) {
	if !volumeIDPattern.MatchString(id) {
		return Volume{}, fmt.Errorf("volume id %q", id)
	}
	info, err := os.Stat(v.path(id))
	if err != nil {
		return Volume{}, fmt.Errorf("volume %s is not on this host", id)
	}
	var meta volumeMeta
	raw, err := os.ReadFile(v.metaPath(id))
	if err != nil || json.Unmarshal(raw, &meta) != nil || !volumeSerialPattern.MatchString(meta.Serial) {
		return Volume{}, fmt.Errorf("volume %s has no serial", id)
	}
	return Volume{ID: id, Path: v.path(id), Serial: meta.Serial, SizeBytes: uint64(info.Size())}, nil
}

// Attached resolves spec's volumes in attach order.
func (v *Volumes) Attached(spec *agentv1.InstanceSpec) ([]AttachedVolume, error) {
	if len(spec.GetVolumes()) == 0 {
		return nil, nil
	}
	if v == nil {
		return nil, errors.New("this runtime has no volume store")
	}
	var out []AttachedVolume
	seen := map[string]bool{}
	for _, iv := range spec.GetVolumes() {
		if seen[iv.GetVolumeId()] {
			return nil, fmt.Errorf("volume %s is attached twice", iv.GetVolumeId())
		}
		seen[iv.GetVolumeId()] = true
		vol, err := v.Get(iv.GetVolumeId())
		if err != nil {
			return nil, err
		}
		out = append(out, AttachedVolume{Volume: vol, ReadOnly: iv.GetReadOnly()})
	}
	return out, nil
}

// List is the ids of the store's volumes.
func (v *Volumes) List() ([]string, error) {
	entries, err := os.ReadDir(v.Dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, e := range entries {
		if id, ok := strings.CutSuffix(e.Name(), ".raw"); ok && volumeIDPattern.MatchString(id) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids, nil
}

// Destroy discards a volume's blocks, then removes it (absent: nothing to do).
func (v *Volumes) Destroy(id string) error {
	if !volumeIDPattern.MatchString(id) {
		return fmt.Errorf("volume id %q", id)
	}
	if f, err := os.OpenFile(v.path(id), os.O_RDWR, 0); err == nil {
		info, statErr := f.Stat()
		if statErr == nil && info.Size() > 0 {
			err = discard(f, info.Size())
		}
		f.Close()
		if err != nil {
			return fmt.Errorf("volume %s: discard: %w", id, err)
		}
	}
	for _, p := range []string{v.path(id), v.metaPath(id)} {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// VolumeDisk names the i-th volume's virtio disk after the root disk (vdb onward; vdz is the
// identity rebind's).
func VolumeDisk(i int) (string, error) {
	if i < 0 || i > 23 {
		return "", fmt.Errorf("at most 24 volumes attach to one instance")
	}
	return "vd" + string(rune('b'+i)), nil
}
