package runtime

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// Ballooner is a runtime that resizes a running guest's virtio balloon (InstancePlacement.balloon):
// SetBalloon leaves the guest guestBytes of its memory, lending the rest to the host; its configured
// memory is the most. Balloons returns what each ballooned guest has now (absent: its full memory).
type Ballooner interface {
	SetBalloon(ctx context.Context, id string, guestBytes uint64) error
	Balloons(ctx context.Context) (map[string]uint64, error)
}

// ErrNoBalloon: the guest was defined without a balloon device (its spec has no placement.balloon,
// or it has hugepages).
var ErrNoBalloon = errors.New("the guest has no balloon device")

// SetBalloon asks libvirt to set the guest's current memory (virsh setmem --live, KiB).
func (l *Libvirt) SetBalloon(ctx context.Context, id string, guestBytes uint64) error {
	raw, err := l.virsh(ctx, "dumpxml", id)
	if err != nil {
		return err
	}
	var x domainXML
	if err := xml.Unmarshal(raw, &x); err != nil || x.Metadata == nil || x.Metadata.Instance.ID != id {
		return fmt.Errorf("no managed domain %s", id)
	}
	if b := x.Devices.Memballoon; b == nil || b.Model == "none" {
		return fmt.Errorf("%s: %w", id, ErrNoBalloon)
	}
	_, err = l.virsh(ctx, "setmem", id, strconv.FormatUint(guestBytes/1024, 10), "--live")
	return err
}

// Balloons reads each running domain's balloon.current (virsh domstats --balloon, KiB).
func (l *Libvirt) Balloons(ctx context.Context) (map[string]uint64, error) {
	out, err := l.virsh(ctx, "domstats", "--raw", "--state-running", "--balloon")
	if err != nil {
		return nil, err
	}
	return parseBalloonStats(out), nil
}

// parseBalloonStats reads balloon.current per domain from `virsh domstats --raw --balloon`.
func parseBalloonStats(out []byte) map[string]uint64 {
	sizes := map[string]uint64{}
	current := ""
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if name, ok := strings.CutPrefix(line, "Domain: "); ok {
			current = strings.Trim(name, "'\"")
			continue
		}
		if v, ok := strings.CutPrefix(line, "balloon.current="); ok && current != "" {
			if n, err := strconv.ParseUint(v, 10, 64); err == nil {
				sizes[current] = n * 1024
			}
		}
	}
	return sizes
}

// SetBalloon resizes the VMM's balloon (vm.resize desired_balloon: what the host takes back).
func (c *CloudHypervisor) SetBalloon(ctx context.Context, id string, guestBytes uint64) error {
	domains, err := c.List(ctx)
	if err != nil {
		return err
	}
	for _, d := range domains {
		if d.ID != id {
			continue
		}
		if guestBytes > d.MemoryBytes {
			guestBytes = d.MemoryBytes
		}
		raw, err := c.api(ctx, id, http.MethodGet, "vm.info", nil)
		if err != nil {
			return err
		}
		var info struct {
			Config struct {
				Balloon json.RawMessage `json:"balloon"`
			} `json:"config"`
		}
		if json.Unmarshal(raw, &info) != nil || len(info.Config.Balloon) == 0 || string(info.Config.Balloon) == "null" {
			return fmt.Errorf("%s: %w", id, ErrNoBalloon)
		}
		_, err = c.api(ctx, id, http.MethodPut, "vm.resize", map[string]uint64{"desired_balloon": d.MemoryBytes - guestBytes})
		return err
	}
	return fmt.Errorf("no domain %s", id)
}

// Balloons reads each running VMM's balloon (vm.info config.balloon.size) and returns what it leaves
// the guest.
func (c *CloudHypervisor) Balloons(ctx context.Context) (map[string]uint64, error) {
	domains, err := c.List(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]uint64{}
	for _, d := range domains {
		if !d.Managed || d.State != StateRunning {
			continue
		}
		raw, err := c.api(ctx, d.ID, http.MethodGet, "vm.info", nil)
		if err != nil {
			continue
		}
		var info struct {
			Config struct {
				Balloon *struct {
					Size uint64 `json:"size"`
				} `json:"balloon"`
			} `json:"config"`
		}
		if json.Unmarshal(raw, &info) != nil || info.Config.Balloon == nil || info.Config.Balloon.Size > d.MemoryBytes {
			continue
		}
		out[d.ID] = d.MemoryBytes - info.Config.Balloon.Size
	}
	return out, nil
}

// The fake's balloons, by runtime file and domain (the fake keeps no balloon in its JSON state).
var fakeBalloons sync.Map

// SetBalloon records the size (never above the domain's memory).
func (f *Fake) SetBalloon(ctx context.Context, id string, guestBytes uint64) error {
	domains, err := f.List(ctx)
	if err != nil {
		return err
	}
	for _, d := range domains {
		if d.ID == id {
			fakeBalloons.Store(f.Path+"\x00"+id, min(guestBytes, d.MemoryBytes))
			return nil
		}
	}
	return fmt.Errorf("no domain %s", id)
}

// Balloons returns the recorded sizes of the fake's domains.
func (f *Fake) Balloons(ctx context.Context) (map[string]uint64, error) {
	domains, err := f.List(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]uint64{}
	for _, d := range domains {
		if v, ok := fakeBalloons.Load(f.Path + "\x00" + d.ID); ok {
			out[d.ID] = v.(uint64)
		}
	}
	return out, nil
}
