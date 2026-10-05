package inventory

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeBMC answers IPMI requests from a table keyed by netfn, cmd and request data.
type fakeBMC struct {
	answers map[string][]byte
	asked   []string
}

func (f *fakeBMC) request(netfn, cmd byte, data []byte) ([]byte, error) {
	key := string(append([]byte{netfn, cmd}, data...))
	f.asked = append(f.asked, key)
	if a, ok := f.answers[key]; ok {
		return a, nil
	}
	return nil, errors.New("no answer")
}

func ipmiKey(netfn, cmd byte, data ...byte) string {
	return string(append([]byte{netfn, cmd}, data...))
}

func supermicroBMC() *fakeBMC {
	return &fakeBMC{answers: map[string][]byte{
		// cc, device id, rev, fw 1 (available), fw .73 BCD, IPMI 2.0, support, IANA 10876 (0x2a7c), product
		ipmiKey(0x06, 0x01): {0x00, 0x20, 0x01, 0x81, 0x73, 0x02, 0xbf, 0x7c, 0x2a, 0x00, 0x09, 0x18},
		// channel 1 is IPMB (medium 1), channel 2 the LAN
		ipmiKey(0x06, 0x42, 1):          {0x00, 0x01, 0x01, 0x01},
		ipmiKey(0x06, 0x42, 2):          {0x00, 0x02, 0x04, 0x01},
		ipmiKey(0x0c, 0x02, 2, 5, 0, 0): {0x00, 0x11, 0x3c, 0xec, 0xef, 0x12, 0x34, 0x56},
		ipmiKey(0x0c, 0x02, 2, 3, 0, 0): {0x00, 0x11, 10, 0, 7, 21},
	}}
}

func TestQueryBMC(t *testing.T) {
	bmc := supermicroBMC()
	s, err := queryBMC(bmc)
	if err != nil {
		t.Fatal(err)
	}
	if s.Vendor != "Supermicro" || s.FirmwareVersion != "1.73" || s.Mac != "3c:ec:ef:12:34:56" || s.Ip != "10.0.7.21" {
		t.Fatalf("bmc = %+v", s)
	}
	// It stopped at the first LAN channel.
	for _, k := range bmc.asked {
		if k == ipmiKey(0x06, 0x42, 3) {
			t.Fatal("asked past the LAN channel")
		}
	}

	// An unknown maker, an unset address and MAC, no LAN channel at all.
	bare := &fakeBMC{answers: map[string][]byte{
		ipmiKey(0x06, 0x01): {0x00, 0x20, 0x01, 0x02, 0x10, 0x02, 0xbf, 0x01, 0x00, 0x01, 0x00, 0x00},
	}}
	if s, err := queryBMC(bare); err != nil || s.Vendor != "IANA 65537" || s.FirmwareVersion != "2.10" || s.Mac != "" || s.Ip != "" {
		t.Fatalf("bare = %+v, %v", s, err)
	}
	zero := supermicroBMC()
	zero.answers[ipmiKey(0x0c, 0x02, 2, 5, 0, 0)] = []byte{0x00, 0x11, 0, 0, 0, 0, 0, 0}
	zero.answers[ipmiKey(0x0c, 0x02, 2, 3, 0, 0)] = []byte{0x00, 0x11, 0, 0, 0, 0}
	if s, _ := queryBMC(zero); s.Mac != "" || s.Ip != "" {
		t.Fatalf("unset = %+v", s)
	}

	// A failing Get Device ID fails the query; a completion code is an error.
	failing := supermicroBMC()
	failing.answers[ipmiKey(0x06, 0x01)] = []byte{0xc1}
	if _, err := queryBMC(failing); err == nil {
		t.Fatal("completion code 0xc1 accepted")
	}
	failing.answers[ipmiKey(0x06, 0x01)] = []byte{0x00, 0x20}
	if _, err := queryBMC(failing); err == nil {
		t.Fatal("short response accepted")
	}
}

func TestCollectorBMC(t *testing.T) {
	root := t.TempDir()
	mk := func(p string) {
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(p)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if inv, _ := (Collector{Root: root}).Collect(); inv.Bmc != nil {
		t.Fatalf("no BMC = %+v", inv.Bmc)
	}
	mk("/sys/class/ipmi/ipmi0")
	if inv, _ := (Collector{Root: root}).Collect(); inv.Bmc == nil || !inv.Bmc.Ipmi || inv.Bmc.Redfish {
		t.Fatalf("ipmi = %+v", inv.Bmc)
	}
	mk("/sys/firmware/dmi/entries/42-0")
	inv, _ := Collector{Root: root, BMC: func() *BmcSection {
		return &BmcSection{Vendor: "Dell", FirmwareVersion: "7.10", Mac: "d0:8e:79:00:00:01", Ip: "10.0.0.5"}
	}}.Collect()
	if b := inv.Bmc; b == nil || !b.Ipmi || !b.Redfish || b.Vendor != "Dell" || b.Mac != "d0:8e:79:00:00:01" || b.Ip != "10.0.0.5" || b.FirmwareVersion != "7.10" {
		t.Fatalf("in-band = %+v", b)
	}

	finding := func(b *BmcSection, privileged bool) *Finding {
		for _, f := range HostFindings(&NodeInventory{Bmc: b}, privileged) {
			if f.Check == "bmc" {
				return &f
			}
		}
		return nil
	}
	if f := finding(inv.Bmc, true); f == nil || f.Status != "ok" || f.Detail != "Dell BMC d0:8e:79:00:00:01 at 10.0.0.5, firmware 7.10" {
		t.Fatalf("finding = %+v", f)
	}
	if f := finding(&BmcSection{Ipmi: true}, true); f == nil || f.Status != "warn" || !strings.Contains(f.Detail, "ipmi_devintf") {
		t.Fatalf("silent BMC as root = %+v", f)
	}
	if f := finding(&BmcSection{Ipmi: true}, false); f == nil || f.Status != "ok" {
		t.Fatalf("BMC seen unprivileged = %+v", f)
	}
	if finding(nil, true) != nil {
		t.Fatal("a finding without a BMC")
	}
}
