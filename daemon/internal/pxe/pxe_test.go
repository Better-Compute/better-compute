package pxe

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func discover(mac net.HardwareAddr, arch Arch, userClass string) []byte {
	b := make([]byte, 240)
	b[0], b[1], b[2] = opRequest, 1, 6
	copy(b[4:8], []byte{1, 2, 3, 4})
	copy(b[28:], mac)
	copy(b[236:240], magicCookie)
	add := func(code byte, v []byte) { b = append(append(b, code, byte(len(v))), v...) }
	add(optMessageType, []byte{msgDiscover})
	add(optVendorClass, []byte("PXEClient:Arch:00007:UNDI:003016"))
	a := make([]byte, 2)
	binary.BigEndian.PutUint16(a, uint16(arch))
	add(optClientArch, a)
	add(optClientUUID, append([]byte{0}, bytes.Repeat([]byte{0xab}, 16)...))
	if userClass != "" {
		add(optUserClass, []byte(userClass))
	}
	return append(b, optEnd)
}

func TestProxyDHCPAnswersPreparedMachines(t *testing.T) {
	server, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	known, _ := net.ParseMAC("b8:3f:d2:00:00:01")
	var seen []Request
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = ServeProxyDHCP(ctx, server, net.ParseIP("10.20.0.2"), func(r Request) (Answer, bool) {
			seen = append(seen, r)
			if r.MAC.String() != known.String() {
				return Answer{}, false
			}
			if r.IPXE {
				return Answer{Bootfile: "http://10.20.0.2:8080/boot/chain.ipxe"}, true
			}
			return Answer{NextServer: net.ParseIP("10.20.0.2"), Bootfile: "ipxe.efi"}, true
		})
	}()
	client, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ask := func(mac net.HardwareAddr, userClass string) *packet {
		t.Helper()
		if _, err := client.WriteTo(discover(mac, ArchEFIx86_64, userClass), server.LocalAddr()); err != nil {
			t.Fatal(err)
		}
		_ = client.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		buf := make([]byte, 1500)
		n, _, err := client.ReadFrom(buf)
		if err != nil {
			return nil
		}
		p, err := parse(buf[:n])
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	p := ask(known, "")
	if p == nil || p.op != opReply || string(bytes.TrimRight(p.fileField(), "\x00")) != "ipxe.efi" ||
		string(p.options[optVendorClass]) != "PXEClient" || p.options[optMessageType][0] != msgOffer {
		t.Fatalf("PXE firmware answer = %+v", p)
	}
	if uuid := seen[0].UUID; uuid != "abababab-abab-abab-abab-abababababab" || seen[0].Arch != ArchEFIx86_64 {
		t.Fatalf("request = %+v", seen[0])
	}
	if p := ask(known, "iPXE"); p == nil || string(p.options[optBootfileName]) != "http://10.20.0.2:8080/boot/chain.ipxe" {
		t.Fatalf("iPXE answer = %+v", p)
	}
	stranger, _ := net.ParseMAC("b8:3f:d2:00:00:99")
	if p := ask(stranger, ""); p != nil {
		t.Fatal("answered an unprepared machine")
	}
}

// fileField returns the BOOTP file field of a parsed reply (kept for the test).
func (p *packet) fileField() []byte { return p.options[optBootfileName] }

// Transfers are bounded overall and per source: any host on the segment can ask.
func TestTFTPBoundsItsTransfers(t *testing.T) {
	s := &TFTPServer{MaxTransfers: 3, MaxPerSource: 2}
	if !s.admit("10.0.0.1") || !s.admit("10.0.0.1") || s.admit("10.0.0.1") {
		t.Fatal("a third transfer from one source")
	}
	if !s.admit("10.0.0.2") || s.admit("10.0.0.3") {
		t.Fatal("a fourth transfer overall")
	}
	s.done("10.0.0.1")
	if !s.admit("10.0.0.3") {
		t.Fatal("a finished transfer's slot was not given back")
	}
	if len(s.bySource) != 3 || s.active != 3 {
		t.Fatalf("active %d, sources %v", s.active, s.bySource)
	}
}

func TestTFTPServesFilesUnderItsRoot(t *testing.T) {
	root := t.TempDir()
	file := make([]byte, 3000)
	_, _ = rand.Read(file)
	if err := os.WriteFile(filepath.Join(root, "ipxe.efi"), file, 0o644); err != nil {
		t.Fatal(err)
	}
	server, _ := net.ListenPacket("udp4", "127.0.0.1:0")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = (&TFTPServer{Root: root, Timeout: 200 * time.Millisecond}).Serve(ctx, server) }()
	client, _ := net.ListenPacket("udp4", "127.0.0.1:0")
	defer client.Close()
	rrq := func(name string, opts ...string) {
		b := append([]byte{0, tftpRRQ}, append([]byte(name), 0)...)
		b = append(b, append([]byte("octet"), 0)...)
		for _, o := range opts {
			b = append(b, append([]byte(o), 0)...)
		}
		_, _ = client.WriteTo(b, server.LocalAddr())
	}
	read := func() ([]byte, net.Addr) {
		_ = client.SetReadDeadline(time.Now().Add(time.Second))
		buf := make([]byte, 2048)
		n, from, err := client.ReadFrom(buf)
		if err != nil {
			t.Fatal(err)
		}
		return buf[:n], from
	}
	rrq("ipxe.efi", "blksize", "1024", "tsize", "0")
	oack, peer := read()
	if binary.BigEndian.Uint16(oack) != tftpOACK || !bytes.Contains(oack, []byte("tsize\x00"+strconv.Itoa(len(file)))) || !bytes.Contains(oack, []byte("blksize\x001024")) {
		t.Fatalf("oack = %q", oack)
	}
	ack := func(n uint16) {
		b := []byte{0, tftpACK, 0, 0}
		binary.BigEndian.PutUint16(b[2:], n)
		_, _ = client.WriteTo(b, peer)
	}
	ack(0)
	var got []byte
	for n := uint16(1); ; n++ {
		data, _ := read()
		if binary.BigEndian.Uint16(data) != tftpDATA || binary.BigEndian.Uint16(data[2:]) != n {
			t.Fatalf("block %d = %v", n, data[:4])
		}
		got = append(got, data[4:]...)
		ack(n)
		if len(data)-4 < 1024 {
			break
		}
	}
	if !bytes.Equal(got, file) {
		t.Fatalf("got %d bytes", len(got))
	}
	rrq("../../etc/passwd")
	if e, _ := read(); binary.BigEndian.Uint16(e) != tftpERROR {
		t.Fatalf("traversal answered %v", e[:4])
	}
	wrq := append([]byte{0, tftpWRQ}, []byte("x\x00octet\x00")...)
	_, _ = client.WriteTo(wrq, server.LocalAddr())
	if e, _ := read(); binary.BigEndian.Uint16(e) != tftpERROR {
		t.Fatal("a write request was not refused")
	}
}
