package pxe

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// TFTP (RFC 1350, options RFC 2347/2348/2349): read requests only, octet mode, blksize and tsize
// negotiation, one ephemeral socket per transfer, retransmission on timeout. It serves the iPXE
// binaries (undionly.kpxe, ipxe.efi) from Root and nothing outside it.

const (
	tftpRRQ   = 1
	tftpWRQ   = 2
	tftpDATA  = 3
	tftpACK   = 4
	tftpERROR = 5
	tftpOACK  = 6

	defaultBlock = 512
	maxBlock     = 1468 // fits a 1500-byte MTU
	retries      = 5
)

// TFTPServer serves files under Root.
type TFTPServer struct {
	Root    string
	Timeout time.Duration
	// MaxTransfers bounds concurrent transfers (default 64) and MaxPerSource those of one address
	// (default 4): each takes a goroutine and a socket, and any host on the segment can ask. A
	// request beyond either is dropped (answering it would take a socket too).
	MaxTransfers, MaxPerSource int

	mu       sync.Mutex
	active   int
	bySource map[string]int
}

// admit counts a transfer from source in, or reports that the server is at its bounds.
func (s *TFTPServer) admit(source string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	total, per := s.MaxTransfers, s.MaxPerSource
	if total <= 0 {
		total = 64
	}
	if per <= 0 {
		per = 4
	}
	if s.bySource == nil {
		s.bySource = map[string]int{}
	}
	if s.active >= total || s.bySource[source] >= per {
		return false
	}
	s.active++
	s.bySource[source]++
	return true
}

func (s *TFTPServer) done(source string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active--
	if s.bySource[source]--; s.bySource[source] <= 0 {
		delete(s.bySource, source)
	}
}

// Serve answers read requests on conn until ctx is done.
func (s *TFTPServer) Serve(ctx context.Context, conn net.PacketConn) error {
	go func() {
		<-ctx.Done()
		conn.Close()
	}()
	buf := make([]byte, 2048)
	for {
		n, from, err := conn.ReadFrom(buf)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		source := from.String()
		if ua, ok := from.(*net.UDPAddr); ok {
			source = ua.IP.String()
		}
		if !s.admit(source) {
			continue
		}
		req := append([]byte(nil), buf[:n]...)
		go func() {
			defer s.done(source)
			s.transfer(ctx, req, from)
		}()
	}
}

func tftpError(code uint16, msg string) []byte {
	b := []byte{0, tftpERROR, 0, 0}
	binary.BigEndian.PutUint16(b[2:], code)
	return append(append(b, msg...), 0)
}

// open resolves a requested name under Root; ".." and absolute escapes are refused.
func (s *TFTPServer) open(name string) (*os.File, int64, error) {
	clean := filepath.Clean("/" + strings.ReplaceAll(name, "\\", "/"))
	path := filepath.Join(s.Root, filepath.FromSlash(clean))
	root, err := filepath.Abs(s.Root)
	if err != nil {
		return nil, 0, err
	}
	abs, err := filepath.Abs(path)
	if err != nil || (abs != root && !strings.HasPrefix(abs, root+string(filepath.Separator))) {
		return nil, 0, os.ErrNotExist
	}
	f, err := os.Open(abs)
	if err != nil {
		return nil, 0, err
	}
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		f.Close()
		return nil, 0, os.ErrNotExist
	}
	return f, st.Size(), nil
}

func (s *TFTPServer) transfer(ctx context.Context, req []byte, to net.Addr) {
	conn, err := net.ListenPacket("udp", ":0")
	if err != nil {
		return
	}
	defer conn.Close()
	send := func(b []byte) { _, _ = conn.WriteTo(b, to) }
	if len(req) < 4 || binary.BigEndian.Uint16(req) != tftpRRQ {
		send(tftpError(4, "read requests only"))
		return
	}
	fields := bytes.Split(req[2:], []byte{0})
	if len(fields) < 2 || !strings.EqualFold(string(fields[1]), "octet") {
		send(tftpError(0, "octet mode only"))
		return
	}
	f, size, err := s.open(string(fields[0]))
	if err != nil {
		send(tftpError(1, "file not found"))
		return
	}
	defer f.Close()
	block := defaultBlock
	oack := []byte{0, tftpOACK}
	for i := 2; i+1 < len(fields); i += 2 {
		opt, val := strings.ToLower(string(fields[i])), string(fields[i+1])
		switch opt {
		case "blksize":
			if n, err := strconv.Atoi(val); err == nil && n >= 8 {
				block = min(n, maxBlock)
				oack = append(append(append(append(oack, "blksize"...), 0), strconv.Itoa(block)...), 0)
			}
		case "tsize":
			oack = append(append(append(append(oack, "tsize"...), 0), strconv.FormatInt(size, 10)...), 0)
		}
	}
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	ackBuf := make([]byte, 516)
	// waitAck resends pkt until the peer acknowledges block n.
	waitAck := func(pkt []byte, n uint16) bool {
		for try := 0; try < retries; try++ {
			if ctx.Err() != nil {
				return false
			}
			send(pkt)
			_ = conn.SetReadDeadline(time.Now().Add(timeout))
			for {
				m, from, err := conn.ReadFrom(ackBuf)
				if err != nil {
					break // timeout: resend
				}
				if from.String() != to.String() || m < 4 {
					continue
				}
				switch binary.BigEndian.Uint16(ackBuf) {
				case tftpACK:
					if binary.BigEndian.Uint16(ackBuf[2:]) == n {
						return true
					}
				case tftpERROR:
					return false
				}
			}
		}
		return false
	}
	if len(oack) > 2 && !waitAck(oack, 0) {
		return
	}
	data := make([]byte, block)
	for n := uint16(1); ; n++ {
		m, err := io.ReadFull(f, data)
		if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
			send(tftpError(0, "read error"))
			return
		}
		pkt := make([]byte, 4+m)
		pkt[1] = tftpDATA
		binary.BigEndian.PutUint16(pkt[2:], n)
		copy(pkt[4:], data[:m])
		if !waitAck(pkt, n) {
			return
		}
		if m < block {
			return
		}
	}
}
