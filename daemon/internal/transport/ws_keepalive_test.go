package transport

import (
	"bufio"
	"context"
	"encoding/binary"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"google.golang.org/protobuf/proto"
)

// clientFrame reads one (masked) client frame: its opcode and payload.
func clientFrame(r *bufio.Reader) (opcode byte, payload []byte, err error) {
	var h [2]byte
	if _, err = io.ReadFull(r, h[:]); err != nil {
		return
	}
	opcode = h[0] & 0x0f
	n := int(h[1] & 0x7f)
	switch n {
	case 126:
		var b [2]byte
		if _, err = io.ReadFull(r, b[:]); err != nil {
			return
		}
		n = int(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err = io.ReadFull(r, b[:]); err != nil {
			return
		}
		n = int(binary.BigEndian.Uint64(b[:]))
	}
	var mask [4]byte
	if _, err = io.ReadFull(r, mask[:]); err != nil {
		return
	}
	payload = make([]byte, n)
	if _, err = io.ReadFull(r, payload); err != nil {
		return
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return opcode, payload, nil
}

// The session pings the gateway and expects to hear from it: a connection that goes silent without
// closing (a black hole behind a proxy) ends Receive, and one that only answers pings stays up.
func TestWSSessionPingsAndNoticesADeadConnection(t *testing.T) {
	const interval, idle = 50 * time.Millisecond, 400 * time.Millisecond

	// A gateway that upgrades and then says nothing more, without closing.
	g, srv := newWSGateway(t)
	var pings atomic.Int32
	hold := make(chan struct{})
	g.script = func(brw *bufio.ReadWriter) {
		for {
			opcode, _, err := clientFrame(brw.Reader)
			if err != nil {
				break
			}
			if opcode == 0x9 {
				pings.Add(1) // never answered
			}
		}
		<-hold
	}
	o := wsOptions(t, g, srv)
	o.PingInterval, o.IdleTimeout = interval, idle
	s, err := DialSession(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	<-g.proofs
	received := make(chan error, 1)
	started := time.Now()
	go func() {
		_, err := s.Receive()
		received <- err
	}()
	select {
	case err := <-received:
		if err == nil || !strings.Contains(err.Error(), "nothing from the gateway") {
			t.Fatalf("Receive on a silent connection = %v", err)
		}
		if took := time.Since(started); took < idle/2 || took > 10*idle {
			t.Fatalf("the dead connection was noticed after %s (idle timeout %s)", took, idle)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Receive still waits on a connection that has been silent for 5 s")
	}
	if pings.Load() == 0 {
		t.Fatal("the session sent no ping")
	}
	s.Close()
	close(hold)

	// A gateway that answers pings and sends its Welcome only after several idle timeouts: alive.
	g2, srv2 := newWSGateway(t)
	g2.script = func(brw *bufio.ReadWriter) {
		deadline := time.Now().Add(3 * idle)
		for time.Now().Before(deadline) {
			opcode, payload, err := clientFrame(brw.Reader)
			if err != nil {
				return
			}
			if opcode == 0x9 {
				writeServerFrame(brw.Writer, 0xA, payload)
				_ = brw.Flush()
			}
		}
		body, _ := proto.Marshal(&agentv1.ServerFrame{Msg: &agentv1.ServerFrame_Welcome{Welcome: &agentv1.Welcome{SessionId: "s-late"}}})
		writeServerFrame(brw.Writer, 0x2, append(binary.BigEndian.AppendUint32([]byte{0}, uint32(len(body))), body...))
		_ = brw.Flush()
		_, _, _ = clientFrame(brw.Reader) // until the client goes
	}
	o2 := wsOptions(t, g2, srv2)
	o2.PingInterval, o2.IdleTimeout = interval, idle
	s2, err := DialSession(context.Background(), o2)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	<-g2.proofs
	f, err := s2.Receive()
	if err != nil || f.GetWelcome().GetSessionId() != "s-late" {
		t.Fatalf("Receive on a quiet but answering connection = %v, %v", f, err)
	}
}
