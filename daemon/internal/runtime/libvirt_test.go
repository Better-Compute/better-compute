package runtime

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/xml"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// fakeVirt stands in for virsh and qemu-img: domains with their XML and state, disks as JSON files.
type fakeVirt struct {
	mu      sync.Mutex
	domains map[string]*fakeDomain
	calls   []string
}

type fakeDomain struct {
	xml   []byte
	state string // "running", "paused", "shut off"
}

func (f *fakeVirt) exec(_ context.Context, name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch name {
	case "virsh":
		args = args[2:] // -c <uri>
		f.calls = append(f.calls, "virsh "+strings.Join(args, " "))
		return f.virsh(args)
	case "qemu-img":
		f.calls = append(f.calls, "qemu-img "+args[0])
		return f.qemuImg(args)
	case "genisoimage":
		var out string
		var data []byte
		for i := 0; i < len(args); i++ {
			switch {
			case args[i] == "-output":
				out = args[i+1]
				i++
			case args[i] == "-volid":
				i++
			case strings.HasPrefix(args[i], "/") || filepath.IsAbs(args[i]):
				b, _ := os.ReadFile(args[i])
				data = append(data, b...)
			}
		}
		return nil, os.WriteFile(out, data, 0o600)
	}
	return nil, fmt.Errorf("%s: not found", name)
}

func (f *fakeVirt) virsh(args []string) ([]byte, error) {
	d := func(name string) (*fakeDomain, error) {
		if dom, ok := f.domains[name]; ok {
			return dom, nil
		}
		return nil, fmt.Errorf("error: failed to get domain '%s'", name)
	}
	switch args[0] {
	case "list":
		var names []string
		for n := range f.domains {
			names = append(names, n)
		}
		sort.Strings(names)
		return []byte(strings.Join(names, "\n") + "\n"), nil
	case "domstate":
		dom, err := d(args[1])
		if err != nil {
			return nil, err
		}
		return []byte(dom.state + "\n"), nil
	case "dumpxml":
		dom, err := d(args[1])
		if err != nil {
			return nil, err
		}
		return dom.xml, nil
	case "define":
		raw, _ := os.ReadFile(args[1])
		var x struct {
			Name string `xml:"name"`
		}
		_ = xml.Unmarshal(raw, &x)
		if dom, ok := f.domains[x.Name]; ok {
			dom.xml = raw
		} else {
			f.domains[x.Name] = &fakeDomain{xml: raw, state: "shut off"}
		}
		return nil, nil
	case "start", "resume", "suspend", "shutdown", "destroy":
		dom, err := d(args[1])
		if err != nil {
			return nil, err
		}
		dom.state = map[string]string{"start": "running", "resume": "running", "suspend": "paused", "shutdown": "shut off", "destroy": "shut off"}[args[0]]
		if args[0] == "start" && len(args) > 2 && args[2] == "--paused" {
			dom.state = "paused"
		}
		return nil, nil
	case "undefine":
		delete(f.domains, args[1])
		return nil, nil
	case "save":
		dom, err := d(args[1])
		if err != nil {
			return nil, err
		}
		dom.state = "shut off"
		return nil, os.WriteFile(args[2], []byte("memory of "+args[1]), 0o600)
	case "restore":
		raw, err := os.ReadFile(args[1])
		if err != nil {
			return nil, err
		}
		name := strings.TrimPrefix(string(raw), "memory of ")
		state := "running"
		for i := 2; i < len(args); i++ {
			if args[i] == "--xml" {
				x, _ := os.ReadFile(args[i+1])
				var n struct {
					Name string `xml:"name"`
				}
				_ = xml.Unmarshal(x, &n)
				name = n.Name
				i++
			}
			if args[i] == "--paused" {
				state = "paused"
			}
		}
		dom, err := d(name)
		if err != nil {
			return nil, err
		}
		dom.state = state
		return nil, nil
	case "blockresize":
		return nil, nil
	}
	return nil, fmt.Errorf("virsh %s: unknown", args[0])
}

func (f *fakeVirt) qemuImg(args []string) ([]byte, error) {
	switch args[0] {
	case "create":
		file, size := args[len(args)-2], args[len(args)-1]
		return nil, os.WriteFile(file, []byte(`{"virtual-size": `+size+`}`), 0o600)
	case "info":
		raw, err := os.ReadFile(args[len(args)-1])
		if err != nil || bytes.HasPrefix(raw, []byte("{")) {
			return raw, err // a disk qemu-img created
		}
		// A base image: "QFI\xfb" probes as qcow2; "backing=<file>" in it names a backing file.
		format := "raw"
		if bytes.HasPrefix(raw, []byte("QFI\xfb")) || bytes.HasPrefix(raw, []byte("flat ")) {
			format = "qcow2"
		}
		for i, a := range args {
			if a == "-f" {
				if args[i+1] == "qcow2" && format != "qcow2" {
					return nil, errors.New("qemu-img: Image is not in qcow2 format")
				}
				format = args[i+1]
			}
		}
		info := map[string]any{"format": format}
		if _, backing, ok := bytes.Cut(raw, []byte("backing=")); ok {
			info["backing-filename"] = string(backing)
		}
		return json.Marshal(info)
	case "resize":
		return nil, os.WriteFile(args[len(args)-2], []byte(`{"virtual-size": `+args[len(args)-1]+`}`), 0o600)
	case "convert":
		raw, err := os.ReadFile(args[len(args)-2])
		if err != nil {
			return nil, err
		}
		return nil, os.WriteFile(args[len(args)-1], append([]byte("flat "), raw...), 0o600)
	}
	return nil, errors.New("qemu-img: unknown")
}

func tarNames(t *testing.T, raw []byte) map[string]string {
	t.Helper()
	out := map[string]string{}
	tr := tar.NewReader(bytes.NewReader(raw))
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(tr)
		out[h.Name] = string(b)
	}
}

func TestLibvirtRuntime(t *testing.T) {
	image := []byte("QFI\xfbubuntu base image")
	sum := sha256.Sum256(image)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(image) }))
	defer srv.Close()
	virt := &fakeVirt{domains: map[string]*fakeDomain{"someone-elses": {xml: []byte("<domain><name>someone-elses</name></domain>"), state: "running"}}}
	dir := t.TempDir()
	l := &Libvirt{Dir: dir, Exec: virt.exec, HTTP: srv.Client(), GPUAddress: func(id string) (string, bool) {
		return map[string]string{"GPU-1": "0000:3b:00.0"}[id], id == "GPU-1"
	}}
	ctx := context.Background()
	spec := &agentv1.InstanceSpec{
		InstanceId: "inst_web", Runtime: "libvirt-kvm", AllocationId: "alloc_1", Vcpu: 4, MemoryBytes: 8 << 30, DiskBytes: 40 << 30,
		Image:        &agentv1.ImageRef{Ref: "ubuntu", Url: srv.URL + "/ubuntu.qcow2", Sha256: sum[:], Format: "qcow2"},
		GpuDeviceIds: []string{"GPU-1"},
		Nics:         []*agentv1.InstanceNic{{Network: "br0", Mac: "52:54:00:00:00:07", Addresses: []string{"10.0.0.7/24"}}},
	}

	// A new domain: overlay on the verified base, seed with the user data, NIC on its named tap.
	if err := l.Ensure(ctx, spec, []byte("#cloud-config\nhostname: web\n"), nil); err != nil {
		t.Fatal(err)
	}
	raw := string(virt.domains["inst_web"].xml)
	for _, want := range []string{
		`<source bridge="br0">`, `<target dev="` + TapName("inst_web", 0) + `">`, `<mac address="52:54:00:00:00:07">`,
		`bus="0x3b"`, `https://better-compute.dev/libvirt/1`, `<allocation>alloc_1</allocation>`, `<addresses>10.0.0.7/24</addresses>`,
		`mode="host-passthrough"`, filepath.Join(dir, "instances", "inst_web", "disk.qcow2"),
	} {
		if !strings.Contains(raw, want) {
			t.Errorf("domain XML lacks %s:\n%s", want, raw)
		}
	}
	if seed, _ := os.ReadFile(filepath.Join(dir, "instances", "inst_web", "seed.iso")); !bytes.Contains(seed, []byte("hostname: web")) || !bytes.Contains(seed, []byte("instance-id: inst_web")) {
		t.Fatalf("seed = %q", seed)
	}
	if _, err := os.Stat(filepath.Join(dir, "images", fmt.Sprintf("%x.qcow2", sum))); err != nil {
		t.Fatalf("base image: %v", err)
	}

	// Listed with its metadata; the foreign domain is listed, not managed.
	domains, err := l.List(ctx)
	if err != nil || len(domains) != 2 {
		t.Fatalf("list = %+v, %v", domains, err)
	}
	for _, d := range domains {
		switch d.ID {
		case "inst_web":
			if !d.Managed || d.State != StateStopped || d.AllocationID != "alloc_1" || d.VCPU != 4 || d.MemoryBytes != 8<<30 || d.Addresses[0] != "10.0.0.7/24" {
				t.Fatalf("web = %+v", d)
			}
		case "someone-elses":
			if d.Managed || d.State != StateRunning {
				t.Fatalf("foreign = %+v", d)
			}
		}
	}
	if l.Ensure(ctx, &agentv1.InstanceSpec{InstanceId: "someone-elses"}, nil, nil) == nil || l.Destroy(ctx, "someone-elses") == nil {
		t.Fatal("a foreign domain was touched")
	}

	// States.
	for _, step := range []struct{ want, virsh string }{
		{StateRunning, "running"}, {StatePaused, "paused"}, {StateRunning, "running"}, {StateStopped, "shut off"},
	} {
		if err := l.SetState(ctx, "inst_web", step.want); err != nil || virt.domains["inst_web"].state != step.virsh {
			t.Fatalf("SetState %s = %v (%s)", step.want, err, virt.domains["inst_web"].state)
		}
	}

	// A disk grows, never shrinks.
	spec.DiskBytes = 80 << 30
	if err := l.Ensure(ctx, spec, nil, nil); err != nil {
		t.Fatal(err)
	}
	spec.DiskBytes = 10 << 30
	if err := l.Ensure(ctx, spec, nil, nil); err == nil || !strings.Contains(err.Error(), "shrink") {
		t.Fatalf("shrink = %v", err)
	}
	spec.DiskBytes = 80 << 30

	// A memory snapshot of a running domain: saved, flattened, packed; the domain carries on.
	_ = l.SetState(ctx, "inst_web", StateRunning)
	var snap bytes.Buffer
	cpu, err := l.Snapshot(ctx, "inst_web", true, "AMD EPYC 9654", &snap)
	if err != nil || cpu != "AMD EPYC 9654" {
		t.Fatalf("snapshot = %q, %v", cpu, err)
	}
	files := tarNames(t, snap.Bytes())
	if !strings.Contains(files["meta.json"], `"includeMemory":true`) || !strings.HasPrefix(files["disk.qcow2"], "flat ") || files["memory.state"] != "memory of inst_web" || files["seed.iso"] == "" {
		t.Fatalf("snapshot files = %v", files)
	}
	if virt.domains["inst_web"].state != "running" {
		t.Fatalf("after the snapshot the domain is %s", virt.domains["inst_web"].state)
	}

	// A clone from it: its files, and its first start restores the memory state.
	snapFile := filepath.Join(t.TempDir(), "snap.tar")
	_ = os.WriteFile(snapFile, snap.Bytes(), 0o600)
	clone := &agentv1.InstanceSpec{InstanceId: "inst_clone", Runtime: "libvirt-kvm", Vcpu: 4, MemoryBytes: 8 << 30, DiskBytes: 80 << 30,
		Nics: []*agentv1.InstanceNic{{Network: "br0", Mac: "52:54:00:00:00:08", Addresses: []string{"10.0.0.8/24"}}}}
	if err := l.Ensure(ctx, clone, nil, &Restore{Path: snapFile, Sha256: "abcd", CPUModel: "Intel Xeon"}); err == nil || !strings.Contains(err.Error(), "needs CPU") {
		t.Fatalf("a memory snapshot restored on another CPU: %v", err)
	}
	_ = os.RemoveAll(filepath.Join(dir, "instances", "inst_clone"))
	if err := l.Ensure(ctx, clone, nil, &Restore{Path: snapFile, Sha256: "abcd", CPUModel: "AMD EPYC 9654"}); err != nil {
		t.Fatal(err)
	}
	if err := l.SetState(ctx, "inst_clone", StateRunning); err != nil || virt.domains["inst_clone"].state != "running" {
		t.Fatalf("clone start = %v", err)
	}
	restored := false
	for _, c := range virt.calls {
		restored = restored || (strings.HasPrefix(c, "virsh restore ") && strings.Contains(c, "inst_clone") && strings.Contains(c, "--xml"))
	}
	if !restored {
		t.Fatalf("the clone did not start from its memory state: %v", virt.calls)
	}
	if _, err := os.Stat(filepath.Join(dir, "instances", "inst_clone", "memory.state")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the memory state stayed after the restore")
	}
	if d, _ := l.List(ctx); !strings.Contains(fmt.Sprint(d), "abcd") {
		t.Fatalf("the clone does not say what it was restored from: %+v", d)
	}

	// The serial console is the pty the live domain names; a definition without one (or a foreign
	// domain) has none.
	if _, err := l.Console(ctx, "inst_clone"); err == nil || !strings.Contains(err.Error(), "serial console") {
		t.Fatalf("console without a pty = %v", err)
	}
	if _, err := l.Console(ctx, "someone-elses"); err == nil {
		t.Fatal("a foreign domain's console was opened")
	}

	// Destroyed: definition and files gone.
	if err := l.Destroy(ctx, "inst_web"); err != nil {
		t.Fatal(err)
	}
	if _, ok := virt.domains["inst_web"]; ok {
		t.Fatal("the domain is still defined")
	}
	if _, err := os.Stat(filepath.Join(dir, "instances", "inst_web")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the instance's files stayed")
	}

	// An image whose bytes are not its pin never becomes a base.
	bad := sha256.Sum256([]byte("other"))
	other := &agentv1.InstanceSpec{InstanceId: "inst_bad", Vcpu: 1, MemoryBytes: 1 << 30, DiskBytes: 1 << 30,
		Image: &agentv1.ImageRef{Url: srv.URL + "/x.qcow2", Sha256: bad[:], Format: "qcow2"}}
	if err := l.Ensure(ctx, other, nil, nil); err == nil || !strings.Contains(err.Error(), "not the pinned") {
		t.Fatalf("a mismatched image = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "images", fmt.Sprintf("%x.qcow2", bad))); err == nil {
		t.Fatal("a mismatched image was kept")
	}
}

// Security review 12 H2: a tenant's image never makes the hypervisor open another file.
func TestBaseImageChecks(t *testing.T) {
	images := map[string][]byte{
		"backing.qcow2": []byte("QFI\xfbbacking=/dev/nvme0n1"),
		"probed.raw":    []byte("QFI\xfba qcow2 posing as raw"),
		"probed.iso":    []byte("QFI\xfban iso that is a qcow2"),
		"notqcow.qcow2": []byte("plain bytes"),
		"good.raw":      []byte("a raw disk"),
		"good.qcow2":    []byte("QFI\xfba qcow2 disk"),
	}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(images[r.URL.Path[1:]]) }))
	defer srv.Close()
	dir := t.TempDir()
	l := &Libvirt{Dir: dir, Exec: (&fakeVirt{domains: map[string]*fakeDomain{}}).exec, HTTP: srv.Client()}
	for name, want := range map[string]string{
		"backing.qcow2": "backing file", "probed.raw": "content is qcow2", "probed.iso": "content is qcow2",
		"notqcow.qcow2": "not qcow2", "good.raw": "", "good.qcow2": "",
	} {
		sum := sha256.Sum256(images[name])
		base, err := l.baseImage(context.Background(), &agentv1.ImageRef{Url: srv.URL + "/" + name, Sha256: sum[:], Format: strings.Split(name, ".")[1]})
		if want == "" {
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%s = %v, want %q", name, err, want)
		}
		if _, err := os.Stat(base); base != "" && err == nil {
			t.Fatalf("%s was kept", name)
		}
	}
	// An image cached before this check is checked again when used.
	sum := sha256.Sum256(images["backing.qcow2"])
	cached := l.basePath(fmt.Sprintf("%x", sum), "qcow2")
	_ = os.WriteFile(cached, images["backing.qcow2"], 0o600)
	if _, err := l.baseImage(context.Background(), &agentv1.ImageRef{Url: srv.URL + "/backing.qcow2", Sha256: sum[:], Format: "qcow2"}); err == nil {
		t.Fatal("a cached image with a backing file was used")
	}
}
