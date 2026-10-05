package inventory

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// The BMC, seen from the host it manages.
//   - Unprivileged, from sysfs: IPMI where the kernel has an IPMI interface (/sys/class/ipmi, or the
//     SMBIOS IPMI Device Information structure, type 38); Redfish where the firmware publishes a
//     Redfish host interface (SMBIOS type 42) or the BMC's USB network device is attached.
//   - In-band IPMI (Collector.BMC; IPMIBMC on Linux, root: /dev/ipmi0): the vendor and firmware from
//     Get Device ID, and the address and MAC of its first LAN channel from Get LAN Configuration
//     Parameters. The MAC is what ties this node to the BMC an operator enrolls.

func (c Collector) bmc() *BmcSection {
	s := &BmcSection{}
	found := false
	if len(c.list("/sys/class/ipmi")) > 0 || c.exists("/dev/ipmi0") || c.smbiosHas("38-") {
		s.Ipmi, found = true, true
	}
	if c.smbiosHas("42-") || c.bmcUSBNIC() {
		s.Redfish, found = true, true
	}
	if c.BMC != nil {
		if in := c.BMC(); in != nil {
			s.Ip, s.Mac, s.Vendor, s.FirmwareVersion = in.Ip, in.Mac, in.Vendor, in.FirmwareVersion
			s.Ipmi, found = true, true
		}
	}
	if !found {
		return nil
	}
	return s
}

// smbiosHas reports an SMBIOS structure of a type ("38-") in the kernel's entries (the listing is
// world-readable; the contents are not).
func (c Collector) smbiosHas(prefix string) bool {
	for _, name := range c.list("/sys/firmware/dmi/entries") {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// bmcUSBNIC reports the BMC's Redfish host interface network device (the NIC nics() leaves out).
func (c Collector) bmcUSBNIC() bool {
	for _, name := range c.list("/sys/class/net") {
		base := "/sys/class/net/" + name
		driver := c.link(base + "/device/driver")
		if (driver == "cdc_ether" || driver == "rndis_host") && strings.Contains(c.linkPath(base), "/usb") {
			return true
		}
	}
	return false
}

// IPMI over a system interface. ipmiTransport sends one request to the BMC and returns the response
// data, completion code first.
type ipmiTransport interface {
	request(netfn, cmd byte, data []byte) ([]byte, error)
}

const (
	ipmiNetFnApp       = 0x06
	ipmiNetFnTransport = 0x0c
	ipmiGetDeviceID    = 0x01
	ipmiGetChannelInfo = 0x42
	ipmiGetLANConfig   = 0x02
	ipmiMedium8023LAN  = 0x04
	ipmiLANParamIP     = 3
	ipmiLANParamMAC    = 5
)

// ipmiAllowed is the whole command set bcd ever sends a BMC, all reads: Get Device ID, Get Channel
// Info, and Get LAN Configuration Parameters for the IP address (3) and MAC (5). The device layer
// refuses anything else before it reaches the BMC, so no later change can send a Set by accident.
func ipmiAllowed(netfn, cmd byte, data []byte) error {
	switch {
	case netfn == ipmiNetFnApp && cmd == ipmiGetDeviceID && len(data) == 0:
		return nil
	case netfn == ipmiNetFnApp && cmd == ipmiGetChannelInfo && len(data) == 1 && data[0] >= 1 && data[0] <= 11:
		return nil
	case netfn == ipmiNetFnTransport && cmd == ipmiGetLANConfig && len(data) == 4 && data[0] >= 1 && data[0] <= 11 &&
		(data[1] == ipmiLANParamIP || data[1] == ipmiLANParamMAC) && data[2] == 0 && data[3] == 0:
		return nil
	}
	return fmt.Errorf("ipmi: netfn %#02x cmd %#02x is not a command bcd sends", netfn, cmd)
}

// call strips a successful completion code.
func ipmiCall(t ipmiTransport, netfn, cmd byte, data []byte) ([]byte, error) {
	resp, err := t.request(netfn, cmd, data)
	if err != nil {
		return nil, err
	}
	if len(resp) == 0 {
		return nil, errors.New("ipmi: empty response")
	}
	if resp[0] != 0 {
		return nil, fmt.Errorf("ipmi: completion code %#02x", resp[0])
	}
	return resp[1:], nil
}

// unicastMAC renders a BMC's MAC, dropping what no NIC answers to (zero, multicast, broadcast).
func unicastMAC(b []byte) string {
	if len(b) != 6 || b[0]&0x01 != 0 || string(b) == "\x00\x00\x00\x00\x00\x00" {
		return ""
	}
	return net.HardwareAddr(b).String()
}

// hostIPv4 renders a BMC's IPv4 address, dropping what cannot be a host's (unset, loopback,
// multicast, broadcast).
func hostIPv4(b []byte) string {
	if len(b) != 4 {
		return ""
	}
	ip := net.IPv4(b[0], b[1], b[2], b[3])
	if ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() || ip.Equal(net.IPv4bcast) {
		return ""
	}
	return ip.String()
}

// ipmiVendors names IANA enterprise numbers of BMC firmware makers.
var ipmiVendors = map[uint32]string{
	2: "IBM", 11: "HPE", 343: "Intel", 674: "Dell", 5703: "NVIDIA", 7244: "Quanta", 10876: "Supermicro",
	15370: "Gigabyte", 19046: "Lenovo", 20301: "IBM",
}

// queryBMC asks the BMC who it is and where it listens.
func queryBMC(t ipmiTransport) (*BmcSection, error) {
	id, err := ipmiCall(t, ipmiNetFnApp, ipmiGetDeviceID, nil)
	if err != nil {
		return nil, err
	}
	if len(id) < 9 {
		return nil, errors.New("ipmi: short Get Device ID response")
	}
	s := &BmcSection{
		// Major in binary (bit 7 is "device available"), minor in BCD: 1.73 is 0x01 0x73.
		FirmwareVersion: fmt.Sprintf("%d.%02x", id[2]&0x7f, id[3]),
	}
	if id[3]>>4 > 9 || id[3]&0x0f > 9 {
		s.FirmwareVersion = fmt.Sprintf("%d.%d", id[2]&0x7f, id[3]) // not BCD after all
	}
	iana := uint32(id[6]) | uint32(id[7])<<8 | uint32(id[8]&0x0f)<<16
	if s.Vendor = ipmiVendors[iana]; s.Vendor == "" {
		s.Vendor = fmt.Sprintf("IANA %d", iana)
	}
	// The first 802.3 LAN channel (1..11; 0 is IPMB, 14 and 15 are "this channel" and the system).
	for ch := byte(1); ch <= 11; ch++ {
		info, err := ipmiCall(t, ipmiNetFnApp, ipmiGetChannelInfo, []byte{ch})
		if err != nil || len(info) < 2 || info[1]&0x7f != ipmiMedium8023LAN {
			continue
		}
		if mac, err := ipmiCall(t, ipmiNetFnTransport, ipmiGetLANConfig, []byte{ch, ipmiLANParamMAC, 0, 0}); err == nil && len(mac) >= 7 {
			s.Mac = unicastMAC(mac[1:7])
		}
		if ip, err := ipmiCall(t, ipmiNetFnTransport, ipmiGetLANConfig, []byte{ch, ipmiLANParamIP, 0, 0}); err == nil && len(ip) >= 5 {
			s.Ip = hostIPv4(ip[1:5])
		}
		break
	}
	return s, nil
}
