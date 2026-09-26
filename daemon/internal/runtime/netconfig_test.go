package runtime

import (
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

func TestNetworkConfigForLeasedNICs(t *testing.T) {
	if cfg, err := networkConfig([]*agentv1.InstanceNic{{Mac: "52:54:00:00:00:01"}}); cfg != nil || err != nil {
		t.Fatalf("a DHCP-only instance keeps the image's fallback: %q %v", cfg, err)
	}
	cfg, err := networkConfig([]*agentv1.InstanceNic{
		{Mac: "52:54:00:00:00:01", Addresses: []string{"203.0.113.7/24", "2001:db8::7/64"}, Gateway: "203.0.113.1", Nameservers: []string{"1.1.1.1", "2606:4700:4700::1111"}},
		{Mac: "52:54:00:00:00:02", Addresses: []string{"10.1.0.7/16"}}, // private: no default route
		{Mac: "52:54:00:00:00:03"},
		{Mac: "52:54:00:00:00:04"},
		{Mac: "52:54:00:00:00:05", Addresses: []string{"2001:db8:1::5/64"}, Gateway: "2001:db8:1::1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `version: 2
ethernets:
  nic0:
    match:
      macaddress: "52:54:00:00:00:01"
    dhcp4: false
    dhcp6: false
    addresses:
      - "203.0.113.7/24"
      - "2001:db8::7/64"
    routes:
      - to: "0.0.0.0/0"
        via: "203.0.113.1"
    nameservers:
      addresses:
        - "1.1.1.1"
        - "2606:4700:4700::1111"
  nic1:
    match:
      macaddress: "52:54:00:00:00:02"
    dhcp4: false
    dhcp6: false
    addresses:
      - "10.1.0.7/16"
  nic2:
    match:
      macaddress: "52:54:00:00:00:03"
    dhcp4: true
  nic3:
    match:
      macaddress: "52:54:00:00:00:04"
    dhcp4: true
  nic4:
    match:
      macaddress: "52:54:00:00:00:05"
    dhcp4: false
    dhcp6: false
    addresses:
      - "2001:db8:1::5/64"
    routes:
      - to: "::/0"
        via: "2001:db8:1::1"
`
	if string(cfg) != want {
		t.Fatalf("network-config:\n%s", cfg)
	}
	for name, nic := range map[string]*agentv1.InstanceNic{
		"bare address":   {Mac: "52:54:00:00:00:01", Addresses: []string{"10.0.0.7"}},
		"bad gateway":    {Mac: "52:54:00:00:00:01", Addresses: []string{"10.0.0.7/24"}, Gateway: "10.0.0.1\nruncmd: [x]"},
		"bad nameserver": {Mac: "52:54:00:00:00:01", Nameservers: []string{"dns.example"}},
		"no MAC":         {Addresses: []string{"10.0.0.7/24"}},
	} {
		if _, err := networkConfig([]*agentv1.InstanceNic{nic}); err == nil || !strings.Contains(err.Error(), "nic 0") {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A DHCP NIC without a MAC beside a static one would lose DHCP (cloud-init's fallback is off).
	if _, err := networkConfig([]*agentv1.InstanceNic{{Mac: "52:54:00:00:00:01", Addresses: []string{"10.0.0.7/24"}}, {}}); err == nil ||
		!strings.Contains(err.Error(), "nic 1 has no MAC") {
		t.Errorf("a MAC-less DHCP NIC beside a static one: %v", err)
	}
}
