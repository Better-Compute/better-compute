package runtime

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// CloudHypervisor is the cloud-hypervisor runtime (PLAN.md §12, v0.3): one cloud-hypervisor VMM per
// instance, driven over its REST API on a unix socket (docs/api.md), and run as a systemd transient
// unit (bcd-ch-<id>) so a VM outlives bcd:
//   - the disk is a qcow2 overlay on a base image downloaded once and verified (shared with
//     libvirt-kvm's layout), the user data a NoCloud seed disk (volume "cidata");
//   - NICs are persistent taps named TapName (bcd's network rules exist before them), created and
//     bridged by bcd before the VMM starts; the VMM gets their fds, never their names; GPUs pass
//     through with VFIO;
//   - each VMM runs as its instance's own unprivileged uid, confined (unitProperties);
//   - instances/<id>/vm.json is bcd's record: a directory without one is not bcd's;
//   - the serial console is a unix socket;
//   - a snapshot is a tar of the flattened disk, the seed and, with memory, cloud-hypervisor's own
//     snapshot (config.json, state.json, memory-ranges), whose paths are rewritten on restore.
type CloudHypervisor struct {
	// RuntimeName is the driver id (default "cloud-hypervisor").
	RuntimeName string
	// Dir holds images/ (base images by sha256) and instances/<id>/.
	Dir string
	// Binary is the VMM (default "cloud-hypervisor"); Firmware what it boots (default the
	// rust-hypervisor-firmware / CLOUDHV.fd path most packages install).
	Binary   string
	Firmware string
	// Exec runs a command and returns its standard output (tests replace it).
	Exec func(ctx context.Context, name string, args ...string) ([]byte, error)
	// API calls a VMM's REST API on its socket, sending files (tap fds) with the request as
	// SCM_RIGHTS (tests replace it).
	API func(ctx context.Context, socket, method, path string, body any, files []*os.File) ([]byte, int, error)
	// OpenTap opens a queue of a persistent tap (tests replace it).
	OpenTap func(name string) (*os.File, error)
	// Chown gives a path to a VMM's user (tests replace it).
	Chown func(path string, uid, gid int) error
	// VFIOGroup is a PCI device's IOMMU group (tests replace it; default from sysfs).
	VFIOGroup func(addr string) (string, error)
	// GPUAddress maps a GPU device id to its PCI address ("0000:3b:00.0") for VFIO.
	GPUAddress func(id string) (string, bool)
	// VFIO binds a passthrough GPU's IOMMU group to vfio-pci before start and releases it after
	// destroy (tests replace it; default SysfsVFIO on the real sysfs).
	VFIO VFIOBinder
	// Volumes is the host's volume store (volumes.go); nil: instances with volumes are refused.
	Volumes *Volumes
	// HTTP downloads base images (https only).
	HTTP *http.Client
	// ShutdownTimeout bounds a graceful (ACPI) shutdown before the VM is stopped (default 60 s).
	ShutdownTimeout time.Duration
	// Poll is how often a starting VMM or a shutting-down VM is checked (default 200 ms).
	Poll time.Duration
	// RebindTimeout bounds the wait for a guest's rebind acknowledgement (default RebindTimeout).
	RebindTimeout time.Duration

	mu sync.Mutex
}

// chRecord is instances/<id>/vm.json: bcd's metadata and the VM's configuration.
type chRecord struct {
	ID           string          `json:"id"`
	Managed      string          `json:"managed"` // chManaged: this directory is bcd's
	AllocationID string          `json:"allocationId,omitempty"`
	Image        string          `json:"image,omitempty"`
	Base         string          `json:"base,omitempty"` // the base image the overlay reads
	BaseFormat   string          `json:"baseFormat,omitempty"`
	UID          uint32          `json:"uid,omitempty"` // the VMM's user
	RestoredFrom string          `json:"restoredFrom,omitempty"`
	Addresses    []string        `json:"addresses,omitempty"`
	Networks     []string        `json:"networks,omitempty"`
	GPUs         []string        `json:"gpus,omitempty"`
	Config       json.RawMessage `json:"config"`
	VCPU         uint32          `json:"vcpu"`
	MemoryBytes  uint64          `json:"memoryBytes"`
	DiskBytes    uint64          `json:"diskBytes"`
	MACs         []string        `json:"macs,omitempty"`
	// Placement is the spec's (PLAN.md §3.8): the VMM unit's CPU and memory-node confinement.
	Placement *Placement `json:"placement,omitempty"`
	// GivenGroups are the VFIO group devices handed to the running VMM's user, and BoundAddrs the
	// PCI addresses put on vfio-pci for it: what stop gives back and destroy releases, even when the
	// spec dropped a GPU meanwhile (its GPUs apply only at the next start).
	GivenGroups []string `json:"givenGroups,omitempty"`
	BoundAddrs  []string `json:"boundAddrs,omitempty"`
	// Volumes are the spec's (volumes.go), bound into the VMM's unit; GivenVolumes the paths handed
	// to the running VMM's user (read-write ones), which stop gives back.
	Volumes      []AttachedVolume `json:"volumes,omitempty"`
	GivenVolumes []string         `json:"givenVolumes,omitempty"`
	// StartedVolumes are the volumes the running VM was started with, in disk order (vol<i>).
	StartedVolumes []AttachedVolume `json:"startedVolumes,omitempty"`
}

// union adds b's strings to a's, once.
func union(a, b []string) []string {
	out := append([]string(nil), a...)
	for _, s := range b {
		if !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	return out
}

const chManaged = "better-compute/cloud-hypervisor/1"

func (c *CloudHypervisor) Name() string {
	if c.RuntimeName == "" {
		return "cloud-hypervisor"
	}
	return c.RuntimeName
}

// storage is the libvirt runtime's image and seed handling, over the same directory layout.
func (c *CloudHypervisor) storage() *Libvirt {
	return &Libvirt{RuntimeName: c.Name(), Dir: c.Dir, Exec: c.Exec, HTTP: c.HTTP}
}

func (c *CloudHypervisor) run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return c.storage().run(ctx, name, args...)
}

func (c *CloudHypervisor) instanceDir(id string) string { return filepath.Join(c.Dir, "instances", id) }
func (c *CloudHypervisor) socket(id string) string {
	return filepath.Join(c.instanceDir(id), "api.sock")
}

// unitName always carries its ".service" suffix: an instance id ending in ".slice" or ".mount"
// never names another kind of unit (security review 12 L7).
func unitName(id string) string { return "bcd-ch-" + id + ".service" }

// api calls the VMM of instance id; a status above 299 is an error.
func (c *CloudHypervisor) api(ctx context.Context, id, method, path string, body any) ([]byte, error) {
	return c.apiFiles(ctx, id, method, path, body, nil)
}

// apiFiles is api sending files with the request.
func (c *CloudHypervisor) apiFiles(ctx context.Context, id, method, path string, body any, files []*os.File) ([]byte, error) {
	call := c.API
	if call == nil {
		call = unixAPI
	}
	out, status, err := call(ctx, c.socket(id), method, "/api/v1/"+path, body, files)
	if err != nil {
		return nil, err
	}
	if status > 299 {
		return out, fmt.Errorf("cloud-hypervisor %s: HTTP %d: %s", path, status, strings.TrimSpace(string(out)))
	}
	return out, nil
}

func (c *CloudHypervisor) record(id string) (*chRecord, error) {
	raw, err := os.ReadFile(filepath.Join(c.instanceDir(id), "vm.json"))
	if err != nil {
		return nil, err
	}
	var r chRecord
	if err := json.Unmarshal(raw, &r); err != nil || r.Managed != chManaged || r.ID != id {
		return nil, fmt.Errorf("instances/%s is not bcd's", id)
	}
	return &r, nil
}

func (c *CloudHypervisor) save(r *chRecord) error {
	raw, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	file := filepath.Join(c.instanceDir(r.ID), "vm.json")
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// state is the VM's state: stopped when its VMM does not answer.
func (c *CloudHypervisor) state(ctx context.Context, id string) (string, string) {
	out, err := c.api(ctx, id, http.MethodGet, "vm.info", nil)
	if err != nil {
		if _, perr := c.api(ctx, id, http.MethodGet, "vmm.ping", nil); perr != nil {
			return StateStopped, ""
		}
		return StateStopped, "" // a VMM without a VM yet
	}
	var info struct {
		State string `json:"state"`
	}
	if json.Unmarshal(out, &info) != nil {
		return StateError, "unreadable vm.info"
	}
	switch info.State {
	case "Running":
		return StateRunning, ""
	case "Paused":
		return StatePaused, ""
	case "Created", "Shutdown":
		return StateStopped, ""
	}
	return StateError, "state " + info.State
}

// ---- List ---------------------------------------------------------------------------------------

// List returns the instances bcd defined (cloud-hypervisor has no registry of its own).
func (c *CloudHypervisor) List(ctx context.Context) ([]Domain, error) {
	entries, err := os.ReadDir(filepath.Join(c.Dir, "instances"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Domain
	for _, e := range entries {
		if !e.IsDir() || !instanceID.MatchString(e.Name()) {
			continue
		}
		r, err := c.record(e.Name())
		if err != nil {
			continue
		}
		d := Domain{
			ID: r.ID, Runtime: c.Name(), Managed: true, AllocationID: r.AllocationID, Image: r.Image,
			RestoredFrom: r.RestoredFrom, Addresses: r.Addresses, MACs: r.MACs, GPUs: r.GPUs,
			VCPU: r.VCPU, MemoryBytes: r.MemoryBytes, DiskBytes: r.DiskBytes,
		}
		// A restored instance runs on normal pages (its saved config keeps none).
		if r.Placement != nil && r.RestoredFrom == "" {
			d.HugepageSize = r.Placement.HugepageSize
		}
		d.State, d.Message = c.state(ctx, r.ID)
		if d.State == StateRunning || d.State == StatePaused {
			d.Volumes = r.StartedVolumes
		}
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// ---- Ensure -------------------------------------------------------------------------------------

func (c *CloudHypervisor) firmware() string {
	if c.Firmware != "" {
		return c.Firmware
	}
	return "/usr/share/cloud-hypervisor/CLOUDHV.fd"
}

// vmConfig is the VM's cloud-hypervisor configuration (VmConfig). overlay: disk0 is bcd's qcow2
// overlay on a base image (a restored disk is flat and may name no backing file).
func (c *CloudHypervisor) vmConfig(spec *agentv1.InstanceSpec, dir string, overlay bool) (map[string]any, error) {
	// Formats are explicit, never probed; disk0's backing file is the checked base bcd named when it
	// created the overlay (checkImage refused any other).
	disks := []any{
		map[string]any{"id": "disk0", "path": filepath.Join(dir, "disk.qcow2"), "image_type": "Qcow2", "backing_files": overlay},
		map[string]any{"id": "seed", "path": filepath.Join(dir, "seed.iso"), "readonly": true, "image_type": "Raw"},
	}
	// Volumes, in attach order; the guest finds each by its serial.
	vols, err := c.Volumes.Attached(spec)
	if err != nil {
		return nil, err
	}
	for i, v := range vols {
		if _, err := VolumeDisk(i); err != nil {
			return nil, err
		}
		disks = append(disks, map[string]any{"id": fmt.Sprintf("vol%d", i), "path": v.Path, "readonly": v.ReadOnly,
			"image_type": "Raw", "serial": v.Serial})
	}
	var nets []any
	for i, nic := range spec.GetNics() {
		// No tap name: the VMM gets the tap's fd (start).
		nets = append(nets, map[string]any{"id": fmt.Sprintf("net%d", i), "mac": nic.GetMac()})
	}
	var devices []any
	for _, gpu := range spec.GetGpuDeviceIds() {
		addr := ""
		if c.GPUAddress != nil {
			addr, _ = c.GPUAddress(gpu)
		}
		if pciAddress.FindStringSubmatch(addr) == nil {
			return nil, fmt.Errorf("GPU %s has no PCI address on this host", gpu)
		}
		devices = append(devices, map[string]any{"path": "/sys/bus/pci/devices/" + addr + "/"})
	}
	placement, err := PlacementOf(spec)
	if err != nil {
		return nil, err
	}
	cpus := map[string]any{"boot_vcpus": spec.GetVcpu(), "max_vcpus": spec.GetVcpu()}
	memory := map[string]any{"size": spec.GetMemoryBytes()}
	// Placement (PLAN.md §3.8): a pinned vCPU runs on its own host CPU (a floating set is the unit's
	// AllowedCPUs); hugepage-backed memory comes from a hugetlb memfd, so the confined VMM needs no
	// hugetlbfs mount, and the pages are taken from the unit's NUMA nodes (AllowedMemoryNodes).
	if placement.Pinned(spec.GetVcpu()) {
		var affinity []any
		for i, cpu := range placement.CPUs {
			affinity = append(affinity, map[string]any{"vcpu": i, "host_cpus": []int{cpu}})
		}
		cpus["affinity"] = affinity
	}
	if placement != nil && placement.HugepageSize != 0 {
		memory["hugepages"], memory["hugepage_size"] = true, placement.HugepageSize
	}
	cfg := map[string]any{
		"cpus":    cpus,
		"memory":  memory,
		"payload": map[string]any{"firmware": c.firmware()},
		"disks":   disks,
		"serial":  map[string]any{"mode": "Socket", "socket": filepath.Join(dir, "serial.sock")},
		"console": map[string]any{"mode": "Off"},
		"rng":     map[string]any{"src": "/dev/urandom"},
	}
	if len(nets) > 0 {
		cfg["net"] = nets
	}
	if len(devices) > 0 {
		cfg["devices"] = devices
	}
	if placement != nil && placement.Balloon {
		// Free pages go back to the host; the guest keeps what it uses (never with hugepages).
		cfg["balloon"] = map[string]any{"size": 0, "deflate_on_oom": true, "free_page_reporting": true}
	}
	return cfg, nil
}

// Ensure defines the instance of spec (a new one from its image or a restored snapshot), or updates
// an existing one's configuration (resources, NICs, GPUs apply at its next start; a disk only
// grows, online through vm.resize-disk).
func (c *CloudHypervisor) Ensure(ctx context.Context, spec *agentv1.InstanceSpec, userData []byte, restore *Restore) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	id := spec.GetInstanceId()
	if !instanceID.MatchString(id) {
		return fmt.Errorf("instance id %q", id)
	}
	// Checked before anything is created: a spec the host cannot apply exactly is refused whole.
	placement, err := PlacementOf(spec)
	if err != nil {
		return err
	}
	if _, err := c.Volumes.Attached(spec); err != nil {
		return err
	}
	dir := c.instanceDir(id)
	r, err := c.record(id)
	if err != nil {
		if _, statErr := os.Stat(dir); statErr == nil {
			return fmt.Errorf("instances/%s exists and is not bcd's", id)
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		uid, err := c.freeUID()
		if err != nil {
			os.RemoveAll(dir)
			return err
		}
		r = &chRecord{ID: id, Managed: chManaged, AllocationID: spec.GetAllocationId(), UID: uid}
		st := c.storage()
		switch {
		case restore != nil:
			if err := c.unpack(restore, dir, spec); err != nil {
				os.RemoveAll(dir)
				return err
			}
			// A snapshot is the tenant's bytes: its disk may name no backing file (review 12 H2).
			if err := st.checkRestored(ctx, dir); err != nil {
				os.RemoveAll(dir)
				return err
			}
			r.RestoredFrom = restore.Sha256
		default:
			img := spec.GetImage()
			if img.GetFormat() == "iso" {
				os.RemoveAll(dir)
				return errors.New("cloud-hypervisor boots disk images, not an iso")
			}
			base, err := st.baseImage(ctx, img)
			if err != nil {
				os.RemoveAll(dir)
				return err
			}
			r.Image, r.Base, r.BaseFormat = hex.EncodeToString(img.GetSha256()), base, img.GetFormat()
			// -u: the base (checked by baseImage) is not opened; its format is stated.
			if _, err := c.run(ctx, "qemu-img", "create", "-f", "qcow2", "-u", "-F", img.GetFormat(), "-b", base,
				filepath.Join(dir, "disk.qcow2"), strconv.FormatUint(spec.GetDiskBytes(), 10)); err != nil {
				os.RemoveAll(dir)
				return err
			}
			if err := st.seed(ctx, id, spec.GetNics(), userData, dir); err != nil {
				os.RemoveAll(dir)
				return err
			}
		}
	} else if spec.GetDiskBytes() > r.DiskBytes && r.DiskBytes > 0 {
		if state, _ := c.state(ctx, id); state == StateStopped {
			if err := c.checkDisk(r); err != nil {
				return err
			}
			if _, err := c.run(ctx, "qemu-img", "resize", "-f", "qcow2", filepath.Join(dir, "disk.qcow2"), strconv.FormatUint(spec.GetDiskBytes(), 10)); err != nil {
				return err
			}
		} else if _, err := c.api(ctx, id, http.MethodPut, "vm.resize-disk", map[string]any{"disk": "disk0", "desired_size": spec.GetDiskBytes()}); err != nil {
			return err
		}
	} else if spec.GetDiskBytes() < r.DiskBytes {
		return errors.New("a disk cannot shrink")
	}
	cfg, err := c.vmConfig(spec, dir, r.RestoredFrom == "")
	if err != nil {
		return err
	}
	r.Config, _ = json.Marshal(cfg)
	r.VCPU, r.MemoryBytes, r.DiskBytes = spec.GetVcpu(), spec.GetMemoryBytes(), spec.GetDiskBytes()
	r.Placement = placement
	r.GPUs = append([]string(nil), spec.GetGpuDeviceIds()...)
	if r.Volumes, err = c.Volumes.Attached(spec); err != nil {
		return err
	}
	r.Addresses, r.MACs, r.Networks = nil, nil, nil
	for _, n := range spec.GetNics() {
		r.Addresses = append(r.Addresses, n.GetAddresses()...)
		r.MACs = append(r.MACs, n.GetMac())
		r.Networks = append(r.Networks, n.GetNetwork())
	}
	return c.save(r)
}

// ---- SetState / Destroy -------------------------------------------------------------------------

func (c *CloudHypervisor) poll() time.Duration {
	if c.Poll > 0 {
		return c.Poll
	}
	return 200 * time.Millisecond
}

// VMM users: each instance's VMM runs as its own uid (and group) from this block, recorded in its
// vm.json; the plugin sandbox's block starts right after it.
const (
	vmmUIDBase = 0x7FFD0000
	vmmUIDs    = 0x10000
)

// freeUID is the lowest VMM uid no instance's record holds.
func (c *CloudHypervisor) freeUID() (uint32, error) {
	used := map[uint32]bool{}
	entries, _ := os.ReadDir(filepath.Join(c.Dir, "instances"))
	for _, e := range entries {
		if r, err := c.record(e.Name()); err == nil && r.UID != 0 {
			used[r.UID] = true
		}
	}
	for i := uint32(0); i < vmmUIDs; i++ {
		if !used[vmmUIDBase+i] {
			return vmmUIDBase + i, nil
		}
	}
	return 0, errors.New("no free VMM uid")
}

// unitProperties confine a VMM (security review 12 H2, M3, and the verification of 933c51b):
//   - it runs as its instance's own uid with no capabilities at all, so no VMM can read another's
//     /proc, files or memory, and a VMM holds no root file it could open;
//   - it has no network: its taps come as open fds (bcd opens and bridges them), so it needs neither
//     CAP_NET_ADMIN nor any socket family but AF_UNIX (its API, by path);
//   - its mount namespace hides /run (systemd's, D-Bus's and every daemon's sockets), /var (bcd's
//     data, libvirt's, other instances) and bcd's and sshd's configuration; only its own instance
//     (read-write) and its base image (read-only) are bound back;
//   - the only devices it can open are KVM and, with GPUs, VFIO;
//   - its memory, tasks and CPU are bounded by its flavor, plus overhead.
func (c *CloudHypervisor) unitProperties(r *chRecord) []string {
	dir := c.instanceDir(r.ID)
	id := strconv.FormatUint(uint64(r.UID), 10)
	props := []string{
		"User=" + id, "Group=" + id, "CapabilityBoundingSet=", "AmbientCapabilities=", "NoNewPrivileges=yes",
		"PrivateNetwork=yes", "RestrictAddressFamilies=AF_UNIX", "IPAddressDeny=any",
		"DevicePolicy=closed", "DeviceAllow=/dev/kvm rw",
		"ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "ProtectProc=invisible",
		"ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectKernelLogs=yes", "ProtectControlGroups=yes",
		"ProtectClock=yes", "ProtectHostname=yes", "RestrictSUIDSGID=yes", "RestrictRealtime=yes", "RestrictNamespaces=yes",
		"LockPersonality=yes", "UMask=0077",
		"SystemCallFilter=~@debug @mount @reboot @swap @module @raw-io @clock @cpu-emulation @obsolete",
		"TemporaryFileSystem=/run:ro", "TemporaryFileSystem=/var:ro",
		"InaccessiblePaths=-/etc/bcd -/etc/ssh -/etc/libvirt -/etc/shadow -/etc/gshadow",
		"BindPaths=" + dir, "ReadWritePaths=" + dir,
		"LimitMEMLOCK=infinity",
		fmt.Sprintf("MemoryMax=%d", chMemoryMax(r)),
		fmt.Sprintf("TasksMax=%d", 4*r.VCPU+128),
		fmt.Sprintf("CPUQuota=%d%%", 100*(r.VCPU+1)),
	}
	if !strings.HasPrefix(filepath.Clean(c.Dir)+"/", "/var/") {
		props = append(props, "TemporaryFileSystem="+filepath.Join(c.Dir, "instances")+":ro",
			"TemporaryFileSystem="+filepath.Join(c.Dir, "images")+":ro")
	}
	if r.Base != "" {
		props = append(props, "BindReadOnlyPaths="+r.Base)
	}
	for _, v := range r.Volumes {
		if v.ReadOnly {
			props = append(props, "BindReadOnlyPaths="+v.Path)
		} else {
			props = append(props, "BindPaths="+v.Path, "ReadWritePaths="+v.Path)
		}
	}
	if kvm, err := user.LookupGroup("kvm"); err == nil {
		props = append(props, "SupplementaryGroups="+kvm.Gid)
	}
	if len(r.GPUs) > 0 {
		props = append(props, "DeviceAllow=/dev/vfio/vfio rw", "DeviceAllow=char-vfio rw")
	}
	// Placement (PLAN.md §3.8): the whole VMM (vCPU threads included) runs on the booked CPUs and
	// allocates from the booked NUMA nodes, restored instances too (their saved config keeps no
	// affinity of its own).
	if p := r.Placement; p != nil {
		if len(p.CPUs) > 0 {
			props = append(props, "AllowedCPUs="+FormatCPUList(p.CPUs))
		}
		if len(p.MemNodes) > 0 {
			props = append(props, "AllowedMemoryNodes="+FormatCPUList(p.MemNodes))
		}
	}
	return props
}

// chMemoryMax bounds a VMM's memory cgroup: the guest's memory plus overhead. Hugepage-backed guest
// memory is charged to the hugetlb pool, not the memory cgroup, so there only the overhead counts
// (a restored instance runs on normal pages: its saved config keeps none).
func chMemoryMax(r *chRecord) uint64 {
	overhead := r.MemoryBytes/32 + 256<<20
	if r.Placement != nil && r.Placement.HugepageSize != 0 && r.RestoredFrom == "" {
		return overhead
	}
	return r.MemoryBytes + overhead
}

// launch starts the instance's VMM as a confined transient unit and waits for its API.
func (c *CloudHypervisor) launch(ctx context.Context, r *chRecord) error {
	if _, err := c.api(ctx, r.ID, http.MethodGet, "vmm.ping", nil); err == nil {
		return nil
	}
	_ = os.Remove(c.socket(r.ID))
	// The unit's TemporaryFileSystem= mounts need both directories to exist.
	if err := os.MkdirAll(filepath.Join(c.Dir, "images"), 0o700); err != nil {
		return err
	}
	binary := c.Binary
	if binary == "" {
		binary = "cloud-hypervisor"
	}
	args := []string{"--unit=" + unitName(r.ID), "--collect", "--quiet", "--slice=bcd-instances.slice"}
	for _, p := range c.unitProperties(r) {
		args = append(args, "-p", p)
	}
	args = append(args, "--", binary, "--api-socket", "path="+c.socket(r.ID))
	if _, err := c.run(ctx, "systemd-run", args...); err != nil {
		return err
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := c.api(ctx, r.ID, http.MethodGet, "vmm.ping", nil); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("the cloud-hypervisor VMM did not come up")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(c.poll()):
		}
	}
}

// taps creates the instance's taps before its VMM starts (security review 12 H1). They are
// persistent, on their network's bridge and up, so neither a guest reboot nor a failed step leaves
// a tap of a running VM off its bridge, where bcd's bridge rules do not see it. A NIC without a
// network is refused.
func (c *CloudHypervisor) taps(ctx context.Context, r *chRecord) error {
	c.deleteTaps(ctx, r)
	for i, network := range r.Networks {
		if network == "" {
			return fmt.Errorf("NIC %d has no network", i)
		}
		tap := TapName(r.ID, i)
		for _, args := range [][]string{
			{"tuntap", "add", "dev", tap, "mode", "tap"},
			{"link", "set", tap, "master", network},
			{"link", "set", tap, "up"},
		} {
			if _, err := c.run(ctx, "ip", args...); err != nil {
				c.deleteTaps(ctx, r)
				return err
			}
		}
	}
	return nil
}

// openTaps opens one queue of each tap for the VMM (it gets the fds, never the tap by name).
func (c *CloudHypervisor) openTaps(r *chRecord) ([]*os.File, error) {
	open := c.OpenTap
	if open == nil {
		open = openTap
	}
	var files []*os.File
	for i := range r.Networks {
		f, err := open(TapName(r.ID, i))
		if err != nil {
			closeAll(files)
			return nil, fmt.Errorf("open tap %s: %w", TapName(r.ID, i), err)
		}
		files = append(files, f)
	}
	return files, nil
}

func closeAll(files []*os.File) {
	for _, f := range files {
		f.Close()
	}
}

// deleteTaps removes the instance's taps: those of its NICs, and any other of its name (a NIC
// removed since).
func (c *CloudHypervisor) deleteTaps(ctx context.Context, r *chRecord) {
	names := map[string]bool{}
	for i := range r.Networks {
		names[TapName(r.ID, i)] = true
	}
	prefix := strings.TrimSuffix(TapName(r.ID, 0), "0")
	if ifaces, err := net.Interfaces(); err == nil {
		for _, iface := range ifaces {
			if strings.HasPrefix(iface.Name, prefix) {
				names[iface.Name] = true
			}
		}
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	for _, n := range sorted {
		_, _ = c.run(ctx, "ip", "link", "delete", n) // absent: nothing to delete
	}
}

func (c *CloudHypervisor) chown(path string, uid int) error {
	if c.Chown != nil {
		return c.Chown(path, uid, uid)
	}
	return os.Lchown(path, uid, uid)
}

// vfioGroups are the /dev/vfio group devices of the instance's GPUs.
func (c *CloudHypervisor) vfioGroups(r *chRecord) ([]string, error) {
	group := c.VFIOGroup
	if group == nil {
		group = func(addr string) (string, error) {
			link, err := os.Readlink("/sys/bus/pci/devices/" + addr + "/iommu_group")
			return filepath.Base(link), err
		}
	}
	var out []string
	for _, gpu := range r.GPUs {
		addr := ""
		if c.GPUAddress != nil {
			addr, _ = c.GPUAddress(gpu)
		}
		if pciAddress.FindStringSubmatch(addr) == nil {
			return nil, fmt.Errorf("GPU %s has no PCI address on this host", gpu)
		}
		g, err := group(addr)
		if err != nil || !numeric.MatchString(g) {
			return nil, fmt.Errorf("GPU %s has no IOMMU group: %v", gpu, err)
		}
		out = append(out, "/dev/vfio/"+g)
	}
	return out, nil
}

var numeric = regexp.MustCompile(`^[0-9]+$`)

// giveFiles hands the instance's files (and its GPUs' VFIO groups) to its VMM's user; uid 0 gives
// them back to root.
func (c *CloudHypervisor) giveFiles(r *chRecord, uid int) error {
	err := filepath.WalkDir(c.instanceDir(r.ID), func(path string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return c.chown(path, uid)
	})
	if err != nil {
		return err
	}
	groups, err := c.vfioGroups(r)
	if err != nil {
		return err
	}
	for _, g := range groups {
		if err := c.chown(g, uid); err != nil {
			return err
		}
	}
	return nil
}

// checkDisk checks the instance's disk before anything opens it: bcd's overlay on its recorded
// base, or a flat disk naming no other file (security review 12's verification: a VMM that ran it
// could have rewritten its header).
func (c *CloudHypervisor) checkDisk(r *chRecord) error {
	return checkOverlay(filepath.Join(c.instanceDir(r.ID), "disk.qcow2"), r.Base, r.BaseFormat)
}

// start creates and bridges the taps, gives the instance to its VMM's user, then creates and boots
// the VM with the taps' fds (or restores its memory snapshot with them).
func (c *CloudHypervisor) start(ctx context.Context, r *chRecord, paused bool) error {
	if r.UID == 0 { // a record from before VMM users
		uid, err := c.freeUID()
		if err != nil {
			return err
		}
		r.UID = uid
		if err := c.save(r); err != nil {
			return err
		}
	}
	if err := c.checkDisk(r); err != nil {
		return err
	}
	if err := c.taps(ctx, r); err != nil {
		return err
	}
	// Every endpoint of each GPU's IOMMU group on vfio-pci, before its group is handed over.
	for _, addr := range c.gpuAddresses(r) {
		if err := c.vfio().Bind(addr); err != nil {
			return err
		}
		r.BoundAddrs = union(r.BoundAddrs, []string{addr})
	}
	if err := c.giveFiles(r, int(r.UID)); err != nil {
		return err
	}
	if groups, err := c.vfioGroups(r); err == nil {
		r.GivenGroups = union(r.GivenGroups, groups)
	}
	// A read-write volume is the VMM user's while it runs (exclusive: the agent never attaches one
	// read-write beside anything else); a read-only one stays root's, readable (its 0700 directory
	// is closed to everyone the unit's bind mount does not reach).
	r.StartedVolumes = append([]AttachedVolume(nil), r.Volumes...)
	for _, v := range r.Volumes {
		uid, mode := 0, os.FileMode(0o644)
		if !v.ReadOnly {
			uid, mode = int(r.UID), 0o600
			r.GivenVolumes = union(r.GivenVolumes, []string{v.Path})
		}
		if err := c.chown(v.Path, uid); err != nil {
			return err
		}
		if err := os.Chmod(v.Path, mode); err != nil {
			return err
		}
	}
	if err := c.save(r); err != nil {
		return err
	}
	if err := c.launch(ctx, r); err != nil {
		return err
	}
	taps, err := c.openTaps(r)
	if err != nil {
		return err
	}
	defer closeAll(taps)
	snapshot := filepath.Join(c.instanceDir(r.ID), "snapshot")
	if _, err := os.Stat(filepath.Join(snapshot, "state.json")); err == nil {
		body := map[string]any{"source_url": "file://" + snapshot}
		if len(taps) > 0 {
			var nets []any
			for i := range taps {
				nets = append(nets, map[string]any{"id": fmt.Sprintf("net%d", i), "num_fds": 1})
			}
			body["net_fds"] = nets
		}
		if _, err := c.apiFiles(ctx, r.ID, http.MethodPut, "vm.restore", body, taps); err != nil {
			return err
		}
		_ = os.RemoveAll(snapshot)
		if !paused {
			if _, err := c.api(ctx, r.ID, http.MethodPut, "vm.resume", nil); err != nil {
				return err
			}
		}
		return nil
	}
	if _, err := c.api(ctx, r.ID, http.MethodGet, "vm.info", nil); err != nil {
		// vm.create takes no fds: the NICs are added to the created VM, each with its tap's.
		var cfg map[string]any
		if err := json.Unmarshal(r.Config, &cfg); err != nil {
			return err
		}
		delete(cfg, "net")
		if _, err := c.api(ctx, r.ID, http.MethodPut, "vm.create", cfg); err != nil {
			return err
		}
		for i, tap := range taps {
			nic := map[string]any{"id": fmt.Sprintf("net%d", i), "mac": r.MACs[i]}
			if _, err := c.apiFiles(ctx, r.ID, http.MethodPut, "vm.add-net", nic, []*os.File{tap}); err != nil {
				return err
			}
		}
	}
	if _, err := c.api(ctx, r.ID, http.MethodPut, "vm.boot", nil); err != nil {
		if strings.Contains(err.Error(), "Cannot allocate memory") || strings.Contains(err.Error(), "ENOMEM") {
			return ErrNoCapacity
		}
		return err
	}
	if paused {
		if _, err := c.api(ctx, r.ID, http.MethodPut, "vm.pause", nil); err != nil {
			return err
		}
	}
	return nil
}

// SetState starts, stops, pauses or resumes a managed instance. A stop is an ACPI power button up to
// ShutdownTimeout, then a hard shutdown; the VMM exits with it.
func (c *CloudHypervisor) SetState(ctx context.Context, id, state string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	r, err := c.record(id)
	if err != nil {
		return fmt.Errorf("no managed domain %s", id)
	}
	current, _ := c.state(ctx, id)
	switch state {
	case StateRunning:
		switch current {
		case StatePaused:
			_, err = c.api(ctx, id, http.MethodPut, "vm.resume", nil)
		case StateStopped, StateError:
			err = c.start(ctx, r, false)
		}
	case StatePaused:
		switch current {
		case StateRunning:
			_, err = c.api(ctx, id, http.MethodPut, "vm.pause", nil)
		case StateStopped, StateError:
			err = c.start(ctx, r, true)
		}
	case StateStopped:
		err = c.stop(ctx, r)
	default:
		err = fmt.Errorf("state %q", state)
	}
	return err
}

// stop shuts the VM down and ends its VMM's unit; it fails unless systemd reports the unit
// stopped, so a VMM that outlived it is never forgotten while it runs (security review 12 M2).
// The taps go with it.
func (c *CloudHypervisor) stop(ctx context.Context, r *chRecord) error {
	id := r.ID
	timeout := c.ShutdownTimeout
	if timeout <= 0 {
		timeout = time.Minute
	}
	if st, _ := c.state(ctx, id); st == StateRunning {
		_, _ = c.api(ctx, id, http.MethodPut, "vm.power-button", nil)
		deadline := time.Now().Add(timeout)
		for time.Now().Before(deadline) {
			if st, _ := c.state(ctx, id); st == StateStopped {
				break
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(c.poll()):
			}
		}
	}
	// Each step may find nothing to do (no VM, no VMM, no unit); only the unit's state decides.
	_, _ = c.api(ctx, id, http.MethodPut, "vm.shutdown", nil)
	_, _ = c.api(ctx, id, http.MethodPut, "vmm.shutdown", nil)
	_, _ = c.run(ctx, "systemctl", "stop", unitName(id))
	out, err := c.run(ctx, "systemctl", "show", "--property=ActiveState", "--value", unitName(id))
	if err != nil {
		return fmt.Errorf("the VMM's unit: %w", err)
	}
	if s := strings.TrimSpace(string(out)); s != "inactive" && s != "failed" {
		return fmt.Errorf("the VMM's unit %s is %q after the stop", unitName(id), s)
	}
	c.deleteTaps(ctx, r)
	// The GPUs' VFIO groups go back to root: those the VMM was given, whatever the spec says now.
	groups, _ := c.vfioGroups(r)
	for _, g := range union(r.GivenGroups, groups) {
		_ = c.chown(g, 0)
	}
	// Its read-write volumes go back to root, closed again.
	for _, p := range r.GivenVolumes {
		_ = c.chown(p, 0)
		_ = os.Chmod(p, 0o600)
	}
	if len(r.GivenGroups) > 0 || len(r.GivenVolumes) > 0 {
		r.GivenGroups, r.GivenVolumes = nil, nil
		_ = c.save(r)
	}
	return nil
}

// Destroy stops a managed instance and removes its taps and directory.
func (c *CloudHypervisor) Destroy(ctx context.Context, id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !instanceID.MatchString(id) {
		return nil
	}
	r, err := c.record(id)
	if err != nil {
		if _, statErr := os.Stat(c.instanceDir(id)); statErr == nil {
			return fmt.Errorf("instances/%s is not bcd's", id)
		}
		return nil
	}
	if err := c.stop(ctx, r); err != nil {
		return err
	}
	// The GPUs go back to their host driver (best effort: a GPU left on vfio-pci is only unusable
	// to the host until the next pass or boot).
	for _, addr := range union(r.BoundAddrs, c.gpuAddresses(r)) {
		_ = c.vfio().Release(addr)
	}
	return os.RemoveAll(c.instanceDir(id))
}

// VFIOBinder puts a PCI device's IOMMU group on vfio-pci and takes it back (SysfsVFIO).
type VFIOBinder interface {
	Bind(addr string) error
	Release(addr string) error
}

func (c *CloudHypervisor) vfio() VFIOBinder {
	if c.VFIO != nil {
		return c.VFIO
	}
	return SysfsVFIO{}
}

// gpuAddresses are the PCI addresses of the instance's GPUs that have one.
func (c *CloudHypervisor) gpuAddresses(r *chRecord) []string {
	var out []string
	for _, gpu := range r.GPUs {
		if c.GPUAddress == nil {
			continue
		}
		if addr, ok := c.GPUAddress(gpu); ok && pciAddress.MatchString(addr) {
			out = append(out, addr)
		}
	}
	return out
}

// ---- snapshots ----------------------------------------------------------------------------------

// chSnapshotFiles are cloud-hypervisor's own snapshot files, under ch/ in bcd's tar.
var chSnapshotFiles = map[string]bool{"config.json": true, "state.json": true, "memory-ranges": true}

// Snapshot writes a tar of meta.json, disk.qcow2 (flattened), seed.iso and, with memory, ch/ (the
// VMM's snapshot of the paused VM, which then carries on).
func (c *CloudHypervisor) Snapshot(ctx context.Context, id string, includeMemory bool, cpuModel string, w io.Writer) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	r, err := c.record(id)
	if err != nil {
		return "", fmt.Errorf("no managed domain %s", id)
	}
	if includeMemory && len(r.GPUs) > 0 {
		// A VFIO device's state is the GPU's own: no VMM captures it.
		return "", ErrMemorySnapshotWithGPUs
	}
	if includeMemory {
		for _, v := range r.Volumes {
			if !v.ReadOnly {
				return "", ErrMemorySnapshotWithVolumes
			}
		}
	}
	if err := c.checkDisk(r); err != nil {
		return "", err
	}
	dir := c.instanceDir(id)
	work, err := os.MkdirTemp(dir, ".snapshot-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	state, _ := c.state(ctx, id)
	if state == StateRunning {
		if _, err := c.api(ctx, id, http.MethodPut, "vm.pause", nil); err != nil {
			return "", err
		}
		defer func() { _, _ = c.api(context.WithoutCancel(ctx), id, http.MethodPut, "vm.resume", nil) }()
	}
	memory := includeMemory && state != StateStopped
	chDir := filepath.Join(work, "ch")
	if memory {
		if err := os.MkdirAll(chDir, 0o700); err != nil {
			return "", err
		}
		// The VMM (its own user) writes its snapshot there.
		if err := c.chown(work, int(r.UID)); err != nil {
			return "", err
		}
		if err := c.chown(chDir, int(r.UID)); err != nil {
			return "", err
		}
		if _, err := c.api(ctx, id, http.MethodPut, "vm.snapshot", map[string]any{"destination_url": "file://" + chDir}); err != nil {
			return "", err
		}
	}
	flat := filepath.Join(work, "disk.qcow2")
	if _, err := c.run(ctx, "qemu-img", "convert", "-U", "-f", "qcow2", "-O", "qcow2", filepath.Join(dir, "disk.qcow2"), flat); err != nil {
		return "", err
	}
	meta := libvirtSnapshot{Runtime: c.Name(), IncludeMemory: memory}
	if memory {
		meta.CPUModel = cpuModel
	}
	tw := tar.NewWriter(w)
	raw, _ := json.Marshal(meta)
	if err := tarBytes(tw, "meta.json", raw); err != nil {
		return "", err
	}
	for _, f := range []string{flat, filepath.Join(dir, "seed.iso")} {
		if err := tarFile(tw, f); err != nil {
			return "", err
		}
	}
	if memory {
		names := make([]string, 0, len(chSnapshotFiles))
		for n := range chSnapshotFiles {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			if err := tarFileAs(tw, filepath.Join(chDir, n), "ch/"+n); err != nil {
				return "", err
			}
		}
	}
	return meta.CPUModel, tw.Close()
}

func tarFileAs(tw *tar.Writer, file, name string) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: info.Size()}); err != nil {
		return err
	}
	_, err = io.Copy(tw, f)
	return err
}

// unpack restores a snapshot into a new instance's directory: the disk and seed, and a memory
// snapshot under snapshot/ with its configuration's paths (disks, taps, serial) rewritten to this
// instance's. A snapshot of another runtime, or with memory of another CPU model, is refused.
func (c *CloudHypervisor) unpack(restore *Restore, dir string, spec *agentv1.InstanceSpec) error {
	f, err := os.Open(restore.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	var meta *libvirtSnapshot
	tr := tar.NewReader(f)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("not a %s snapshot: %w", c.Name(), err)
		}
		name := h.Name
		chFile := strings.HasPrefix(name, "ch/") && chSnapshotFiles[strings.TrimPrefix(name, "ch/")]
		if h.Typeflag != tar.TypeReg || !(name == "meta.json" || name == "disk.qcow2" || name == "seed.iso" || chFile) {
			return fmt.Errorf("unexpected %q in the snapshot", name)
		}
		if name == "meta.json" {
			var m libvirtSnapshot
			if err := json.NewDecoder(io.LimitReader(tr, 1<<16)).Decode(&m); err != nil {
				return fmt.Errorf("not a %s snapshot", c.Name())
			}
			if m.Runtime != c.Name() {
				return fmt.Errorf("the snapshot was taken by %s, not %s", m.Runtime, c.Name())
			}
			if m.IncludeMemory && m.CPUModel != restore.CPUModel {
				return fmt.Errorf("the snapshot's memory state needs CPU %q, this host has %q", m.CPUModel, restore.CPUModel)
			}
			meta = &m
			continue
		}
		if meta == nil {
			return errors.New("the snapshot's meta.json comes first")
		}
		target := filepath.Join(dir, name)
		if chFile {
			target = filepath.Join(dir, "snapshot", strings.TrimPrefix(name, "ch/"))
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
		}
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		_, err = io.Copy(out, tr)
		out.Close()
		if err != nil {
			return err
		}
	}
	if meta == nil {
		return fmt.Errorf("not a %s snapshot", c.Name())
	}
	if _, err := os.Stat(filepath.Join(dir, "disk.qcow2")); err != nil {
		return errors.New("the snapshot has no disk")
	}
	if !meta.IncludeMemory {
		return nil
	}
	// The VMM restores from config.json: point it at this instance's disks, taps and console.
	cfgPath := filepath.Join(dir, "snapshot", "config.json")
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return errors.New("the memory snapshot has no config.json")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var saved map[string]any
	if err := dec.Decode(&saved); err != nil {
		return errors.New("the memory snapshot's config.json is not JSON")
	}
	fresh, err := c.vmConfig(spec, dir, false)
	if err != nil {
		return err
	}
	cfg, err := restoredConfig(saved, fresh, spec)
	if err != nil {
		return err
	}
	patched, _ := json.Marshal(cfg)
	return os.WriteFile(cfgPath, patched, 0o600)
}

// restoredConfig is the configuration a memory snapshot restores with (security review 12 M1). The
// snapshot's own config.json is the tenant's: its vCPUs and memory must be the flavor's (the VM
// is accounted by the flavor), and only what its saved state needs is kept from it. Disks, NICs,
// console, devices, rng and firmware are bcd's, and anything else (fs, pmem, vsock, memory zones,
// CPU affinity, a debug console, landlock rules) is dropped.
func restoredConfig(saved, fresh map[string]any, spec *agentv1.InstanceSpec) (map[string]any, error) {
	section := func(m map[string]any, key string) map[string]any {
		s, _ := m[key].(map[string]any)
		return s
	}
	number := func(m map[string]any, key string) string {
		n, _ := m[key].(json.Number)
		return n.String()
	}
	cpus, memory := section(saved, "cpus"), section(saved, "memory")
	vcpu, mem := strconv.FormatUint(uint64(spec.GetVcpu()), 10), strconv.FormatUint(spec.GetMemoryBytes(), 10)
	if number(cpus, "boot_vcpus") != vcpu || number(cpus, "max_vcpus") != vcpu || number(memory, "size") != mem {
		return nil, fmt.Errorf("the memory snapshot's VM has %s vCPUs (at most %s) and %s bytes of memory, the instance %s and %s",
			number(cpus, "boot_vcpus"), number(cpus, "max_vcpus"), number(memory, "size"), vcpu, mem)
	}
	keep := func(m map[string]any, keys ...string) map[string]any {
		out := map[string]any{}
		for _, k := range keys {
			if v, ok := m[k]; ok {
				out[k] = v
			}
		}
		return out
	}
	restoredCPUs := keep(cpus, "boot_vcpus", "max_vcpus", "topology", "kvm_hyperv", "max_phys_bits", "features")
	// bcd's own pinning, never the snapshot's (placement, PLAN.md §3.8).
	if affinity, ok := section(fresh, "cpus")["affinity"]; ok {
		restoredCPUs["affinity"] = affinity
	}
	cfg := map[string]any{
		"cpus": restoredCPUs,
		// No hugepages: they are not charged to the unit's MemoryMax.
		"memory": keep(memory, "size", "mergeable", "shared", "prefault", "thp"),
	}
	if p := section(saved, "platform"); p != nil {
		cfg["platform"] = keep(p, "num_pci_segments", "iommu_segments", "serial_number", "uuid", "oem_strings")
	}
	for _, k := range []string{"payload", "disks", "net", "serial", "console", "rng", "devices"} {
		if v, ok := fresh[k]; ok {
			cfg[k] = v
		}
	}
	return cfg, nil
}

// GrowVolume tells a running (or paused) VM one of its volumes grew (vm.resize-disk to the file's
// size). A volume the VM was not started with has nothing to be told.
func (c *CloudHypervisor) GrowVolume(ctx context.Context, id string, v AttachedVolume) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	r, err := c.record(id)
	if err != nil {
		return err
	}
	if st, _ := c.state(ctx, id); st == StateStopped {
		return nil
	}
	i := slices.IndexFunc(r.StartedVolumes, func(s AttachedVolume) bool { return s.Path == v.Path })
	if i < 0 {
		return nil
	}
	_, err = c.api(ctx, id, http.MethodPut, "vm.resize-disk", map[string]any{"disk": fmt.Sprintf("vol%d", i), "desired_size": v.SizeBytes})
	return err
}

// Console opens a running managed instance's serial console (its socket).
func (c *CloudHypervisor) Console(ctx context.Context, id string) (io.ReadWriteCloser, error) {
	if _, err := c.record(id); err != nil {
		return nil, fmt.Errorf("no managed domain %s", id)
	}
	if st, _ := c.state(ctx, id); st != StateRunning {
		return nil, fmt.Errorf("domain %s is not running", id)
	}
	return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(c.instanceDir(id), "serial.sock"))
}

// Rebind hot-adds the identity disk (rebind.go) to a running instance and waits for its guest's
// acknowledgement; the disk is removed and its file scrubbed whatever happens. The lock is not held
// while the guest works.
func (c *CloudHypervisor) Rebind(ctx context.Context, id string, b Rebind) error {
	c.mu.Lock()
	r, err := c.record(id)
	if err != nil {
		c.mu.Unlock()
		return fmt.Errorf("no managed domain %s", id)
	}
	if st, _ := c.state(ctx, id); st != StateRunning {
		c.mu.Unlock()
		return fmt.Errorf("domain %s is not running", id)
	}
	img, nonce, err := rebindImage(b)
	if err != nil {
		c.mu.Unlock()
		return err
	}
	path := filepath.Join(c.instanceDir(id), "rebind.img")
	scrub(path)
	err = os.WriteFile(path, img, 0o600)
	if err == nil {
		err = c.chown(path, int(r.UID))
	}
	if err == nil {
		_, err = c.api(ctx, id, http.MethodPut, "vm.add-disk", map[string]any{"id": "bcrebind", "path": path, "serial": RebindSerial, "image_type": "Raw"})
	}
	c.mu.Unlock()
	if err != nil {
		scrub(path)
		return err
	}
	timeout := c.RebindTimeout
	if timeout <= 0 {
		timeout = RebindTimeout
	}
	waitErr := waitAck(ctx, path, nonce, timeout, c.poll())
	c.mu.Lock()
	_, _ = c.api(context.WithoutCancel(ctx), id, http.MethodPut, "vm.remove-device", map[string]any{"id": "bcrebind"})
	c.mu.Unlock()
	scrub(path)
	return waitErr
}
