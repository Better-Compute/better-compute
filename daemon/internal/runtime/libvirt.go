package runtime

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// Libvirt is the libvirt-kvm runtime (PLAN.md §12, v0.3), through virsh on qemu:///system and
// qemu-img:
//   - each instance's disk is a qcow2 overlay on a base image downloaded once and verified against
//     its sha256 (an iso image boots from a cdrom onto a blank disk);
//   - its user data is a NoCloud seed ISO (volume "cidata", genisoimage or xorriso);
//   - its NICs attach to the named bridges on taps named TapName, so bcd's network rules exist
//     before the tap does; GPUs pass through with VFIO;
//   - bcd marks the domains it defines in their metadata: any other domain is listed (a leak the
//     control plane reports), never touched;
//   - a snapshot is a tar of the flattened disk, the seed, and with memory the saved state.
type Libvirt struct {
	// RebindTimeout bounds the wait for a guest's rebind acknowledgement (default RebindTimeout).
	RebindTimeout time.Duration
	// RuntimeName is the driver id (default "libvirt-kvm").
	RuntimeName string
	// Dir holds images/ (base images by sha256) and instances/<id>/ (overlay, seed, saved state).
	Dir string
	// URI is the libvirt connection (default qemu:///system).
	URI string
	// Exec runs a command and returns its standard output (tests replace it).
	Exec func(ctx context.Context, name string, args ...string) ([]byte, error)
	// GPUAddress maps a GPU device id to its PCI address ("0000:3b:00.0") for VFIO.
	GPUAddress func(id string) (string, bool)
	// Volumes is the host's volume store (volumes.go); nil: instances with volumes are refused.
	Volumes *Volumes
	// HTTP downloads base images (https only; default a client without a total timeout).
	HTTP *http.Client
	// ShutdownTimeout bounds a graceful shutdown before the domain is destroyed (default 60 s).
	ShutdownTimeout time.Duration

	mu sync.Mutex
}

// metadataNS names bcd's domain metadata.
const metadataNS = "https://better-compute.dev/libvirt/1"

func (l *Libvirt) Name() string {
	if l.RuntimeName == "" {
		return "libvirt-kvm"
	}
	return l.RuntimeName
}

func (l *Libvirt) uri() string {
	if l.URI == "" {
		return "qemu:///system"
	}
	return l.URI
}

func (l *Libvirt) run(ctx context.Context, name string, args ...string) ([]byte, error) {
	if l.Exec != nil {
		return l.Exec(ctx, name, args...)
	}
	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return out, fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

func (l *Libvirt) virsh(ctx context.Context, args ...string) ([]byte, error) {
	return l.run(ctx, "virsh", append([]string{"-c", l.uri()}, args...)...)
}

func (l *Libvirt) instanceDir(id string) string { return filepath.Join(l.Dir, "instances", id) }

// instanceID guards the ids bcd turns into paths and domain names.
var instanceID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// ---- domain XML ----------------------------------------------------------------------------------

type domainXML struct {
	XMLName  xml.Name     `xml:"domain"`
	Type     string       `xml:"type,attr"`
	Name     string       `xml:"name"`
	Metadata *metadataXML `xml:"metadata,omitempty"`
	Memory   struct {
		Unit  string `xml:"unit,attr"`
		Value uint64 `xml:",chardata"`
	} `xml:"memory"`
	VCPU vcpuXML `xml:"vcpu"`
	// Placement (PLAN.md §3.8): pinned vCPUs, NUMA-bound memory, its backing.
	CPUTune       *cputuneXML       `xml:"cputune,omitempty"`
	NUMATune      *numatuneXML      `xml:"numatune,omitempty"`
	MemoryBacking *memoryBackingXML `xml:"memoryBacking,omitempty"`
	OS            struct {
		Type  string `xml:"type"`
		Boots []struct {
			Dev string `xml:"dev,attr"`
		} `xml:"boot"`
	} `xml:"os"`
	Features *struct {
		ACPI *struct{} `xml:"acpi"`
		APIC *struct{} `xml:"apic"`
	} `xml:"features,omitempty"`
	CPU *struct {
		Mode string `xml:"mode,attr"`
	} `xml:"cpu,omitempty"`
	Devices devicesXML `xml:"devices"`
}

// vcpuXML is the vCPU count; cpuset lets them float within a host CPU set (placement.cpus).
type vcpuXML struct {
	Placement string `xml:"placement,attr,omitempty"`
	CPUSet    string `xml:"cpuset,attr,omitempty"`
	Value     uint32 `xml:",chardata"`
}

type cputuneXML struct {
	VCPUPins []vcpupinXML `xml:"vcpupin"`
}

type vcpupinXML struct {
	VCPU   uint32 `xml:"vcpu,attr"`
	CPUSet string `xml:"cpuset,attr"`
}

type numatuneXML struct {
	Memory struct {
		Mode    string `xml:"mode,attr"`
		Nodeset string `xml:"nodeset,attr"`
	} `xml:"memory"`
}

type memoryBackingXML struct {
	Hugepages struct {
		Page struct {
			Size    uint64 `xml:"size,attr"`
			Unit    string `xml:"unit,attr"`
			Nodeset string `xml:"nodeset,attr,omitempty"`
		} `xml:"page"`
	} `xml:"hugepages"`
	Locked *struct{} `xml:"locked,omitempty"`
}

type memballoonXML struct {
	Model string `xml:"model,attr"`
}

type metadataXML struct {
	Instance instanceMetaXML `xml:"https://better-compute.dev/libvirt/1 instance"`
}

type instanceMetaXML struct {
	ID         string `xml:"id,attr"`
	Allocation string `xml:"allocation,omitempty"`
	Image      string `xml:"image,omitempty"`
	Format     string `xml:"format,omitempty"` // the base image's
	Restored   string `xml:"restored,omitempty"`
	Addresses  string `xml:"addresses,omitempty"`
	UserData   bool   `xml:"userData,omitempty"`
}

type devicesXML struct {
	Disks      []diskXML      `xml:"disk"`
	Interfaces []interfaceXML `xml:"interface"`
	Hostdevs   []hostdevXML   `xml:"hostdev"`
	// Explicit, so libvirt never adds its default virtio balloon to a guest that should have none.
	Memballoon *memballoonXML `xml:"memballoon,omitempty"`
	Serial     *serialXML     `xml:"serial"`
	Console    *struct {
		Type string `xml:"type,attr"`
	} `xml:"console"`
}

type serialXML struct {
	Type   string `xml:"type,attr"`
	Source *struct {
		Path string `xml:"path,attr"`
	} `xml:"source,omitempty"`
}

type diskXML struct {
	Type   string `xml:"type,attr"`
	Device string `xml:"device,attr"`
	Driver struct {
		Name string `xml:"name,attr"`
		Type string `xml:"type,attr"`
	} `xml:"driver"`
	Source struct {
		File string `xml:"file,attr"`
	} `xml:"source"`
	Target struct {
		Dev string `xml:"dev,attr"`
		Bus string `xml:"bus,attr"`
	} `xml:"target"`
	ReadOnly *struct{} `xml:"readonly"`
	Serial   string    `xml:"serial,omitempty"`
}

type interfaceXML struct {
	Type string `xml:"type,attr"`
	MAC  struct {
		Address string `xml:"address,attr"`
	} `xml:"mac"`
	Source struct {
		Bridge string `xml:"bridge,attr"`
	} `xml:"source"`
	Target struct {
		Dev string `xml:"dev,attr"`
	} `xml:"target"`
	Model struct {
		Type string `xml:"type,attr"`
	} `xml:"model"`
}

type hostdevXML struct {
	Mode    string `xml:"mode,attr"`
	Type    string `xml:"type,attr"`
	Managed string `xml:"managed,attr"`
	Source  struct {
		Address struct {
			Domain   string `xml:"domain,attr"`
			Bus      string `xml:"bus,attr"`
			Slot     string `xml:"slot,attr"`
			Function string `xml:"function,attr"`
		} `xml:"address"`
	} `xml:"source"`
}

var pciAddress = regexp.MustCompile(`^([0-9a-fA-F]{4}):([0-9a-fA-F]{2}):([0-9a-fA-F]{2})\.([0-7])$`)

// domainFor renders the domain of spec: its disks are in dir; cdrom is the base iso of an iso image.
func (l *Libvirt) domainFor(spec *agentv1.InstanceSpec, dir, cdrom string, meta instanceMetaXML) (*domainXML, error) {
	d := &domainXML{Type: "kvm", Name: spec.GetInstanceId(), Metadata: &metadataXML{Instance: meta}}
	d.Memory.Unit, d.Memory.Value = "KiB", spec.GetMemoryBytes()/1024
	d.VCPU.Value = spec.GetVcpu()
	if err := applyLibvirtPlacement(d, spec); err != nil {
		return nil, err
	}
	d.OS.Type = "hvm"
	if cdrom != "" {
		d.OS.Boots = append(d.OS.Boots, struct {
			Dev string `xml:"dev,attr"`
		}{"cdrom"})
	}
	d.OS.Boots = append(d.OS.Boots, struct {
		Dev string `xml:"dev,attr"`
	}{"hd"})
	d.Features = &struct {
		ACPI *struct{} `xml:"acpi"`
		APIC *struct{} `xml:"apic"`
	}{&struct{}{}, &struct{}{}}
	// The host's CPU as is: a memory snapshot restores only on the same model (checked by bcd).
	d.CPU = &struct {
		Mode string `xml:"mode,attr"`
	}{"host-passthrough"}
	disk := diskXML{Type: "file", Device: "disk"}
	disk.Driver.Name, disk.Driver.Type = "qemu", "qcow2"
	disk.Source.File = filepath.Join(dir, "disk.qcow2")
	disk.Target.Dev, disk.Target.Bus = "vda", "virtio"
	d.Devices.Disks = append(d.Devices.Disks, disk)
	// Volumes after the root disk, in attach order; the guest finds each by its serial.
	vols, err := l.Volumes.Attached(spec)
	if err != nil {
		return nil, err
	}
	for i, v := range vols {
		dev, err := VolumeDisk(i)
		if err != nil {
			return nil, err
		}
		vd := diskXML{Type: "file", Device: "disk", Serial: v.Serial}
		vd.Driver.Name, vd.Driver.Type = "qemu", "raw"
		vd.Source.File = v.Path
		vd.Target.Dev, vd.Target.Bus = dev, "virtio"
		if v.ReadOnly {
			vd.ReadOnly = &struct{}{}
		}
		d.Devices.Disks = append(d.Devices.Disks, vd)
	}
	cd := func(file, dev string) {
		c := diskXML{Type: "file", Device: "cdrom", ReadOnly: &struct{}{}}
		c.Driver.Name, c.Driver.Type = "qemu", "raw"
		c.Source.File = file
		c.Target.Dev, c.Target.Bus = dev, "sata"
		d.Devices.Disks = append(d.Devices.Disks, c)
	}
	if cdrom != "" {
		cd(cdrom, "sda")
	}
	cd(filepath.Join(dir, "seed.iso"), "sdb")
	for i, nic := range spec.GetNics() {
		n := interfaceXML{Type: "bridge"}
		n.MAC.Address = nic.GetMac()
		n.Source.Bridge = nic.GetNetwork()
		n.Target.Dev = TapName(spec.GetInstanceId(), i)
		n.Model.Type = "virtio"
		d.Devices.Interfaces = append(d.Devices.Interfaces, n)
	}
	for _, gpu := range spec.GetGpuDeviceIds() {
		addr := ""
		if l.GPUAddress != nil {
			addr, _ = l.GPUAddress(gpu)
		}
		m := pciAddress.FindStringSubmatch(addr)
		if m == nil {
			return nil, fmt.Errorf("GPU %s has no PCI address on this host", gpu)
		}
		h := hostdevXML{Mode: "subsystem", Type: "pci", Managed: "yes"}
		h.Source.Address.Domain, h.Source.Address.Bus = "0x"+m[1], "0x"+m[2]
		h.Source.Address.Slot, h.Source.Address.Function = "0x"+m[3], "0x"+m[4]
		d.Devices.Hostdevs = append(d.Devices.Hostdevs, h)
	}
	d.Devices.Serial = &serialXML{Type: "pty"}
	d.Devices.Console = &struct {
		Type string `xml:"type,attr"`
	}{"pty"}
	return d, nil
}

// applyLibvirtPlacement renders spec's placement (PLAN.md §3.8): vCPUs pinned one to one (vcpupin)
// or floating within the CPU set (vcpu cpuset), memory bound strictly to its NUMA nodes (numatune),
// backed by hugepages from those nodes' pools (memoryBacking), and a virtio balloon only when asked
// for (libvirt would otherwise add one to every guest).
func applyLibvirtPlacement(d *domainXML, spec *agentv1.InstanceSpec) error {
	p, err := PlacementOf(spec)
	if err != nil {
		return err
	}
	d.Devices.Memballoon = &memballoonXML{Model: "none"}
	if p == nil {
		return nil
	}
	if len(p.CPUs) > 0 {
		d.VCPU.Placement, d.VCPU.CPUSet = "static", FormatCPUList(p.CPUs)
		if p.Pinned(spec.GetVcpu()) {
			d.CPUTune = &cputuneXML{}
			for i, cpu := range p.CPUs {
				d.CPUTune.VCPUPins = append(d.CPUTune.VCPUPins, vcpupinXML{VCPU: uint32(i), CPUSet: strconv.Itoa(cpu)})
			}
		}
	}
	if len(p.MemNodes) > 0 {
		d.NUMATune = &numatuneXML{}
		d.NUMATune.Memory.Mode, d.NUMATune.Memory.Nodeset = "strict", FormatCPUList(p.MemNodes)
	}
	if p.HugepageSize != 0 {
		d.MemoryBacking = &memoryBackingXML{}
		d.MemoryBacking.Hugepages.Page.Size, d.MemoryBacking.Hugepages.Page.Unit = p.HugepageSize/1024, "KiB"
		// Guest memory in hugepages is never swapped or reclaimed: lock it, as the pages are.
		d.MemoryBacking.Locked = &struct{}{}
	}
	if p.Balloon {
		d.Devices.Memballoon.Model = "virtio"
	}
	return nil
}

func (l *Libvirt) define(ctx context.Context, d *domainXML, dir string) error {
	raw, err := xml.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	file := filepath.Join(dir, "domain.xml")
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		return err
	}
	_, err = l.virsh(ctx, "define", file)
	return err
}

// ---- List -------------------------------------------------------------------------------------

func stateOf(domstate string) string {
	switch strings.TrimSpace(domstate) {
	case "running", "in shutdown", "blocked":
		return StateRunning
	case "paused", "pmsuspended":
		return StatePaused
	case "crashed":
		return StateError
	}
	return StateStopped
}

// List returns every domain of the connection, bcd's (Managed, with their metadata) and any other.
func (l *Libvirt) List(ctx context.Context) ([]Domain, error) {
	out, err := l.virsh(ctx, "list", "--all", "--name")
	if err != nil {
		return nil, err
	}
	var domains []Domain
	for _, name := range strings.Split(string(out), "\n") {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		d := Domain{ID: name, Runtime: l.Name()}
		if st, err := l.virsh(ctx, "domstate", name); err == nil {
			d.State = stateOf(string(st))
		} else {
			d.State, d.Message = StateError, err.Error()
		}
		if raw, err := l.virsh(ctx, "dumpxml", name); err == nil {
			var x domainXML
			if xml.Unmarshal(raw, &x) == nil && x.Metadata != nil && x.Metadata.Instance.ID == name {
				m := x.Metadata.Instance
				d.Managed, d.AllocationID, d.Image, d.RestoredFrom = true, m.Allocation, m.Image, m.Restored
				d.VCPU, d.MemoryBytes = x.VCPU.Value, x.Memory.Value*1024
				if x.MemoryBacking != nil {
					d.HugepageSize = x.MemoryBacking.Hugepages.Page.Size * 1024
				}
				if m.Addresses != "" {
					d.Addresses = strings.Split(m.Addresses, ",")
				}
				for _, n := range x.Devices.Interfaces {
					d.MACs = append(d.MACs, n.MAC.Address)
				}
			}
		}
		domains = append(domains, d)
	}
	sort.Slice(domains, func(i, j int) bool { return domains[i].ID < domains[j].ID })
	return domains, nil
}

// managed reads a domain's metadata: whether it exists, and whether bcd created it.
func (l *Libvirt) managed(ctx context.Context, id string) (exists, managed bool, meta instanceMetaXML) {
	raw, err := l.virsh(ctx, "dumpxml", id)
	if err != nil {
		return false, false, meta
	}
	var x domainXML
	if xml.Unmarshal(raw, &x) != nil || x.Metadata == nil || x.Metadata.Instance.ID != id {
		return true, false, meta
	}
	return true, true, x.Metadata.Instance
}

// ---- Ensure -----------------------------------------------------------------------------------

// Ensure defines the domain of spec (a new one from its image or a restored snapshot), or updates an
// existing one's definition (resources, NICs, GPUs: they apply at its next start; a disk only grows).
func (l *Libvirt) Ensure(ctx context.Context, spec *agentv1.InstanceSpec, userData []byte, restore *Restore) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	id := spec.GetInstanceId()
	if !instanceID.MatchString(id) {
		return fmt.Errorf("instance id %q", id)
	}
	// Checked before anything is created.
	if _, err := l.Volumes.Attached(spec); err != nil {
		return err
	}
	dir := l.instanceDir(id)
	exists, managed, meta := l.managed(ctx, id)
	if exists && !managed {
		return fmt.Errorf("a domain named %s exists that bcd did not create", id)
	}
	var addrs []string
	for _, n := range spec.GetNics() {
		addrs = append(addrs, n.GetAddresses()...)
	}
	cdrom := ""
	if !exists {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		meta = instanceMetaXML{ID: id, Allocation: spec.GetAllocationId()}
		switch {
		case restore != nil:
			if err := l.unpack(restore, dir); err != nil {
				os.RemoveAll(dir)
				return err
			}
			// A snapshot is the tenant's bytes: its disk may name no backing file (review 12 H2).
			if err := l.checkRestored(ctx, dir); err != nil {
				os.RemoveAll(dir)
				return err
			}
			meta.Restored = restore.Sha256
		default:
			img := spec.GetImage()
			base, err := l.baseImage(ctx, img)
			if err != nil {
				return err
			}
			meta.Image, meta.Format = hex.EncodeToString(img.GetSha256()), img.GetFormat()
			size := strconv.FormatUint(spec.GetDiskBytes(), 10)
			if img.GetFormat() == "iso" {
				cdrom = base
				_, err = l.run(ctx, "qemu-img", "create", "-f", "qcow2", filepath.Join(dir, "disk.qcow2"), size)
			} else {
				// -u: the base (checked above) is not opened; its format is stated.
				_, err = l.run(ctx, "qemu-img", "create", "-f", "qcow2", "-u", "-F", img.GetFormat(), "-b", base, filepath.Join(dir, "disk.qcow2"), size)
			}
			if err != nil {
				return err
			}
			if err := l.seed(ctx, id, spec.GetNics(), userData, dir); err != nil {
				return err
			}
			meta.UserData = len(userData) > 0
		}
	} else {
		if img := spec.GetImage(); img.GetFormat() == "iso" && meta.Image != "" {
			cdrom = l.basePath(meta.Image, "iso")
		}
		// A disk only grows (qemu-img while stopped, blockresize while running).
		if err := l.checkDisk(dir, meta); err != nil {
			return err
		}
		if err := l.grow(ctx, id, dir, spec.GetDiskBytes()); err != nil {
			return err
		}
	}
	meta.Addresses = strings.Join(addrs, ",")
	d, err := l.domainFor(spec, dir, cdrom, meta)
	if err != nil {
		return err
	}
	// QEMU (its own user) must reach every file the domain names.
	reach := []string{}
	for _, disk := range d.Devices.Disks {
		reach = append(reach, filepath.Dir(disk.Source.File))
	}
	if meta.Image != "" && meta.Restored == "" { // the overlay's backing base (0644)
		reach = append(reach, filepath.Join(l.Dir, "images"))
	}
	for _, p := range reach {
		if err := l.searchable(p); err != nil {
			return err
		}
	}
	return l.define(ctx, d, dir)
}

func (l *Libvirt) basePath(digestHex, format string) string {
	return filepath.Join(l.Dir, "images", digestHex+"."+format)
}

// baseImage downloads an image once, verified against its sha256 before it becomes visible.
func (l *Libvirt) baseImage(ctx context.Context, img *agentv1.ImageRef) (string, error) {
	if img.GetUrl() == "" || len(img.GetSha256()) != sha256.Size {
		return "", errors.New("the image has no URL or sha256")
	}
	format := img.GetFormat()
	if format != "qcow2" && format != "raw" && format != "iso" {
		return "", fmt.Errorf("image format %q", format)
	}
	dst := l.basePath(hex.EncodeToString(img.GetSha256()), format)
	if _, err := os.Stat(dst); err == nil {
		return dst, checkBase(dst, format)
	}
	if !strings.HasPrefix(img.GetUrl(), "https://") {
		return "", errors.New("images are fetched over https only")
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, img.GetUrl(), nil)
	if err != nil {
		return "", err
	}
	client := l.HTTP
	if client == nil {
		client = &http.Client{}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("image GET returned %s", resp.Status)
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".pull-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(tmp, h), resp.Body)
	tmp.Close()
	if err != nil {
		return "", err
	}
	if !bytes.Equal(h.Sum(nil), img.GetSha256()) {
		return "", fmt.Errorf("image sha256 %x is not the pinned %x", h.Sum(nil), img.GetSha256())
	}
	if err := checkBase(tmp.Name(), format); err != nil {
		return "", err
	}
	// Readable by the unprivileged VMM a runtime binds it into (images/ itself stays root's, 0700).
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return "", err
	}
	return dst, os.Rename(tmp.Name(), dst)
}

// checkRestored checks a restored snapshot's disk: a flat qcow2 naming no other file. Its seed is
// attached as raw, never probed.
func (l *Libvirt) checkRestored(_ context.Context, dir string) error {
	if err := checkOverlay(filepath.Join(dir, "disk.qcow2"), "", ""); err != nil {
		return fmt.Errorf("the snapshot's disk: %w", err)
	}
	return nil
}

// GrowVolume tells a running (or paused) domain one of its volumes grew: blockresize to the file's
// size, which the guest sees as a capacity change. A domain that does not have the volume in its
// live definition (attached since, applied at its next start) has nothing to be told.
func (l *Libvirt) GrowVolume(ctx context.Context, id string, v AttachedVolume) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if st, _ := l.virsh(ctx, "domstate", id); stateOf(string(st)) == StateStopped {
		return nil
	}
	raw, err := l.virsh(ctx, "dumpxml", id)
	if err != nil {
		return err
	}
	var x domainXML
	if err := xml.Unmarshal(raw, &x); err != nil {
		return err
	}
	for _, disk := range x.Devices.Disks {
		if disk.Source.File == v.Path && disk.Target.Dev != "" {
			_, err := l.virsh(ctx, "blockresize", id, disk.Target.Dev, strconv.FormatUint(v.SizeBytes, 10)+"B")
			return err
		}
	}
	return nil
}

// searchable gives "others" search permission (x, never read) on dir and its ancestors up to the
// data directory: libvirt runs QEMU as its own user (libvirt-qemu, qemu), which must reach the
// disks, base image and volumes libvirt hands it (dynamic ownership relabels files, never the
// directories on their way). Listing stays closed, and bcd's own files there are 0600.
func (l *Libvirt) searchable(dir string) error {
	stop := filepath.Dir(filepath.Clean(l.Dir))
	for d := filepath.Clean(dir); ; d = filepath.Dir(d) {
		if !strings.HasPrefix(d+"/", stop+"/") {
			return nil // outside bcd's data directory: not bcd's to change
		}
		info, err := os.Stat(d)
		if err != nil {
			return err
		}
		if perm := info.Mode().Perm(); perm&0o001 == 0 {
			if err := os.Chmod(d, perm|0o001); err != nil {
				return err
			}
		}
		if d == stop {
			return nil
		}
	}
}

// seed writes the NoCloud seed ISO (volume "cidata") with the user data, the instance id and, when
// the NICs have leased addresses, their network-config (netconfig.go).
func (l *Libvirt) seed(ctx context.Context, id string, nics []*agentv1.InstanceNic, userData []byte, dir string) error {
	netcfg, err := networkConfig(nics)
	if err != nil {
		return fmt.Errorf("network-config: %w", err)
	}
	src := filepath.Join(dir, "seed")
	if err := os.MkdirAll(src, 0o700); err != nil {
		return err
	}
	defer os.RemoveAll(src)
	if len(userData) == 0 {
		userData = []byte("#cloud-config\n{}\n")
	}
	if err := os.WriteFile(filepath.Join(src, "user-data"), userData, 0o600); err != nil {
		return err
	}
	meta := fmt.Sprintf("instance-id: %s\nlocal-hostname: %s\n", id, id)
	if err := os.WriteFile(filepath.Join(src, "meta-data"), []byte(meta), 0o600); err != nil {
		return err
	}
	iso := filepath.Join(dir, "seed.iso")
	files := []string{filepath.Join(src, "user-data"), filepath.Join(src, "meta-data")}
	if netcfg != nil {
		if err := os.WriteFile(filepath.Join(src, "network-config"), netcfg, 0o600); err != nil {
			return err
		}
		files = append(files, filepath.Join(src, "network-config"))
	}
	_, err = l.run(ctx, "genisoimage", append([]string{"-quiet", "-output", iso, "-volid", "cidata", "-joliet", "-rock"}, files...)...)
	if err != nil {
		if _, err2 := l.run(ctx, "xorriso", append([]string{"-as", "mkisofs", "-quiet", "-output", iso, "-volid", "cidata", "-joliet", "-rock"}, files...)...); err2 != nil {
			return fmt.Errorf("NoCloud seed: %w", err)
		}
	}
	return nil
}

// checkDisk checks a domain's disk before anything opens it again: bcd's overlay on the domain's base
// image, or a flat disk (restored, or installed from an iso), naming no other file.
func (l *Libvirt) checkDisk(dir string, meta instanceMetaXML) error {
	base, format := "", ""
	if meta.Image != "" && meta.Restored == "" {
		format = meta.Format
		if format == "" { // a domain defined before the format was recorded
			format = "raw"
			if fileExists(l.basePath(meta.Image, "qcow2")) {
				format = "qcow2"
			}
		}
		if format != "iso" {
			base = l.basePath(meta.Image, format)
		} else {
			format = ""
		}
	}
	return checkOverlay(filepath.Join(dir, "disk.qcow2"), base, format)
}

// grow enlarges the disk to size bytes; a smaller size is refused.
func (l *Libvirt) grow(ctx context.Context, id, dir string, size uint64) error {
	disk := filepath.Join(dir, "disk.qcow2")
	h, err := readQcow2(disk)
	if err != nil {
		return err
	}
	current := h.Size
	switch {
	case size < current:
		return errors.New("a disk cannot shrink")
	case size == current:
		return nil
	}
	st, _ := l.virsh(ctx, "domstate", id)
	if stateOf(string(st)) == StateStopped {
		_, err = l.run(ctx, "qemu-img", "resize", "-f", "qcow2", disk, strconv.FormatUint(size, 10))
	} else {
		_, err = l.virsh(ctx, "blockresize", id, "vda", strconv.FormatUint(size, 10)+"B")
	}
	return err
}

// ---- SetState / Destroy -----------------------------------------------------------------------

// SetState starts, stops, pauses or resumes a managed domain. A stop is graceful up to
// ShutdownTimeout, then forced. A domain restored with memory state starts from it.
func (l *Libvirt) SetState(ctx context.Context, id, state string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	exists, managed, meta := l.managed(ctx, id)
	if !exists || !managed {
		return fmt.Errorf("no managed domain %s", id)
	}
	out, err := l.virsh(ctx, "domstate", id)
	if err != nil {
		return err
	}
	current := stateOf(string(out))
	memory := filepath.Join(l.instanceDir(id), "memory.state")
	start := func(paused bool) error {
		if err := l.checkDisk(l.instanceDir(id), meta); err != nil {
			return err
		}
		if _, err := os.Stat(memory); err == nil {
			args := []string{"restore", memory, "--xml", filepath.Join(l.instanceDir(id), "domain.xml")}
			if paused {
				args = append(args, "--paused")
			}
			if _, err := l.virsh(ctx, args...); err != nil {
				return err
			}
			return os.Remove(memory)
		}
		args := []string{"start", id}
		if paused {
			args = append(args, "--paused")
		}
		_, err := l.virsh(ctx, args...)
		if err != nil && strings.Contains(err.Error(), "Cannot allocate memory") {
			return ErrNoCapacity
		}
		return err
	}
	switch state {
	case StateRunning:
		switch current {
		case StatePaused:
			_, err = l.virsh(ctx, "resume", id)
		case StateStopped, StateError:
			err = start(false)
		}
	case StatePaused:
		switch current {
		case StateRunning:
			_, err = l.virsh(ctx, "suspend", id)
		case StateStopped, StateError:
			err = start(true)
		}
	case StateStopped:
		if current != StateStopped {
			err = l.stop(ctx, id)
		}
	default:
		err = fmt.Errorf("state %q", state)
	}
	return err
}

func (l *Libvirt) stop(ctx context.Context, id string) error {
	timeout := l.ShutdownTimeout
	if timeout <= 0 {
		timeout = time.Minute
	}
	if st, _ := l.virsh(ctx, "domstate", id); stateOf(string(st)) == StateRunning {
		_, _ = l.virsh(ctx, "shutdown", id)
		deadline := time.Now().Add(timeout)
		for time.Now().Before(deadline) {
			if st, err := l.virsh(ctx, "domstate", id); err == nil && stateOf(string(st)) == StateStopped {
				return nil
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Second):
			}
		}
	}
	_, err := l.virsh(ctx, "destroy", id)
	return err
}

// Destroy removes a managed domain, its definition and its disks (its taps go with it).
func (l *Libvirt) Destroy(ctx context.Context, id string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	exists, managed, _ := l.managed(ctx, id)
	if exists && !managed {
		return fmt.Errorf("the domain %s is not bcd's", id)
	}
	if exists {
		if st, _ := l.virsh(ctx, "domstate", id); stateOf(string(st)) != StateStopped {
			if _, err := l.virsh(ctx, "destroy", id); err != nil {
				return err
			}
		}
		if _, err := l.virsh(ctx, "undefine", id, "--nvram", "--managed-save"); err != nil {
			return err
		}
	}
	if !instanceID.MatchString(id) {
		return nil
	}
	return os.RemoveAll(l.instanceDir(id))
}

// ---- snapshots --------------------------------------------------------------------------------

// libvirtSnapshot is a snapshot's meta.json.
type libvirtSnapshot struct {
	Runtime       string `json:"runtime"`
	CPUModel      string `json:"cpuModel,omitempty"`
	IncludeMemory bool   `json:"includeMemory"`
}

// Snapshot writes a tar of meta.json, disk.qcow2 (the overlay flattened onto its base), seed.iso
// and, with memory, memory.state (virsh save, then the domain carries on from it). A disk-only
// snapshot of a running domain pauses it for the copy.
func (l *Libvirt) Snapshot(ctx context.Context, id string, includeMemory bool, cpuModel string, w io.Writer) (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	exists, managed, dom := l.managed(ctx, id)
	if !exists || !managed {
		return "", fmt.Errorf("no managed domain %s", id)
	}
	if includeMemory {
		// A VFIO device's state is the GPU's own: qemu cannot save it.
		if raw, err := l.virsh(ctx, "dumpxml", id); err == nil {
			var x domainXML
			if xml.Unmarshal(raw, &x) == nil && len(x.Devices.Hostdevs) > 0 {
				return "", ErrMemorySnapshotWithGPUs
			}
			for _, disk := range x.Devices.Disks {
				// A writable disk beside the root (vda) and the rebind disk (vdz): a volume.
				if disk.Device == "disk" && disk.ReadOnly == nil && disk.Target.Dev != "vda" && disk.Target.Dev != "vdz" {
					return "", ErrMemorySnapshotWithVolumes
				}
			}
		}
	}
	dir := l.instanceDir(id)
	if err := l.checkDisk(dir, dom); err != nil {
		return "", err
	}
	work, err := os.MkdirTemp(dir, ".snapshot-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	st, err := l.virsh(ctx, "domstate", id)
	if err != nil {
		return "", err
	}
	state := stateOf(string(st))
	memory := filepath.Join(work, "memory.state")
	switch {
	case includeMemory && state != StateStopped:
		if _, err := l.virsh(ctx, "save", id, memory); err != nil {
			return "", err
		}
		// Carry on from the saved state (it keeps pointing at this domain's own disk).
		defer func() {
			args := []string{"restore", memory}
			if state == StatePaused {
				args = append(args, "--paused")
			}
			_, _ = l.virsh(context.WithoutCancel(ctx), args...)
		}()
	case state == StateRunning:
		if _, err := l.virsh(ctx, "suspend", id); err != nil {
			return "", err
		}
		defer func() { _, _ = l.virsh(context.WithoutCancel(ctx), "resume", id) }()
	}
	flat := filepath.Join(work, "disk.qcow2")
	if _, err := l.run(ctx, "qemu-img", "convert", "-U", "-f", "qcow2", "-O", "qcow2", filepath.Join(dir, "disk.qcow2"), flat); err != nil {
		return "", err
	}
	meta := libvirtSnapshot{Runtime: l.Name(), IncludeMemory: includeMemory && state != StateStopped}
	if meta.IncludeMemory {
		meta.CPUModel = cpuModel
	}
	tw := tar.NewWriter(w)
	raw, _ := json.Marshal(meta)
	if err := tarBytes(tw, "meta.json", raw); err != nil {
		return "", err
	}
	files := []string{flat, filepath.Join(dir, "seed.iso")}
	if meta.IncludeMemory {
		files = append(files, memory)
	}
	for _, f := range files {
		if err := tarFile(tw, f); err != nil {
			return "", err
		}
	}
	return meta.CPUModel, tw.Close()
}

func tarBytes(tw *tar.Writer, name string, data []byte) error {
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(data))}); err != nil {
		return err
	}
	_, err := tw.Write(data)
	return err
}

func tarFile(tw *tar.Writer, file string) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: filepath.Base(file), Mode: 0o600, Size: info.Size()}); err != nil {
		return err
	}
	_, err = io.Copy(tw, f)
	return err
}

// unpack restores a snapshot's files into a new instance's directory, refusing one from another
// runtime or, with memory, from another CPU model.
func (l *Libvirt) unpack(restore *Restore, dir string) error {
	f, err := os.Open(restore.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	allowed := map[string]bool{"meta.json": true, "disk.qcow2": true, "seed.iso": true, "memory.state": true}
	var meta *libvirtSnapshot
	tr := tar.NewReader(f)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("not a %s snapshot: %w", l.Name(), err)
		}
		if !allowed[h.Name] || h.Typeflag != tar.TypeReg {
			return fmt.Errorf("unexpected %q in the snapshot", h.Name)
		}
		if h.Name == "meta.json" {
			var m libvirtSnapshot
			if err := json.NewDecoder(io.LimitReader(tr, 1<<16)).Decode(&m); err != nil {
				return fmt.Errorf("not a %s snapshot", l.Name())
			}
			if m.Runtime != l.Name() {
				return fmt.Errorf("the snapshot was taken by %s, not %s", m.Runtime, l.Name())
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
		out, err := os.OpenFile(filepath.Join(dir, h.Name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
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
		return fmt.Errorf("not a %s snapshot", l.Name())
	}
	if _, err := os.Stat(filepath.Join(dir, "disk.qcow2")); err != nil {
		return errors.New("the snapshot has no disk")
	}
	return nil
}

// Console opens a running managed domain's serial console: the pty libvirt gave its serial port
// (the live domain XML names it), which bcd opens as root.
func (l *Libvirt) Console(ctx context.Context, id string) (io.ReadWriteCloser, error) {
	raw, err := l.virsh(ctx, "dumpxml", id)
	if err != nil {
		return nil, err
	}
	var x domainXML
	if err := xml.Unmarshal(raw, &x); err != nil || x.Metadata == nil || x.Metadata.Instance.ID != id {
		return nil, fmt.Errorf("no managed domain %s", id)
	}
	if x.Devices.Serial == nil || x.Devices.Serial.Source == nil || !strings.HasPrefix(x.Devices.Serial.Source.Path, "/dev/pts/") {
		return nil, fmt.Errorf("domain %s has no serial console (is it running?)", id)
	}
	return os.OpenFile(x.Devices.Serial.Source.Path, os.O_RDWR|syscallNoCTTY, 0)
}

// Rebind hot-adds the identity disk (rebind.go) to a running domain as vdz and waits for its guest's
// acknowledgement; the disk is detached and its file scrubbed whatever happens.
func (l *Libvirt) Rebind(ctx context.Context, id string, b Rebind) error {
	l.mu.Lock()
	if exists, managed, _ := l.managed(ctx, id); !exists || !managed {
		l.mu.Unlock()
		return fmt.Errorf("no managed domain %s", id)
	}
	if st, _ := l.virsh(ctx, "domstate", id); stateOf(string(st)) != StateRunning {
		l.mu.Unlock()
		return fmt.Errorf("domain %s is not running", id)
	}
	img, nonce, err := rebindImage(b)
	if err != nil {
		l.mu.Unlock()
		return err
	}
	path := filepath.Join(l.instanceDir(id), "rebind.img")
	scrub(path)
	if err = os.WriteFile(path, img, 0o600); err == nil {
		_, err = l.virsh(ctx, "attach-disk", id, path, "vdz", "--targetbus", "virtio", "--subdriver", "raw", "--serial", RebindSerial, "--live")
	}
	l.mu.Unlock()
	if err != nil {
		scrub(path)
		return err
	}
	timeout := l.RebindTimeout
	if timeout <= 0 {
		timeout = RebindTimeout
	}
	waitErr := waitAck(ctx, path, nonce, timeout, 200*time.Millisecond)
	l.mu.Lock()
	_, _ = l.virsh(context.WithoutCancel(ctx), "detach-disk", id, "vdz", "--live")
	l.mu.Unlock()
	scrub(path)
	return waitErr
}
