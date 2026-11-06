package inventory

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"google.golang.org/protobuf/proto"
)

// A Droplet's /metadata/v1.json, shaped as DigitalOcean documents it, with the fields bcd must
// never keep (user data, vendor data, keys, the auth key).
const dropletMetadata = `{
  "droplet_id": 2756294,
  "hostname": "sample-droplet",
  "vendor_data": "#cloud-config\ndisable_root: false\n",
  "user_data": "#cloud-config\nwrite_files:\n- content: BC_JOIN_TOKEN=secret-join-token\n",
  "public_keys": ["ssh-rsa AAAAB3Nz secret-key"],
  "auth_key": "secret-auth-key",
  "region": "nyc3",
  "interfaces": {
    "private": [
      {"ipv4": {"ip_address": "10.132.255.113", "netmask": "255.255.0.0", "gateway": "0.0.0.0"},
       "mac": "04:01:2A:0F:2A:02", "type": "private"}
    ],
    "public": [
      {"ipv4": {"ip_address": "104.131.20.105", "netmask": "255.255.192.0", "gateway": "104.131.0.1"},
       "ipv6": {"ip_address": "2604:A880:0800:0010:0000:0000:017D:2001", "cidr": 64, "gateway": "2604:A880:0800:0010:0000:0000:0000:0001"},
       "anchor_ipv4": {"ip_address": "10.17.0.5", "netmask": "255.255.0.0", "gateway": "10.17.0.1"},
       "mac": "04:01:2a:0f:2a:01", "type": "public"}
    ]
  },
  "floating_ip": {"ipv4": {"active": false}},
  "dns": {"nameservers": ["2001:4860:4860::8844", "8.8.8.8"]},
  "tags": ["pool-a", "better-compute-managed:true", "pool-a", "bad tag with spaces"],
  "features": {"dhcp_enabled": false}
}`

func metadataServer(t *testing.T, status int, body string, hits *atomic.Int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits != nil {
			hits.Add(1)
		}
		if r.URL.Path != "/metadata/v1.json" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestDigitalOceanMetadataReadsADroplet(t *testing.T) {
	srv := metadataServer(t, http.StatusOK, dropletMetadata, nil)
	got := DigitalOceanMetadata{URL: srv.URL + "/metadata/v1.json"}.Instance("DigitalOcean", "Droplet")
	want := &CloudInstance{
		Provider:   "digitalocean",
		InstanceId: "2756294",
		Region:     "nyc3",
		Tags:       []string{"better-compute-managed:true", "pool-a"},
		Interfaces: []*CloudInterface{
			{Network: "private", Mac: "04:01:2a:0f:2a:02", Ipv4Address: "10.132.255.113", Ipv4Netmask: "255.255.0.0", Ipv4Gateway: "0.0.0.0"},
			{
				Network: "public", Mac: "04:01:2a:0f:2a:01",
				Ipv4Address: "104.131.20.105", Ipv4Netmask: "255.255.192.0", Ipv4Gateway: "104.131.0.1",
				Ipv6Address: "2604:a880:800:10::17d:2001", Ipv6PrefixLength: 64, Ipv6Gateway: "2604:a880:800:10::1",
			},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

// The section bytes never carry user data, vendor data, keys or the auth key.
func TestDigitalOceanMetadataKeepsNoSecrets(t *testing.T) {
	srv := metadataServer(t, http.StatusOK, dropletMetadata, nil)
	cloud := DigitalOceanMetadata{URL: srv.URL + "/metadata/v1.json"}.Instance("DigitalOcean", "Droplet")
	if cloud == nil {
		t.Fatal("no cloud instance")
	}
	sections, err := EncodeSections(&NodeInventory{System: &SystemSection{Vendor: "DigitalOcean", Cloud: cloud}})
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"secret", "cloud-config", "ssh-rsa", "sample-droplet", "8.8.8.8"} {
		if strings.Contains(string(sections[0].Content), secret) {
			t.Errorf("system section carries %q", secret)
		}
	}
}

// Off a Droplet the metadata service is never asked: not on another cloud's VM, not on metal.
func TestDigitalOceanMetadataOnlyOnADroplet(t *testing.T) {
	var hits atomic.Int32
	srv := metadataServer(t, http.StatusOK, dropletMetadata, &hits)
	d := DigitalOceanMetadata{URL: srv.URL + "/metadata/v1.json"}
	for _, vendor := range []string{"", "Amazon EC2", "Google", "QEMU", "Supermicro", "digitalocean-ish"} {
		if got := d.Instance(vendor, "Droplet"); got != nil {
			t.Errorf("vendor %q: got %+v", vendor, got)
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("metadata service asked %d times off a Droplet", n)
	}
}

func TestDigitalOceanMetadataRefusesBadAnswers(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		body   string
	}{
		"not found":     {http.StatusNotFound, `{"droplet_id": 1, "region": "nyc3"}`},
		"server error":  {http.StatusInternalServerError, dropletMetadata},
		"not json":      {http.StatusOK, `<html>captive portal</html>`},
		"no droplet id": {http.StatusOK, `{"region": "nyc3"}`},
		"zero id":       {http.StatusOK, `{"droplet_id": 0, "region": "nyc3"}`},
		"negative id":   {http.StatusOK, `{"droplet_id": -4, "region": "nyc3"}`},
		"string id":     {http.StatusOK, `{"droplet_id": "12", "region": "nyc3"}`},
		"bad region":    {http.StatusOK, `{"droplet_id": 12, "region": "NYC 3; rm -rf"}`},
		"too large":     {http.StatusOK, `{"droplet_id": 12, "region": "nyc3", "user_data": "` + strings.Repeat("x", 2<<20) + `"}`},
	} {
		t.Run(name, func(t *testing.T) {
			srv := metadataServer(t, tc.status, tc.body, nil)
			if got := (DigitalOceanMetadata{URL: srv.URL + "/metadata/v1.json"}).Instance("DigitalOcean", "Droplet"); got != nil {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

// A redirect is not followed (the answer must come from the link-local service itself), and the
// service is reached directly even when the environment names a proxy.
func TestDigitalOceanMetadataNoRedirectNoProxy(t *testing.T) {
	var elsewhere atomic.Int32
	target := metadataServer(t, http.StatusOK, dropletMetadata, &elsewhere)
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/metadata/v1.json", http.StatusFound)
	}))
	t.Cleanup(redirect.Close)
	if got := (DigitalOceanMetadata{URL: redirect.URL + "/metadata/v1.json"}).Instance("DigitalOcean", "Droplet"); got != nil {
		t.Fatalf("followed a redirect: %+v", got)
	}
	if elsewhere.Load() != 0 {
		t.Fatal("redirect target was asked")
	}

	var proxied atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxied.Add(1)
		http.Error(w, "proxy", http.StatusBadGateway)
	}))
	t.Cleanup(proxy.Close)
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("http_proxy", proxy.URL)
	t.Setenv("NO_PROXY", "")
	t.Setenv("no_proxy", "")
	direct := metadataServer(t, http.StatusOK, dropletMetadata, nil)
	// httptest listens on 127.0.0.1, which ProxyFromEnvironment never proxies; a hostname that
	// resolves to it would be. The client must have no proxy at all, so check it directly too.
	if (DigitalOceanMetadata{}).client().Transport.(*http.Transport).Proxy != nil {
		t.Fatal("metadata client uses a proxy")
	}
	if got := (DigitalOceanMetadata{URL: direct.URL + "/metadata/v1.json"}).Instance("DigitalOcean", "Droplet"); got == nil {
		t.Fatal("no answer directly")
	}
	if proxied.Load() != 0 {
		t.Fatal("asked through the proxy")
	}
}

func TestDigitalOceanMetadataCapsTagsAndInterfaces(t *testing.T) {
	var tags []string
	for i := 0; i < 300; i++ {
		tags = append(tags, `"t`+strings.Repeat("a", i%5)+string(rune('a'+i%26))+string(rune('a'+i/26))+`"`)
	}
	tags = append(tags, `"`+strings.Repeat("x", 256)+`"`)
	var nics []string
	for i := 0; i < 40; i++ {
		nics = append(nics, `{"mac": "04:01:2a:0f:2a:`+strings.ToLower(string("0123456789abcdef"[i/16]))+string("0123456789abcdef"[i%16])+`", "ipv4": {"ip_address": "999.1.1.1"}, "ipv6": {"ip_address": "not-an-ip", "cidr": 300}}`)
	}
	nics = append(nics, `{"mac": "not-a-mac"}`)
	body := `{"droplet_id": 9, "region": "ams3", "tags": [` + strings.Join(tags, ",") + `], "interfaces": {"public": [` + strings.Join(nics, ",") + `], "weird": [{"mac": "04:01:2a:0f:2a:ff"}]}}`
	srv := metadataServer(t, http.StatusOK, body, nil)
	got := (DigitalOceanMetadata{URL: srv.URL + "/metadata/v1.json"}).Instance("DigitalOcean", "Droplet")
	if got == nil {
		t.Fatal("no cloud instance")
	}
	if len(got.Tags) != maxCloudTags {
		t.Errorf("%d tags, want %d", len(got.Tags), maxCloudTags)
	}
	for _, tag := range got.Tags {
		if len(tag) > 255 {
			t.Errorf("tag of %d bytes kept", len(tag))
		}
	}
	if len(got.Interfaces) != maxCloudInterfaces {
		t.Errorf("%d interfaces, want %d", len(got.Interfaces), maxCloudInterfaces)
	}
	for _, nic := range got.Interfaces {
		if nic.Network != "public" || nic.Ipv4Address != "" || nic.Ipv6Address != "" || nic.Ipv6PrefixLength != 0 {
			t.Errorf("kept a malformed interface value: %+v", nic)
		}
	}
}

// The collector asks its Cloud hook with the DMI vendor and product, and the result rides in the
// system section.
func TestCollectorAsksCloudWithDMI(t *testing.T) {
	root := t.TempDir()
	dmi := filepath.Join(root, "sys", "class", "dmi", "id")
	if err := os.MkdirAll(dmi, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{"sys_vendor": "DigitalOcean\n", "product_name": "Droplet\n"} {
		if err := os.WriteFile(filepath.Join(dmi, name), []byte(value), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var asked []string
	c := Collector{Root: root, Cloud: func(vendor, product string) *CloudInstance {
		asked = append(asked, vendor+"/"+product)
		return &CloudInstance{Provider: "digitalocean", InstanceId: "7", Tags: []string{"b", "a"}}
	}}
	inv, err := c.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(asked, []string{"DigitalOcean/Droplet"}) {
		t.Fatalf("asked %v", asked)
	}
	if inv.System.Cloud == nil || inv.System.Cloud.InstanceId != "7" || !reflect.DeepEqual(inv.System.Cloud.Tags, []string{"a", "b"}) {
		t.Fatalf("system cloud %+v", inv.System.Cloud)
	}
}

// The mirror's encoding of a system section with a cloud instance is the generated message's.
func TestSystemCloudEncodingMatchesGenerated(t *testing.T) {
	inv := &NodeInventory{System: &SystemSection{
		Vendor: "DigitalOcean",
		Cloud: &CloudInstance{
			Provider: "digitalocean", InstanceId: "2756294", Region: "nyc3", Tags: []string{"b", "a"},
			Interfaces: []*CloudInterface{
				{Network: "public", Mac: "04:01:2a:0f:2a:01", Ipv4Address: "104.131.20.105", Ipv6Address: "2604:a880::1", Ipv6PrefixLength: 64},
				{Network: "private", Mac: "04:01:2a:0f:2a:02", Ipv4Address: "10.132.255.113"},
			},
		},
	}}
	sections, err := EncodeSections(inv)
	if err != nil {
		t.Fatal(err)
	}
	want, err := proto.MarshalOptions{Deterministic: true}.Marshal(&agentv1.SystemSection{
		Vendor: "DigitalOcean",
		Cloud: &agentv1.CloudInstance{
			Provider: "digitalocean", InstanceId: "2756294", Region: "nyc3", Tags: []string{"a", "b"},
			Interfaces: []*agentv1.CloudInterface{
				{Network: "private", Mac: "04:01:2a:0f:2a:02", Ipv4Address: "10.132.255.113"},
				{Network: "public", Mac: "04:01:2a:0f:2a:01", Ipv4Address: "104.131.20.105", Ipv6Address: "2604:a880::1", Ipv6PrefixLength: 64},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(sections[0].Content) != string(want) {
		t.Fatalf("mirror %x\ngen    %x", sections[0].Content, want)
	}
}
