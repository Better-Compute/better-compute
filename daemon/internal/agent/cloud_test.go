package agent

import (
	"context"
	"crypto/sha256"
	"errors"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"google.golang.org/protobuf/proto"
)

// fakeCloud is a Cloud whose Section fails while down.
type fakeCloud struct {
	mu      sync.Mutex
	section *agentv1.CloudSection
	down    bool
	calls   int
}

func (c *fakeCloud) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

func (c *fakeCloud) Section(context.Context) (*agentv1.CloudSection, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	if c.down {
		return nil, errors.New("metadata unreachable")
	}
	return proto.Clone(c.section).(*agentv1.CloudSection), nil
}

var testCloudSection = &agentv1.CloudSection{
	Provider: "aws", InstanceId: "i-0123456789abcdef0", InstanceType: "p5.48xlarge",
	Region: "us-east-1", Zone: "us-east-1a", ZoneId: "use1-az4", Lifecycle: "on-demand", EfaDevices: 32,
}

func cloudSectionOf(t *testing.T, f *agentv1.AgentFrame) *agentv1.CloudSection {
	t.Helper()
	inv := f.GetInventory()
	if sha256.Sum256(inv.GetContent()) != [32]byte(inv.GetSha256()) {
		t.Fatal("cloud section hash mismatch")
	}
	got := &agentv1.CloudSection{}
	if err := proto.Unmarshal(inv.GetContent(), got); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestCloudSectionIsReported(t *testing.T) {
	cloud := &fakeCloud{section: testCloudSection}
	h := newHarness(t, func(o *Options) { o.Cloud = cloud })
	s, hello := h.open("cloud")
	if len(hello.GetInventoryHashes()["cloud"]) != 32 {
		t.Fatalf("Hello carries no cloud hash: %v", hello.GetInventoryHashes())
	}
	f := s.next(t, "cloud section", func(f *agentv1.AgentFrame) bool { return f.GetInventory().GetSection() == "cloud" })
	if got := cloudSectionOf(t, f); !proto.Equal(got, testCloudSection) {
		t.Fatalf("cloud section %v", got)
	}
}

func TestCloudSectionArrivesOnceTheMetadataAnswers(t *testing.T) {
	cloud := &fakeCloud{section: testCloudSection, down: true}
	h := newHarness(t, func(o *Options) {
		o.Cloud = cloud
		o.CloudRetry = 10 * time.Millisecond
	})
	s, hello := h.open()
	if _, ok := hello.GetInventoryHashes()["cloud"]; ok {
		t.Fatal("a cloud hash before the metadata answered")
	}
	cloud.mu.Lock()
	cloud.down = false
	cloud.mu.Unlock()
	// The re-collection pushes the new section, and the next heartbeat carries its hash.
	f := s.next(t, "cloud section", func(f *agentv1.AgentFrame) bool { return f.GetInventory().GetSection() == "cloud" })
	if got := cloudSectionOf(t, f); !proto.Equal(got, testCloudSection) {
		t.Fatalf("cloud section %v", got)
	}
	// Once it has the section it stops asking.
	calls := cloud.count()
	time.Sleep(100 * time.Millisecond)
	if cloud.count() != calls {
		t.Fatal("the metadata is still read after the section arrived")
	}
}

func TestNoCloudSectionWithoutACloud(t *testing.T) {
	h := newHarness(t, nil)
	_, hello := h.open()
	if _, ok := hello.GetInventoryHashes()["cloud"]; ok {
		t.Fatal("a cloud hash off a cloud")
	}
}
