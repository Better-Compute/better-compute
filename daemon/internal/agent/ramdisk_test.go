package agent

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/fakehw"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"google.golang.org/protobuf/proto"
)

// ramdiskHarness is an agent with role ramdisk whose fakehw disks are sparse files under the fake root.
func ramdiskHarness(t *testing.T, mutate func(*Options)) (*harness, []*inventory.Disk) {
	t.Helper()
	h := newHarness(t, func(o *Options) {
		o.State.Role = "ramdisk"
		if mutate != nil {
			mutate(o)
		}
	})
	disks := fakehw.Inventory(1).Disks.Disks
	for _, d := range disks {
		p := h.host.Path("/dev/" + d.Name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		f, err := os.Create(p)
		if err != nil {
			t.Fatal(err)
		}
		if err := f.Truncate(int64(d.SizeBytes)); err != nil {
			t.Fatal(err)
		}
		// Old data at both ends: a partition table and a backup GPT.
		_, _ = f.WriteAt(bytes.Repeat([]byte{0xAB}, 4096), 0)
		_, _ = f.WriteAt(bytes.Repeat([]byte{0xCD}, 4096), int64(d.SizeBytes)-4096)
		f.Close()
	}
	return h, disks
}

func TestDiskWipeQuickVerifies(t *testing.T) {
	h, disks := ramdiskHarness(t, nil)
	s, _ := h.open()
	wipe := body("w1", "disk.wipe", &agentv1.WipeRequest{Mode: agentv1.WipeMode_WIPE_MODE_QUICK})
	wipe.Lane = commonv1.Lane_LANE_PROVISION
	wipe.Attested = true
	s.push(command(wipe))
	done := s.update(t, "w1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	res := &agentv1.WipeResult{}
	_ = proto.Unmarshal(done.GetResult(), res)
	if len(res.GetDisks()) != len(disks) || done.GetNodeSig() == nil {
		t.Fatalf("wipe = %v", res)
	}
	for _, d := range res.GetDisks() {
		if !d.GetVerified() || d.GetMethod() != "quick" {
			t.Fatalf("disk = %v", d)
		}
	}
	for _, d := range disks {
		if ok, err := zeroedEnds(h.host.Path("/dev/"+d.Name), d.SizeBytes); !ok || err != nil {
			t.Fatalf("%s not zeroed: %v", d.Name, err)
		}
	}
	// A disk that is not there fails the command.
	s.push(command(body("w2", "disk.wipe", &agentv1.WipeRequest{Disks: []string{"eui.missing"}})))
	if u := s.update(t, "w2", commonv1.CommandState_COMMAND_STATE_FAILED); u.GetError().GetCode() != "disk-missing" {
		t.Fatalf("missing disk = %v", u)
	}
	// Commissioning kinds are the ramdisk's only: a node refuses them (UNSUPPORTED).
	if _, ok := h.agent.reg.Lookup("disk.wipe", "node"); ok {
		t.Fatal("disk.wipe is allowed on a node")
	}
}

func TestDeployImageStreamsAndChecksTheDigest(t *testing.T) {
	image := make([]byte, 3<<20)
	_, _ = rand.Read(image)
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write(image)
	_ = zw.Close()
	stored := gz.Bytes()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(stored) }))
	defer srv.Close()
	h, disks := ramdiskHarness(t, nil)
	s, _ := h.open()
	target := disks[1]
	sum := sha256.Sum256(stored)
	deploy := body("d1", "deploy.image", &agentv1.DeployImageRequest{
		Url: srv.URL + "/ubuntu.raw.gz", Sha256: sum[:], Format: agentv1.ImageFormat_IMAGE_FORMAT_RAW,
		Compression: agentv1.ImageCompression_IMAGE_COMPRESSION_GZIP,
		RootDisk:    &agentv1.RootDiskHint{Serial: target.Serial},
		UserDataRef: "secret://t/ud", UserDataKind: "cloud-init",
	})
	deploy.Lane = commonv1.Lane_LANE_PROVISION
	deploy.WorkflowId, deploy.StepId = "wf_1", "deploy"
	s.push(command(deploy))
	// The user data is fetched for the workflow step, sealed to the one-time key.
	req := s.next(t, "SecretRequest", func(f *agentv1.AgentFrame) bool { return f.GetSecretRequest() != nil }).GetSecretRequest()
	if req.GetWorkflowId() != "wf_1" || req.GetStepId() != "deploy" {
		t.Fatalf("secret request = %v", req)
	}
	epk, _ := pki.PublicKeyFromPoint(req.GetEpk())
	jwe, _ := pki.SealJWE([]byte("#cloud-config\n"), epk, map[string]any{"typ": pki.SecretResponseType, "ref": req.GetRef(), "rid": req.GetRequestId()})
	s.push(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Secret{Secret: &agentv1.SecretResponse{Ref: req.GetRef(), RequestId: req.GetRequestId(), Jwe: jwe}}})
	done := s.update(t, "d1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	res := &agentv1.DeployImageResult{}
	_ = proto.Unmarshal(done.GetResult(), res)
	if res.GetWrittenBytes() != uint64(len(image)) || res.GetRootDisk() != target.Wwn || !bytes.Equal(res.GetSha256(), sum[:]) {
		t.Fatalf("deploy = %v", res)
	}
	written := make([]byte, len(image))
	f, _ := os.Open(h.host.Path("/dev/" + target.Name))
	_, _ = f.ReadAt(written, 0)
	f.Close()
	if !bytes.Equal(written, image) {
		t.Fatal("the disk does not hold the image")
	}
	if ud, _ := os.ReadFile(h.host.Path("/dev/"+target.Name) + ".user-data"); string(ud) != "#cloud-config\n" {
		t.Fatalf("user data = %q", ud)
	}

	// A substituted image fails and leaves nothing bootable behind.
	wrong := sha256.Sum256([]byte("another image"))
	bad := body("d2", "deploy.image", &agentv1.DeployImageRequest{
		Url: srv.URL + "/x", Sha256: wrong[:], Compression: agentv1.ImageCompression_IMAGE_COMPRESSION_GZIP,
		RootDisk: &agentv1.RootDiskHint{Serial: target.Serial},
	})
	s.push(command(bad))
	if u := s.update(t, "d2", commonv1.CommandState_COMMAND_STATE_FAILED); u.GetError().GetCode() != "checksum-mismatch" {
		t.Fatalf("bad digest = %v", u)
	}
	if ok, _ := zeroedEnds(h.host.Path("/dev/"+target.Name), target.SizeBytes); !ok {
		t.Fatal("a rejected image was left on the disk")
	}
}

func TestPickRootDiskAndDCGM(t *testing.T) {
	disks := []*inventory.Disk{
		{Name: "sda", SizeBytes: 64 << 30, Serial: "A", Removable: true},
		{Name: "nvme0n1", SizeBytes: 2 << 40, Serial: "B", Wwn: "eui.b"},
		{Name: "nvme1n1", SizeBytes: 960 << 30, Serial: "C", Wwn: "eui.c"},
		{Name: "sdb", SizeBytes: 1 << 30, Serial: "D"},
	}
	if d, _ := pickRootDisk(disks, nil); d.Name != "nvme1n1" {
		t.Fatalf("default root disk = %s", d.Name)
	}
	if d, _ := pickRootDisk(disks, &agentv1.RootDiskHint{Wwn: "eui.b"}); d.Name != "nvme0n1" {
		t.Fatalf("by wwn = %s", d.Name)
	}
	if _, err := pickRootDisk(disks, &agentv1.RootDiskHint{Serial: "Z"}); err == nil {
		t.Fatal("a hint matching nothing picked a disk")
	}
	gpus := []*inventory.Gpu{{Index: 0, Uuid: "GPU-a"}, {Index: 1, Uuid: "GPU-b"}}
	out := []byte(`{"DCGM GPU Diagnostic": {"test_categories": [
	  {"category": "Deployment", "tests": [{"name": "Denylist", "results": [{"status": "Pass"}]}]},
	  {"category": "Hardware", "tests": [{"name": "GPU Memory", "results": [
	    {"gpu_id": "0", "status": "Pass"},
	    {"gpu_id": "1", "status": "Fail", "warnings": [{"warning": "DBE detected"}]}]}]},
	  {"category": "Integration", "tests": [{"name": "PCIe", "results": [{"gpu_id": "0", "status": "Skip"}]}]}]}}`)
	r, err := parseDCGM(out, nil, gpus)
	if err != nil || r.GetPassed() || len(r.GetGpus()) != 2 || len(r.GetTests()) != 1 {
		t.Fatalf("dcgm = %v, %v", r, err)
	}
	if !r.GetGpus()[0].GetPassed() || r.GetGpus()[1].GetPassed() || r.GetGpus()[1].GetChecks()[0].GetMessage() != "DBE detected" {
		t.Fatalf("per GPU = %v", r.GetGpus())
	}
}

func TestPartitionsAndBootFiles(t *testing.T) {
	parts, err := partitions([]byte(`{"blockdevices":[{"name":"nvme0n1","size":2000,"type":"disk","children":[
	  {"name":"nvme0n1p1","size":500,"type":"part","fstype":"vfat","label":"EFI"},
	  {"name":"nvme0n1p2","size":1400,"type":"part","fstype":"ext4","uuid":"u-root"}]}]}`))
	if err != nil || len(parts) != 2 || parts[0].Name != "nvme0n1p2" || parts[0].UUID != "u-root" {
		t.Fatalf("partitions = %+v, %v", parts, err)
	}
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "boot"), 0o755)
	for _, f := range []string{"vmlinuz-6.8.0-40-generic", "vmlinuz-6.8.0-45-generic", "initrd.img-6.8.0-45-generic"} {
		_ = os.WriteFile(filepath.Join(root, "boot", f), nil, 0o644)
	}
	if k, i := bootFiles(root, "", ""); k != filepath.Join("boot", "vmlinuz-6.8.0-45-generic") || i != "boot/initrd.img-6.8.0-45-generic" {
		t.Fatalf("boot files = %q %q", k, i)
	}
	if k, _ := bootFiles(root, "/boot/missing", ""); k != "" {
		t.Fatal("a missing explicit kernel was accepted")
	}
}
