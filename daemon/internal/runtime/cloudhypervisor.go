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
	Base         string          `json:"base,omitempty"` // the base image the overlay reads
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
// unitName always carries its ".service" suffix: an instance id ending in ".slice" or ".mount"
// never names another kind of unit (security review 12 L7).
func unitName(id string) string { return "bcd-ch-" + id + ".service" }

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

// vmConfig is the VM's cloud-hypervisor configuration (VmConfig). overlay: disk0 is bcd's qcow2
// overlay on a base image (a restored disk is flat and may name no backing file).
func (c *CloudHypervisor) vmConfig(spec *agentv1.InstanceSpec, dir string, overlay bool) (map[string]any, error) {
	// Formats are explicit, never probed; disk0's backing file is the checked base bcd named when it
	// created the overlay (checkImage refused any other).
	disks := []any{
		map[string]any{"id": "disk0", "path": filepath.Join(dir, "disk.qcow2"), "image_type": "Qcow2", "backing_files": overlay},
		map[string]any{"id": "seed", "path": filepath.Join(dir, "seed.iso"), "readonly": true, "image_type": "Raw"},
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
			r.Image, r.Base = hex.EncodeToString(img.GetSha256()), base
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

// unitProperties confine a VMM (security review 12 H2, M3). It runs as root, since it opens taps and
// VFIO groups, but:
//   - its only capabilities are CAP_NET_ADMIN and CAP_IPC_LOCK (pinned guest memory);
//   - the only devices it can open are KVM, the tun clone device and, with GPUs, VFIO;
//   - of bcd's directory it sees only its own instance (read-write) and its base image (read-only),
//     so a disk naming another file finds nothing to open;
//   - its memory, tasks and CPU are bounded by its flavor, plus overhead.
func (c *CloudHypervisor) unitProperties(r *chRecord) []string {
	dir := c.instanceDir(r.ID)
	props := []string{
		"DevicePolicy=closed", "DeviceAllow=/dev/kvm rw", "DeviceAllow=/dev/net/tun rw",
		"CapabilityBoundingSet=CAP_NET_ADMIN CAP_IPC_LOCK", "NoNewPrivileges=yes",
		"ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "ProtectKernelTunables=yes",
		"ProtectKernelModules=yes", "ProtectKernelLogs=yes", "ProtectControlGroups=yes", "ProtectClock=yes",
		"ProtectHostname=yes", "RestrictSUIDSGID=yes", "RestrictRealtime=yes", "RestrictNamespaces=yes",
		"LockPersonality=yes", "IPAddressDeny=any", "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
		"TemporaryFileSystem=" + filepath.Join(c.Dir, "instances") + ":ro",
		"TemporaryFileSystem=" + filepath.Join(c.Dir, "images") + ":ro",
		"BindPaths=" + dir, "ReadWritePaths=" + dir,
		"LimitMEMLOCK=infinity",
		fmt.Sprintf("MemoryMax=%d", r.MemoryBytes+r.MemoryBytes/32+256<<20),
		fmt.Sprintf("TasksMax=%d", 4*r.VCPU+128),
		fmt.Sprintf("CPUQuota=%d%%", 100*(r.VCPU+1)),
	}
	if r.Base != "" {
		props = append(props, "BindReadOnlyPaths="+r.Base)
	}
	if len(r.GPUs) > 0 {
		props = append(props, "DeviceAllow=/dev/vfio/vfio rw", "DeviceAllow=char-vfio rw")
	}
	return props
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
// persistent, on their network's bridge and up, so neither a guest reboot (the VMM reopens them)
// nor a failed step leaves a tap of a running VM off its bridge, where bcd's bridge rules do not
// see it. A NIC without a network is refused.
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

// start creates the taps, then boots the VM (or restores its memory snapshot).
func (c *CloudHypervisor) start(ctx context.Context, r *chRecord, paused bool) error {
	if err := c.taps(ctx, r); err != nil {
		return err
	}
	if err := c.launch(ctx, r); err != nil {
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
		return nil
	}
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
	cfg := map[string]any{
		"cpus":   keep(cpus, "boot_vcpus", "max_vcpus", "topology", "kvm_hyperv", "max_phys_bits", "features"),
		"memory": keep(memory, "size", "mergeable", "shared", "hugepages", "hugepage_size", "prefault", "thp"),
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
