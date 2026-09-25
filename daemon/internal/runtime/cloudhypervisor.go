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
	"net"
	"net/http"
	"os"
	"path/filepath"
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
//   - NICs are taps named TapName (bcd's network rules exist before them), attached to their
//     network's bridge once the VM runs; GPUs pass through with VFIO;
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
	// API calls a VMM's REST API on its socket (tests replace it).
	API func(ctx context.Context, socket, method, path string, body any) ([]byte, int, error)
	// GPUAddress maps a GPU device id to its PCI address ("0000:3b:00.0") for VFIO.
	GPUAddress func(id string) (string, bool)
	// HTTP downloads base images (https only).
	HTTP *http.Client
	// ShutdownTimeout bounds a graceful (ACPI) shutdown before the VM is stopped (default 60 s).
	ShutdownTimeout time.Duration
	// Poll is how often a starting VMM or a shutting-down VM is checked (default 200 ms).
	Poll time.Duration

	mu sync.Mutex
}

// chRecord is instances/<id>/vm.json: bcd's metadata and the VM's configuration.
type chRecord struct {
	ID           string          `json:"id"`
	Managed      string          `json:"managed"` // chManaged: this directory is bcd's
	AllocationID string          `json:"allocationId,omitempty"`
	Image        string          `json:"image,omitempty"`
	RestoredFrom string          `json:"restoredFrom,omitempty"`
	Addresses    []string        `json:"addresses,omitempty"`
	Networks     []string        `json:"networks,omitempty"`
	GPUs         []string        `json:"gpus,omitempty"`
	Config       json.RawMessage `json:"config"`
	VCPU         uint32          `json:"vcpu"`
	MemoryBytes  uint64          `json:"memoryBytes"`
	DiskBytes    uint64          `json:"diskBytes"`
	MACs         []string        `json:"macs,omitempty"`
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
func unitName(id string) string { return "bcd-ch-" + id }

// api calls the VMM of instance id; a status above 299 is an error.
func (c *CloudHypervisor) api(ctx context.Context, id, method, path string, body any) ([]byte, error) {
	call := c.API
	if call == nil {
		call = unixAPI
	}
	out, status, err := call(ctx, c.socket(id), method, "/api/v1/"+path, body)
	if err != nil {
		return nil, err
	}
	if status > 299 {
		return out, fmt.Errorf("cloud-hypervisor %s: HTTP %d: %s", path, status, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// unixAPI calls a VMM's API over its unix socket.
func unixAPI(ctx context.Context, socket, method, path string, body any) ([]byte, int, error) {
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}}
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://localhost"+path, r)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	return out, resp.StatusCode, err
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
		d.State, d.Message = c.state(ctx, r.ID)
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

// vmConfig is the VM's cloud-hypervisor configuration (VmConfig).
func (c *CloudHypervisor) vmConfig(spec *agentv1.InstanceSpec, dir string) (map[string]any, error) {
	disks := []any{
		map[string]any{"id": "disk0", "path": filepath.Join(dir, "disk.qcow2")},
		map[string]any{"id": "seed", "path": filepath.Join(dir, "seed.iso"), "readonly": true},
	}
	var nets []any
	for i, nic := range spec.GetNics() {
		nets = append(nets, map[string]any{"id": fmt.Sprintf("net%d", i), "tap": TapName(spec.GetInstanceId(), i), "mac": nic.GetMac()})
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
	cfg := map[string]any{
		"cpus":    map[string]any{"boot_vcpus": spec.GetVcpu(), "max_vcpus": spec.GetVcpu()},
		"memory":  map[string]any{"size": spec.GetMemoryBytes()},
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
	dir := c.instanceDir(id)
	r, err := c.record(id)
	if err != nil {
		if _, statErr := os.Stat(dir); statErr == nil {
			return fmt.Errorf("instances/%s exists and is not bcd's", id)
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		r = &chRecord{ID: id, Managed: chManaged, AllocationID: spec.GetAllocationId()}
		st := c.storage()
		switch {
		case restore != nil:
			if err := c.unpack(restore, dir, spec); err != nil {
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
			r.Image = hex.EncodeToString(img.GetSha256())
			if _, err := c.run(ctx, "qemu-img", "create", "-f", "qcow2", "-F", img.GetFormat(), "-b", base,
				filepath.Join(dir, "disk.qcow2"), strconv.FormatUint(spec.GetDiskBytes(), 10)); err != nil {
				os.RemoveAll(dir)
				return err
			}
			if err := st.seed(ctx, id, userData, dir); err != nil {
				os.RemoveAll(dir)
				return err
			}
		}
	} else if spec.GetDiskBytes() > r.DiskBytes && r.DiskBytes > 0 {
		if state, _ := c.state(ctx, id); state == StateStopped {
			if _, err := c.run(ctx, "qemu-img", "resize", filepath.Join(dir, "disk.qcow2"), strconv.FormatUint(spec.GetDiskBytes(), 10)); err != nil {
				return err
			}
		} else if _, err := c.api(ctx, id, http.MethodPut, "vm.resize-disk", map[string]any{"disk": "disk0", "desired_size": spec.GetDiskBytes()}); err != nil {
			return err
		}
	} else if spec.GetDiskBytes() < r.DiskBytes {
		return errors.New("a disk cannot shrink")
	}
	cfg, err := c.vmConfig(spec, dir)
	if err != nil {
		return err
	}
	r.Config, _ = json.Marshal(cfg)
	r.VCPU, r.MemoryBytes, r.DiskBytes = spec.GetVcpu(), spec.GetMemoryBytes(), spec.GetDiskBytes()
	r.GPUs = append([]string(nil), spec.GetGpuDeviceIds()...)
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

// launch starts the instance's VMM as a transient unit and waits for its API.
func (c *CloudHypervisor) launch(ctx context.Context, id string) error {
	if _, err := c.api(ctx, id, http.MethodGet, "vmm.ping", nil); err == nil {
		return nil
	}
	_ = os.Remove(c.socket(id))
	binary := c.Binary
	if binary == "" {
		binary = "cloud-hypervisor"
	}
	if _, err := c.run(ctx, "systemd-run", "--unit="+unitName(id), "--collect", "--quiet", "--",
		binary, "--api-socket", "path="+c.socket(id)); err != nil {
		return err
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := c.api(ctx, id, http.MethodGet, "vmm.ping", nil); err == nil {
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

// start boots the VM (or restores its memory snapshot), then attaches its taps to their bridges.
func (c *CloudHypervisor) start(ctx context.Context, r *chRecord, paused bool) error {
	if err := c.launch(ctx, r.ID); err != nil {
		return err
	}
	snapshot := filepath.Join(c.instanceDir(r.ID), "snapshot")
	if _, err := os.Stat(filepath.Join(snapshot, "state.json")); err == nil {
		if _, err := c.api(ctx, r.ID, http.MethodPut, "vm.restore", map[string]any{"source_url": "file://" + snapshot}); err != nil {
			return err
		}
		_ = os.RemoveAll(snapshot)
		if !paused {
			if _, err := c.api(ctx, r.ID, http.MethodPut, "vm.resume", nil); err != nil {
				return err
			}
		}
	} else {
		if _, err := c.api(ctx, r.ID, http.MethodGet, "vm.info", nil); err != nil {
			if _, err := c.api(ctx, r.ID, http.MethodPut, "vm.create", json.RawMessage(r.Config)); err != nil {
				return err
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
	}
	for i, network := range r.Networks {
		if network == "" {
			continue
		}
		tap := TapName(r.ID, i)
		if _, err := c.run(ctx, "ip", "link", "set", tap, "master", network); err != nil {
			return err
		}
		if _, err := c.run(ctx, "ip", "link", "set", tap, "up"); err != nil {
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
		if current != StateStopped {
			err = c.stop(ctx, id)
		}
	default:
		err = fmt.Errorf("state %q", state)
	}
	return err
}

func (c *CloudHypervisor) stop(ctx context.Context, id string) error {
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
	_, _ = c.api(ctx, id, http.MethodPut, "vm.shutdown", nil)
	_, _ = c.api(ctx, id, http.MethodPut, "vmm.shutdown", nil)
	_, _ = c.run(ctx, "systemctl", "stop", unitName(id))
	return nil
}

// Destroy stops a managed instance and removes its directory (its taps go with the VMM).
func (c *CloudHypervisor) Destroy(ctx context.Context, id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !instanceID.MatchString(id) {
		return nil
	}
	if _, err := c.record(id); err != nil {
		if _, statErr := os.Stat(c.instanceDir(id)); statErr == nil {
			return fmt.Errorf("instances/%s is not bcd's", id)
		}
		return nil
	}
	if err := c.stop(ctx, id); err != nil {
		return err
	}
	return os.RemoveAll(c.instanceDir(id))
}

// ---- snapshots ----------------------------------------------------------------------------------

// chSnapshotFiles are cloud-hypervisor's own snapshot files, under ch/ in bcd's tar.
var chSnapshotFiles = map[string]bool{"config.json": true, "state.json": true, "memory-ranges": true}

// Snapshot writes a tar of meta.json, disk.qcow2 (flattened), seed.iso and, with memory, ch/ (the
// VMM's snapshot of the paused VM, which then carries on).
func (c *CloudHypervisor) Snapshot(ctx context.Context, id string, includeMemory bool, cpuModel string, w io.Writer) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := c.record(id); err != nil {
		return "", fmt.Errorf("no managed domain %s", id)
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
		if _, err := c.api(ctx, id, http.MethodPut, "vm.snapshot", map[string]any{"destination_url": "file://" + chDir}); err != nil {
			return "", err
		}
	}
	flat := filepath.Join(work, "disk.qcow2")
	if _, err := c.run(ctx, "qemu-img", "convert", "-U", "-O", "qcow2", filepath.Join(dir, "disk.qcow2"), flat); err != nil {
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
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return errors.New("the memory snapshot's config.json is not JSON")
	}
	fresh, err := c.vmConfig(spec, dir)
	if err != nil {
		return err
	}
	for _, k := range []string{"disks", "net", "serial", "console", "devices"} {
		if v, ok := fresh[k]; ok {
			cfg[k] = v
		} else {
			delete(cfg, k)
		}
	}
	patched, _ := json.Marshal(cfg)
	return os.WriteFile(cfgPath, patched, 0o600)
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
