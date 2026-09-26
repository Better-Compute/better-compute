package runtime

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
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

// fakeBalloonsFile keeps the fake's balloons beside its state (<Path>.balloons, id → bytes), so they
// outlive the process and tests read them as they read the domains.
func (f *Fake) fakeBalloonsFile() string { return f.Path + ".balloons" }

func (f *Fake) loadBalloons() map[string]uint64 {
	sizes := map[string]uint64{}
	if raw, err := os.ReadFile(f.fakeBalloonsFile()); err == nil {
		_ = json.Unmarshal(raw, &sizes)
	}
	return sizes
}

// SetBalloon records the size (never above the domain's memory) of a running domain.
func (f *Fake) SetBalloon(ctx context.Context, id string, guestBytes uint64) error {
	domains, err := f.List(ctx)
	if err != nil {
		return err
	}
	for _, d := range domains {
		if d.ID != id {
			continue
		}
		if d.State != StateRunning {
			return fmt.Errorf("domain %s is not running", id)
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		sizes := f.loadBalloons()
		sizes[id] = min(guestBytes, d.MemoryBytes)
		raw, err := json.Marshal(sizes)
		if err != nil {
			return err
		}
		return os.WriteFile(f.fakeBalloonsFile(), raw, 0o600)
	}
	return fmt.Errorf("no domain %s", id)
}

// Balloons returns the recorded sizes of the fake's running domains.
func (f *Fake) Balloons(ctx context.Context) (map[string]uint64, error) {
	domains, err := f.List(ctx)
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	sizes := f.loadBalloons()
	f.mu.Unlock()
	out := map[string]uint64{}
	for _, d := range domains {
		if v, ok := sizes[d.ID]; ok && d.State == StateRunning {
			out[d.ID] = v
		}
	}
	return out, nil
}
