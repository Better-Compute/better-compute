package agent

import (
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/pxe"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// PXE discovery (site.proto: "an unknown machine becomes a discovery event"): the machines that
// PXE-boot on the site's provisioning network with no boot prepared for them. The site agent never
// answers them and never enrolls them; it lists them in StatusReport.discovered, so metal can match
// a machine enrolled without MACs (IPMI) by its SMBIOS UUID, or offer it for enrollment.
//   - only PXEClient/HTTPClient requests (pxe.Request) and iPXE script fetches, from a MAC without a
//     live boot entry, while this agent holds the boot lease;
//   - at most discoveryCap machines (the oldest last-seen goes), forgotten discoveryTTL after they
//     were last seen;
//   - a new machine asks for a status report, at most one per discoveryPush.

const (
	discoveryCap  = 256
	discoveryTTL  = 24 * time.Hour
	discoveryPush = 30 * time.Second
)

type discoveredMachine struct {
	uuid, arch, relay string
	first, last       time.Time
	count             uint32
}

// discovery is the site agent's list of unknown PXE machines.
type discovery struct {
	mu       sync.Mutex
	machines map[string]*discoveredMachine
	lastPush time.Time
	// dhcp: this agent answers proxyDHCP, so every PXE machine shows there first.
	dhcp bool
}

// archName names a PXE client architecture (DiscoveredMachine.arch).
func archName(a pxe.Arch) string {
	switch a {
	case pxe.ArchBIOS:
		return "bios"
	case pxe.ArchEFIx86_64, pxe.ArchEFIx86_64b:
		return "x86_64-efi"
	case pxe.ArchEFIArm64:
		return "arm64-efi"
	case pxe.ArchHTTPx86_64:
		return "x86_64-efi-http"
	case pxe.ArchHTTPArm64:
		return "arm64-efi-http"
	}
	return "arch-" + strconv.Itoa(int(a)) // RFC 4578 / IANA number
}

var (
	// What an unknown machine says is taken only in these shapes: anything else is dropped, so no
	// client can grow the status report (review 2 MED).
	canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	archShape     = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)
)

// seen records a request from mac; it reports whether a status report should go out now (a new
// machine, not within discoveryPush of the last push). httpOnly: a sighting over HTTP (an iPXE
// fetch), recorded only for a MAC DHCP already showed when dhcp is on (proxyDHCP runs here).
func (d *discovery) seen(now time.Time, mac, uuid, arch, relay string) bool {
	return d.sighting(now, mac, uuid, arch, relay, false)
}

func (d *discovery) sighting(now time.Time, mac, uuid, arch, relay string, httpOnly bool) bool {
	hw, err := net.ParseMAC(mac)
	if err != nil {
		return false
	}
	mac = hw.String()
	if uuid = strings.ToLower(uuid); !canonicalUUID.MatchString(uuid) {
		uuid = ""
	}
	if arch = strings.ToLower(arch); !archShape.MatchString(arch) {
		arch = ""
	}
	if ip := net.ParseIP(relay); ip != nil {
		relay = ip.String()
	} else {
		relay = ""
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if httpOnly && d.dhcp {
		if _, known := d.machines[mac]; !known {
			return false
		}
	}
	if d.machines == nil {
		d.machines = map[string]*discoveredMachine{}
	}
	d.expire(now)
	m, known := d.machines[mac]
	if !known {
		if len(d.machines) >= discoveryCap {
			d.evictOldest()
		}
		m = &discoveredMachine{first: now}
		d.machines[mac] = m
	}
	m.last = now
	m.count++
	if uuid != "" {
		m.uuid = uuid
	}
	if arch != "" {
		m.arch = arch
	}
	if relay != "" {
		m.relay = relay
	}
	if known || now.Sub(d.lastPush) < discoveryPush {
		return false
	}
	d.lastPush = now
	return true
}

func (d *discovery) expire(now time.Time) {
	for mac, m := range d.machines {
		if now.Sub(m.last) > discoveryTTL {
			delete(d.machines, mac)
		}
	}
}

func (d *discovery) evictOldest() {
	oldest := ""
	for mac, m := range d.machines {
		if oldest == "" || m.last.Before(d.machines[oldest].last) {
			oldest = mac
		}
	}
	delete(d.machines, oldest)
}

// forget drops a machine that got a boot entry (it is no longer unknown).
func (d *discovery) forget(mac string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.machines, strings.ToLower(mac))
}

// list is StatusReport.discovered, sorted by MAC.
func (d *discovery) list(now time.Time) []*agentv1.DiscoveredMachine {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.expire(now)
	macs := make([]string, 0, len(d.machines))
	for mac := range d.machines {
		macs = append(macs, mac)
	}
	sort.Strings(macs)
	out := make([]*agentv1.DiscoveredMachine, 0, len(macs))
	for _, mac := range macs {
		m := d.machines[mac]
		out = append(out, &agentv1.DiscoveredMachine{Mac: mac, ProductUuid: m.uuid, Arch: m.arch, Relay: m.relay,
			FirstSeen: timestamppb.New(m.first), LastSeen: timestamppb.New(m.last), Count: m.count})
	}
	return out
}

// discovered records an unknown PXE machine and pushes a status report when it is new.
func (a *Agent) discovered(mac, uuid, arch, relay string, httpOnly bool) {
	if a.discovery.sighting(a.serverNow(), mac, uuid, arch, relay, httpOnly) {
		a.log.Info("an unknown machine PXE-booted", "mac", mac, "uuid", uuid, "arch", arch)
		a.triggerConverge()
	}
}
