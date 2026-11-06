package aws

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// Section is the instance's "cloud" inventory section: the identity document's instance, type,
// region and zone, the zone id and purchase lifecycle (optional paths: missing ones stay empty),
// and the EFA devices under Root.
func (c *Client) Section(ctx context.Context) (*agentv1.CloudSection, error) {
	raw, err := c.Get(ctx, documentPath)
	if err != nil {
		return nil, err
	}
	var doc struct {
		InstanceID       string `json:"instanceId"`
		InstanceType     string `json:"instanceType"`
		Region           string `json:"region"`
		AvailabilityZone string `json:"availabilityZone"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil || doc.InstanceID == "" {
		return nil, errors.New("aws: the instance identity document names no instance")
	}
	s := &agentv1.CloudSection{
		Provider:     "aws",
		InstanceId:   doc.InstanceID,
		InstanceType: doc.InstanceType,
		Region:       doc.Region,
		Zone:         doc.AvailabilityZone,
		EfaDevices:   uint32(EFADevices(c.Root)),
	}
	if s.ZoneId, err = c.optional(ctx, "/latest/meta-data/placement/availability-zone-id"); err != nil {
		return nil, err
	}
	life, err := c.optional(ctx, "/latest/meta-data/instance-life-cycle")
	if err != nil {
		return nil, err
	}
	s.Lifecycle = lifecycle(life)
	return s, nil
}

// optional reads a short metadata value; a missing path is "".
func (c *Client) optional(ctx context.Context, path string) (string, error) {
	raw, err := c.Get(ctx, path)
	if errors.Is(err, ErrNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	v := strings.TrimSpace(string(raw))
	if len(v) > 128 || strings.ContainsAny(v, "\r\n") {
		return "", nil
	}
	return v, nil
}

// lifecycle maps instance-life-cycle to the section's values; anything else is unknown ("").
func lifecycle(raw string) string {
	switch raw {
	case "on-demand", "spot", "capacity-block":
		return raw
	}
	return ""
}

// EFADevices counts the Elastic Fabric Adapters: /sys/class/infiniband devices whose PCI device is
// bound to the efa driver (uevent DRIVER=efa, else the driver link).
func EFADevices(root string) int {
	if root == "" {
		root = "/"
	}
	base := filepath.Join(root, "sys", "class", "infiniband")
	entries, err := os.ReadDir(base)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if deviceDriver(filepath.Join(base, e.Name(), "device")) == "efa" {
			n++
		}
	}
	return n
}

func deviceDriver(dev string) string {
	if f, err := os.Open(filepath.Join(dev, "uevent")); err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if v, ok := strings.CutPrefix(sc.Text(), "DRIVER="); ok {
				return strings.TrimSpace(v)
			}
		}
	}
	if target, err := os.Readlink(filepath.Join(dev, "driver")); err == nil {
		return filepath.Base(target)
	}
	return ""
}
