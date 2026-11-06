package aws

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"google.golang.org/protobuf/proto"
)

// ibDevice adds /sys/class/infiniband/<name> whose PCI device is bound to driver.
func ibDevice(t *testing.T, root, name, driver string) {
	t.Helper()
	dir := filepath.Join(root, "sys", "class", "infiniband", name, "device")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "uevent"), []byte("DRIVER="+driver+"\nPCI_CLASS=20000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSectionFromMetadata(t *testing.T) {
	f, srv := newFakeIMDS(t)
	f.paths["/latest/meta-data/placement/availability-zone-id"] = "use1-az4"
	f.paths["/latest/meta-data/instance-life-cycle"] = "spot"
	c := ec2Client(t, srv)
	ibDevice(t, c.Root, "rdmap0s6", "efa")
	ibDevice(t, c.Root, "rdmap0s7", "efa")
	ibDevice(t, c.Root, "mlx5_0", "mlx5_core")
	got, err := c.Section(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := &agentv1.CloudSection{
		Provider: "aws", InstanceId: "i-0123456789abcdef0", InstanceType: "p5.48xlarge",
		Region: "us-east-1", Zone: "us-east-1a", ZoneId: "use1-az4", Lifecycle: "spot", EfaDevices: 2,
	}
	if !proto.Equal(got, want) {
		t.Fatalf("section %v, want %v", got, want)
	}
}

func TestSectionLifecycles(t *testing.T) {
	for raw, want := range map[string]string{
		"on-demand": "on-demand", "spot": "spot", "capacity-block": "capacity-block",
		"scheduled": "", "": "", "Spot": "",
	} {
		if got := lifecycle(raw); got != want {
			t.Errorf("lifecycle(%q) = %q, want %q", raw, got, want)
		}
	}
	// Optional paths may be missing: the section is still whole without them.
	_, srv := newFakeIMDS(t)
	c := ec2Client(t, srv)
	got, err := c.Section(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.GetZoneId() != "" || got.GetLifecycle() != "" || got.GetEfaDevices() != 0 || got.GetInstanceType() != "p5.48xlarge" {
		t.Fatalf("section %v", got)
	}
}

func TestSectionOffEC2(t *testing.T) {
	f, srv := newFakeIMDS(t)
	c := &Client{Root: dmiRoot(t, "QEMU"), Endpoint: srv.URL}
	if _, err := c.Section(context.Background()); !errors.Is(err, ErrNotEC2) || len(f.log()) != 0 {
		t.Fatalf("err %v, %d requests", err, len(f.log()))
	}
}
