package agent

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	osexec "os/exec"
	"strconv"
	"sync"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/pki"
)

// Tunnels (PLAN.md §7.6): on OpenTunnel the daemon re-verifies the exec ticket against the JWKS its
// NodeSpec pins and its own journaled jti set, requires the ticket's sid to be the tunnel id, then
// opens a Tunnel stream whose first frame is `opened` and runs the requested program over data,
// resize and closed frames. A refused ticket opens nothing (the gateway's open times out), exactly
// like a node that never answers. FakeDaemon's tunnels.ts is the reference.

// MaxTunnels bounds the tunnels open at once (P12).
const MaxTunnels = 16

// TunnelStream is one Tunnel stream (connect's BidiStreamForClient in production).
type TunnelStream interface {
	Send(*agentv1.TunnelFrame) error
	Receive() (*agentv1.TunnelFrame, error)
	CloseRequest() error
	CloseResponse() error
}

// TunnelDialer opens a Tunnel stream to the gateway.
type TunnelDialer func(ctx context.Context) (TunnelStream, error)

// TunnelIO is how a program answers: output on channel 0 (stdout) or 1 (stderr), and its exit.
type TunnelIO struct {
	Write func(channel uint32, p []byte)
	Exit  func(code int32, reason string)
}

// TunnelProgram runs on the node for one tunnel (a console, a TCP forward).
type TunnelProgram interface {
	Data(p []byte, channel uint32)
	Resize(rows, cols uint32)
	// Hangup: the caller went away; the program should end (and call Exit).
	Hangup()
}

// TunnelProgramFactory starts the program a ticket asks for.
type TunnelProgramFactory func(claims pki.ExecTicketClaims, io TunnelIO) (TunnelProgram, error)

func (a *Agent) onOpenTunnel(ot *agentv1.OpenTunnel) {
	id := ot.GetTunnelId()
	refuse := func(reason string) { a.log.Warn("tunnel refused", "tunnel", id, "reason", reason) }
	if a.o.DialTunnel == nil {
		refuse("tunnels are not enabled")
		return
	}
	a.mu.Lock()
	jwks := a.execJWKS
	now := a.serverNowLocked()
	full := a.tunnels >= MaxTunnels
	a.mu.Unlock()
	if jwks == "" {
		refuse("no pinned JWKS")
		return
	}
	if full {
		refuse("too many tunnels")
		return
	}
	claims, err := pki.VerifyExecTicket(ot.GetTicket(), pki.VerifyExecTicketOptions{
		JWKS:   jwks,
		NodeID: a.NodeID(),
		Now:    now,
		Remember: func(jti string, expiresAt time.Time) (bool, error) {
			a.mu.Lock()
			defer a.mu.Unlock()
			// Kept past any clock skew a Welcome may still bring (MaxServerTimeRegression).
			return a.j.RememberTicket(jti, expiresAt.Add(MaxServerTimeRegression), a.serverNowLocked())
		},
	})
	if err != nil {
		refuse(err.Error())
		return
	}
	// The ticket names the stream it opens; a gateway asking for another id is refused.
	if claims.Sid != id {
		refuse("tunnel id mismatch")
		return
	}
	a.mu.Lock()
	a.tunnels++
	a.mu.Unlock()
	go func() {
		defer func() {
			a.mu.Lock()
			a.tunnels--
			a.mu.Unlock()
		}()
		a.runTunnel(id, claims)
	}()
}

func (a *Agent) runTunnel(id string, claims pki.ExecTicketClaims) {
	ctx, cancel := context.WithCancel(a.ctx)
	defer cancel()
	stream, err := a.o.DialTunnel(ctx)
	if err != nil {
		a.log.Warn("tunnel dial failed", "tunnel", id, "error", err.Error())
		return
	}
	defer func() {
		_ = stream.CloseRequest()
		_ = stream.CloseResponse()
	}()
	var sendMu sync.Mutex
	ended := make(chan struct{})
	var endOnce sync.Once
	send := func(f *agentv1.TunnelFrame) {
		sendMu.Lock()
		defer sendMu.Unlock()
		f.TunnelId = id
		if err := stream.Send(f); err != nil {
			cancel()
		}
	}
	tio := TunnelIO{
		Write: func(channel uint32, p []byte) {
			select {
			case <-ended:
				return
			default:
			}
			send(&agentv1.TunnelFrame{Channel: channel, Body: &agentv1.TunnelFrame_Data{Data: append([]byte(nil), p...)}})
		},
		Exit: func(code int32, reason string) {
			endOnce.Do(func() {
				send(&agentv1.TunnelFrame{Body: &agentv1.TunnelFrame_Closed{Closed: &agentv1.TunnelClosed{ExitCode: code, Reason: reason}}})
				close(ended)
			})
		},
	}
	send(&agentv1.TunnelFrame{Body: &agentv1.TunnelFrame_Opened{Opened: &agentv1.TunnelOpened{}}})
	factory := a.o.TunnelProgram
	if factory == nil {
		factory = func(claims pki.ExecTicketClaims, tio TunnelIO) (TunnelProgram, error) {
			if claims.Inst != "" {
				return a.instanceTunnelProgram(ctx, claims, tio)
			}
			return DefaultTunnelProgram(claims, tio)
		}
	}
	program, err := factory(claims, tio)
	if err != nil {
		a.log.Warn("tunnel program failed", "tunnel", id, "op", claims.Op, "error", err.Error())
		tio.Exit(127, err.Error())
		return
	}
	a.log.Info("tunnel opened", "tunnel", id, "op", claims.Op, "subject", claims.Sub, "jti", claims.Jti)
	go func() {
		for {
			f, err := stream.Receive()
			if err != nil {
				program.Hangup()
				return
			}
			switch b := f.GetBody().(type) {
			case *agentv1.TunnelFrame_Data:
				program.Data(b.Data, f.GetChannel())
			case *agentv1.TunnelFrame_Resize:
				program.Resize(b.Resize.GetRows(), b.Resize.GetCols())
			case *agentv1.TunnelFrame_Closed:
				program.Hangup()
				return
			}
		}
	}()
	select {
	case <-ended:
	case <-ctx.Done():
		program.Hangup()
		select {
		case <-ended:
		case <-time.After(5 * time.Second):
		}
	}
	a.log.Info("tunnel closed", "tunnel", id)
}

// DefaultTunnelProgram runs what a node ticket (no instance) asks for: console → a login shell on a
// PTY; ssh → the node's sshd on loopback; tcp → a loopback port. Instance tickets (exec, and ssh/tcp
// to an instance) wait for the instances runtime.
func DefaultTunnelProgram(claims pki.ExecTicketClaims, tio TunnelIO) (TunnelProgram, error) {
	// A ticket for an instance must reach that instance and nothing of the host: the host's loopback
	// (its sshd, admin ports, other tenants' forwards) is off limits to tenants. Until the instances
	// runtime can resolve an instance's own address, every instance ticket is refused.
	if claims.Inst != "" {
		return nil, fmt.Errorf("%s into instance %s needs the instances runtime", claims.Op, claims.Inst)
	}
	switch claims.Op {
	case "console":
		return startShell(tio)
	case "ssh":
		return dialLoopback(22, tio)
	case "tcp":
		if claims.Port < 1 || claims.Port > 65535 {
			return nil, fmt.Errorf("tcp ticket without a port")
		}
		return dialLoopback(claims.Port, tio)
	case "exec":
		// exec is into an instance; a host shell is `console` (compute:nodes:console).
		return nil, errors.New("an exec ticket names no instance")
	}
	return nil, fmt.Errorf("op %q", claims.Op)
}

// InstanceDialCapability tells the control plane this daemon dials an instance's own address for
// instance ssh/tcp tickets (never the host), so it may issue them ([402c97]'s server-side gate).
const InstanceDialCapability = "tunnel.instance-dial"

// instanceTunnelProgram serves an instance ticket: ssh and tcp are dialed to the instance's own
// address (its running, managed domain, as the runtime reports it); never the host. exec and
// console into a guest need its guest agent and are refused.
func (a *Agent) instanceTunnelProgram(ctx context.Context, claims pki.ExecTicketClaims, tio TunnelIO) (TunnelProgram, error) {
	port := 22
	switch claims.Op {
	case "ssh":
	case "tcp":
		if claims.Port < 1 || claims.Port > 65535 {
			return nil, fmt.Errorf("tcp ticket without a port")
		}
		port = claims.Port
	default:
		return nil, fmt.Errorf("%s into instance %s needs its guest agent", claims.Op, claims.Inst)
	}
	ip, err := a.instanceAddress(ctx, claims.Inst)
	if err != nil {
		return nil, err
	}
	return dialAddress(ip, port, tio)
}

// instanceAddress is the first usable address of a running instance of this host. An address the
// host itself holds, or a loopback, link-local, multicast or unspecified one, is refused: an instance
// ticket never reaches the host. The address is dialled only while the anti-spoofing rules are
// loaded (no other instance can answer for it) and only when no other instance claims it.
func (a *Agent) instanceAddress(ctx context.Context, id string) (net.IP, error) {
	if !a.spoofGuard.Load() {
		return nil, fmt.Errorf("the instance firewall is not loaded on this host; instance %s is not dialled", id)
	}
	claimed := map[string]string{}
	for _, rt := range a.o.Runtimes {
		domains, _ := rt.List(ctx)
		for _, d := range domains {
			for _, cidr := range d.Addresses {
				if ip, _, err := net.ParseCIDR(cidr); err == nil && d.ID != id {
					claimed[ip.String()] = d.ID
				} else if ip := net.ParseIP(cidr); ip != nil && d.ID != id {
					claimed[ip.String()] = d.ID
				}
			}
		}
	}
	own := map[string]bool{}
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, ad := range addrs {
			if ipn, ok := ad.(*net.IPNet); ok {
				own[ipn.IP.String()] = true
			}
		}
	}
	for _, rt := range a.o.Runtimes {
		domains, err := rt.List(ctx)
		if err != nil {
			continue
		}
		for _, d := range domains {
			if d.ID != id {
				continue
			}
			if !d.Managed || d.State != "running" {
				return nil, fmt.Errorf("instance %s is not running on this host", id)
			}
			for _, cidr := range d.Addresses {
				ip, _, err := net.ParseCIDR(cidr)
				if err != nil {
					ip = net.ParseIP(cidr)
				}
				if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsMulticast() || ip.IsUnspecified() || own[ip.String()] {
					continue
				}
				if other, taken := claimed[ip.String()]; taken {
					return nil, fmt.Errorf("instance %s shares its address with %s; not dialled", id, other)
				}
				return ip, nil
			}
			return nil, fmt.Errorf("instance %s has no address the host may dial", id)
		}
	}
	return nil, fmt.Errorf("instance %s is not on this host", id)
}

// ---- tcp ---------------------------------------------------------------------------------------

type tcpProgram struct {
	conn net.Conn
	tio  TunnelIO
}

func dialLoopback(port int, tio TunnelIO) (TunnelProgram, error) {
	return dialAddress(net.IPv4(127, 0, 0, 1), port, tio)
}

// dialTCP opens tunnel connections (tests redirect it).
var dialTCP = func(addr string) (net.Conn, error) { return net.DialTimeout("tcp", addr, 5*time.Second) }

func dialAddress(ip net.IP, port int, tio TunnelIO) (TunnelProgram, error) {
	conn, err := dialTCP(net.JoinHostPort(ip.String(), strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	p := &tcpProgram{conn: conn, tio: tio}
	go func() {
		buf := make([]byte, 32<<10)
		for {
			n, err := conn.Read(buf)
			if n > 0 {
				tio.Write(0, buf[:n])
			}
			if err != nil {
				tio.Exit(0, "closed")
				return
			}
		}
	}()
	return p, nil
}

func (p *tcpProgram) Data(b []byte, _ uint32) { _, _ = p.conn.Write(b) }
func (p *tcpProgram) Resize(uint32, uint32)   {}
func (p *tcpProgram) Hangup() {
	_ = p.conn.Close()
	p.tio.Exit(129, "hangup")
}

// ---- console -----------------------------------------------------------------------------------

type shellProgram struct {
	cmd *osexec.Cmd
	pty *os.File
}

func startShell(tio TunnelIO) (TunnelProgram, error) {
	shell := "/bin/bash"
	if _, err := os.Stat(shell); err != nil {
		shell = "/bin/sh"
	}
	cmd := osexec.Command(shell, "-l")
	cmd.Env = []string{"TERM=xterm-256color", "HOME=/root", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8"}
	cmd.Dir = "/"
	pty, err := startPTY(cmd)
	if err != nil {
		return nil, err
	}
	p := &shellProgram{cmd: cmd, pty: pty}
	go func() {
		buf := make([]byte, 32<<10)
		for {
			n, err := pty.Read(buf)
			if n > 0 {
				tio.Write(0, buf[:n])
			}
			if err != nil {
				break
			}
		}
		err := cmd.Wait()
		_ = pty.Close()
		code := int32(0)
		var exit *osexec.ExitError
		if errors.As(err, &exit) {
			code = int32(exit.ExitCode())
			if code < 0 {
				code = 129
			}
		}
		tio.Exit(code, "exited")
	}()
	return p, nil
}

func (p *shellProgram) Data(b []byte, _ uint32) { _, _ = p.pty.Write(b) }

func (p *shellProgram) Resize(rows, cols uint32) { _ = setWinsize(p.pty, rows, cols) }

func (p *shellProgram) Hangup() {
	if p.cmd.Process != nil {
		// The whole session (its process group) gets SIGHUP, as a closed terminal would send.
		hangupGroup(p.cmd.Process.Pid)
	}
}
