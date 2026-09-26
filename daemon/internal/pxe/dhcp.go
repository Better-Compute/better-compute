// Package pxe is the site agent's first boot stage (PLAN.md §3.5): a proxyDHCP server that tells PXE
// firmware and iPXE where to boot from, beside the site's own DHCP server (it never hands out
// addresses), and a read-only TFTP server for the iPXE binaries. It answers only the machines its
// Decide callback accepts: the ones metal prepared, while this agent holds the site's boot lease.
package pxe

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net"
	"strings"
	"time"
)

// DHCP message types and options (RFC 2131, 2132, 4578).
const (
	opRequest = 1
	opReply   = 2

	msgDiscover = 1
	msgOffer    = 2
	msgRequest  = 3
	msgAck      = 5

	optPad          = 0
	optMessageType  = 53
	optServerID     = 54
	optVendorClass  = 60
	optUserClass    = 77
	optClientArch   = 93
	optClientUUID   = 97
	optVendorSpec   = 43
	optBootfileName = 67
	optTFTPServer   = 66
	optEnd          = 255
)

var magicCookie = []byte{99, 130, 83, 99}

// Arch is the client system architecture (option 93, RFC 4578 / IANA).
type Arch uint16

// Client architectures.
const (
	ArchBIOS       Arch = 0
	ArchEFIx86_64  Arch = 7
	ArchEFIx86_64b Arch = 9
	ArchEFIArm64   Arch = 11
	ArchHTTPx86_64 Arch = 16
	ArchHTTPArm64  Arch = 19
)

// HTTPBoot reports a UEFI HTTP boot client (it takes a URL, not a TFTP file).
func (a Arch) HTTPBoot() bool { return a == ArchHTTPx86_64 || a == ArchHTTPArm64 }

// Request is what a PXE client said about itself.
type Request struct {
	MAC  net.HardwareAddr
	Arch Arch
	// IPXE is set when the client is iPXE itself (user class "iPXE"): it gets the chain URL.
	IPXE bool
	// UUID is the client machine UUID (option 97), when sent.
	UUID string
	// Relay is the DHCP relay the request came through (giaddr); nil on the agent's own segment.
	Relay net.IP
}

// Answer is where a client boots from; empty means "do not answer".
type Answer struct {
	// NextServer is the TFTP server address (siaddr), for TFTP boot files.
	NextServer net.IP
	// Bootfile is a TFTP file name, or a URL for UEFI HTTP boot and iPXE.
	Bootfile string
}

// packet is a parsed BOOTP/DHCP message.
type packet struct {
	op      byte
	xid     []byte
	flags   []byte
	ciaddr  net.IP
	giaddr  net.IP
	chaddr  net.HardwareAddr
	options map[byte][]byte
}

func parse(b []byte) (*packet, error) {
	if len(b) < 240 || !bytes.Equal(b[236:240], magicCookie) {
		return nil, errors.New("not a DHCP message")
	}
	hlen := int(b[2])
	if hlen > 16 {
		return nil, errors.New("bad hardware address length")
	}
	p := &packet{
		op:      b[0],
		xid:     append([]byte(nil), b[4:8]...),
		flags:   append([]byte(nil), b[10:12]...),
		ciaddr:  net.IP(append([]byte(nil), b[12:16]...)),
		giaddr:  net.IP(append([]byte(nil), b[24:28]...)),
		chaddr:  net.HardwareAddr(append([]byte(nil), b[28:28+hlen]...)),
		options: map[byte][]byte{},
	}
	opts := b[240:]
	for i := 0; i < len(opts); {
		code := opts[i]
		if code == optEnd {
			break
		}
		if code == optPad {
			i++
			continue
		}
		if i+1 >= len(opts) || i+2+int(opts[i+1]) > len(opts) {
			return nil, errors.New("truncated option")
		}
		n := int(opts[i+1])
		p.options[code] = append(p.options[code], opts[i+2:i+2+n]...)
		i += 2 + n
	}
	return p, nil
}

// request extracts the PXE request, or false for a client that is not PXE/HTTP boot.
func (p *packet) request() (Request, bool) {
	class := string(p.options[optVendorClass])
	if !strings.HasPrefix(class, "PXEClient") && !strings.HasPrefix(class, "HTTPClient") {
		return Request{}, false
	}
	r := Request{MAC: p.chaddr}
	if p.giaddr != nil && !p.giaddr.IsUnspecified() {
		r.Relay = p.giaddr
	}
	if a := p.options[optClientArch]; len(a) >= 2 {
		r.Arch = Arch(binary.BigEndian.Uint16(a))
	}
	r.IPXE = string(p.options[optUserClass]) == "iPXE" || bytes.Contains(p.options[optUserClass], []byte("iPXE"))
	if u := p.options[optClientUUID]; len(u) == 17 && u[0] == 0 {
		g := u[1:]
		r.UUID = strings.ToLower(formatUUID(g))
	}
	return r, true
}

func formatUUID(b []byte) string {
	const hexd = "0123456789abcdef"
	var s strings.Builder
	for i, c := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			s.WriteByte('-')
		}
		s.WriteByte(hexd[c>>4])
		s.WriteByte(hexd[c&0xf])
	}
	return s.String()
}

// reply builds the proxyDHCP answer: no address (yiaddr 0), the boot server and file.
func (p *packet) reply(msgType byte, serverID net.IP, a Answer, httpClient bool) []byte {
	b := make([]byte, 240, 400)
	b[0] = opReply
	b[1] = 1 // ethernet
	b[2] = byte(len(p.chaddr))
	copy(b[4:8], p.xid)
	copy(b[10:12], p.flags)
	copy(b[12:16], p.ciaddr.To4())
	if ns := a.NextServer.To4(); ns != nil {
		copy(b[20:24], ns)
	}
	copy(b[24:28], p.giaddr.To4())
	copy(b[28:44], p.chaddr)
	if len(a.Bootfile) < 128 {
		copy(b[108:236], a.Bootfile)
	}
	copy(b[236:240], magicCookie)
	add := func(code byte, v []byte) {
		b = append(b, code, byte(len(v)))
		b = append(b, v...)
	}
	add(optMessageType, []byte{msgType})
	add(optServerID, serverID.To4())
	if httpClient {
		add(optVendorClass, []byte("HTTPClient"))
	} else {
		add(optVendorClass, []byte("PXEClient"))
		// PXE discovery control: boot the file named here, no boot server discovery or menu.
		add(optVendorSpec, []byte{6, 1, 8, optEnd})
	}
	if ns := a.NextServer.To4(); ns != nil {
		add(optTFTPServer, []byte(ns.String()))
	}
	add(optBootfileName, []byte(a.Bootfile))
	return append(b, optEnd)
}

// Decide chooses a client's answer; false leaves the client to other servers.
type Decide func(Request) (Answer, bool)

// ServeProxyDHCP answers PXE requests on conn (UDP 67 beside the DHCP server, or 4011) until ctx
// is done. serverID is this agent's address on the provisioning network.
func ServeProxyDHCP(ctx context.Context, conn net.PacketConn, serverID net.IP, decide Decide) error {
	go func() {
		<-ctx.Done()
		conn.Close()
	}()
	buf := make([]byte, 1500)
	for {
		n, from, err := conn.ReadFrom(buf)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		p, err := parse(buf[:n])
		if err != nil || p.op != opRequest {
			continue
		}
		var msgType byte
		if t := p.options[optMessageType]; len(t) == 1 {
			msgType = t[0]
		}
		var reply byte
		switch msgType {
		case msgDiscover:
			reply = msgOffer
		case msgRequest:
			reply = msgAck
		default:
			continue
		}
		req, ok := p.request()
		if !ok {
			continue
		}
		answer, ok := decide(req)
		if !ok || answer.Bootfile == "" {
			continue
		}
		out := p.reply(reply, serverID, answer, req.Arch.HTTPBoot())
		to := from
		// Clients without an address yet listen on broadcast.
		if ua, ok := from.(*net.UDPAddr); ok && (ua.IP.IsUnspecified() || p.ciaddr.IsUnspecified()) && p.giaddr.IsUnspecified() {
			to = &net.UDPAddr{IP: net.IPv4bcast, Port: 68}
			if ua.Port != 68 && ua.Port != 0 {
				to = ua // a test or a relay-less client on another port
			}
		}
		_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
		_, _ = conn.WriteTo(out, to)
	}
}
