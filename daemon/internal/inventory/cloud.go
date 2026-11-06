package inventory

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"time"
)

// DigitalOceanMetadata reads a Droplet's metadata service for the system section's Cloud: the
// Droplet id, region, tags and interfaces (inventory only). The service is unauthenticated and
// unsigned, so the result is never an identity: nodes on DigitalOcean join with tokens.
//
// The service is asked only when DMI names DigitalOcean as the system vendor (sys_vendor is
// world-readable), so no other machine ever sends a request to 169.254.169.254. DigitalOcean does
// not document its metadata response headers, so they are not what decides it (decision D-P3-7).
// The document also holds user data (a join token can be in it), vendor data, SSH keys and an auth
// key: only the fields above are decoded, and nothing from the response reaches a log or an error.
type DigitalOceanMetadata struct {
	// URL defaults to http://169.254.169.254/metadata/v1.json.
	URL string
	// Client defaults to a direct client (no proxy, no redirects) with a 2-second timeout.
	Client *http.Client
}

const (
	digitalOceanMetadataURL = "http://169.254.169.254/metadata/v1.json"
	// digitalOceanVendor is DMI sys_vendor on every Droplet.
	digitalOceanVendor = "DigitalOcean"
	// maxMetadataBytes caps the document: user data alone may be 64 KiB.
	maxMetadataBytes = 1 << 20
	maxCloudTags     = 128
	// maxCloudInterfaces caps the interfaces kept, after sorting.
	maxCloudInterfaces = 16
)

var (
	cloudRegion = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	// DigitalOcean tag names: letters, digits, colons, dashes and underscores, at most 255.
	cloudTag = regexp.MustCompile(`^[A-Za-z0-9:_-]{1,255}$`)
)

func (d DigitalOceanMetadata) client() *http.Client {
	if d.Client != nil {
		return d.Client
	}
	return &http.Client{
		Timeout: 2 * time.Second,
		// Proxy nil: the link-local service is reached directly, never through HTTP(S)_PROXY.
		Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true, ResponseHeaderTimeout: 2 * time.Second},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// doMetadata is the subset of /metadata/v1.json bcd reads. Everything else (user_data,
// vendor_data, public_keys, auth_key, dns, ...) is skipped by the decoder and never kept.
type doMetadata struct {
	DropletID  uint64                   `json:"droplet_id"`
	Region     string                   `json:"region"`
	Tags       []string                 `json:"tags"`
	Interfaces map[string][]doInterface `json:"interfaces"`
}

type doInterface struct {
	Mac  string `json:"mac"`
	IPv4 *struct {
		IPAddress string `json:"ip_address"`
		Netmask   string `json:"netmask"`
		Gateway   string `json:"gateway"`
	} `json:"ipv4"`
	IPv6 *struct {
		IPAddress string `json:"ip_address"`
		CIDR      uint32 `json:"cidr"`
		Gateway   string `json:"gateway"`
	} `json:"ipv6"`
}

// Instance returns the Droplet's cloud instance, or nil: off a Droplet (vendor is not
// "DigitalOcean"), when the service does not answer 200 directly, or when the document is
// malformed or too large. It is the Collector's Cloud hook.
func (d DigitalOceanMetadata) Instance(vendor, _ string) *CloudInstance {
	if vendor != digitalOceanVendor {
		return nil
	}
	url := d.URL
	if url == "" {
		url = digitalOceanMetadataURL
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Accept", "application/json")
	resp, err := d.client().Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxMetadataBytes))
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxMetadataBytes+1))
	if err != nil || len(body) > maxMetadataBytes {
		return nil
	}
	var doc doMetadata
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil
	}
	if doc.DropletID == 0 || !cloudRegion.MatchString(doc.Region) {
		return nil
	}
	return &CloudInstance{
		Provider:   "digitalocean",
		InstanceId: strconv.FormatUint(doc.DropletID, 10),
		Region:     doc.Region,
		Tags:       cloudTags(doc.Tags),
		Interfaces: cloudInterfaces(doc.Interfaces),
	}
}

// cloudTags: the well-formed tags, sorted, without duplicates, at most maxCloudTags.
func cloudTags(tags []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, tag := range tags {
		if cloudTag.MatchString(tag) && !seen[tag] {
			seen[tag] = true
			out = append(out, tag)
		}
	}
	sort.Strings(out)
	if len(out) > maxCloudTags {
		out = out[:maxCloudTags]
	}
	return out
}

// cloudInterfaces: the public and private interfaces with a valid MAC, sorted by (network, MAC), at
// most maxCloudInterfaces. Malformed addresses are dropped, not kept as they came.
func cloudInterfaces(networks map[string][]doInterface) []*CloudInterface {
	var out []*CloudInterface
	for _, network := range []string{"private", "public"} {
		for _, nic := range networks[network] {
			mac, err := net.ParseMAC(nic.Mac)
			if err != nil || len(mac) != 6 {
				continue
			}
			ci := &CloudInterface{Network: network, Mac: mac.String()}
			if v4 := nic.IPv4; v4 != nil {
				if ip := ipv4(v4.IPAddress); ip != "" {
					ci.Ipv4Address = ip
					ci.Ipv4Netmask = ipv4(v4.Netmask)
					ci.Ipv4Gateway = ipv4(v4.Gateway)
				}
			}
			if v6 := nic.IPv6; v6 != nil {
				if ip := ipv6(v6.IPAddress); ip != "" && v6.CIDR >= 1 && v6.CIDR <= 128 {
					ci.Ipv6Address = ip
					ci.Ipv6PrefixLength = v6.CIDR
					ci.Ipv6Gateway = ipv6(v6.Gateway)
				}
			}
			out = append(out, ci)
		}
	}
	sortBy(out, func(i *CloudInterface) string { return i.Network + "/" + i.Mac })
	if len(out) > maxCloudInterfaces {
		out = out[:maxCloudInterfaces]
	}
	return out
}

func ipv4(s string) string {
	ip := net.ParseIP(s)
	if ip == nil || ip.To4() == nil {
		return ""
	}
	return ip.To4().String()
}

func ipv6(s string) string {
	ip := net.ParseIP(s)
	if ip == nil || ip.To4() != nil {
		return ""
	}
	return ip.String()
}
