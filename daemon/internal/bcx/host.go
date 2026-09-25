package bcx

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"time"

	"connectrpc.com/connect"

	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	driverv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1"
	"github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1/driverv1connect"
)

// Plugin is a running driver plugin.
type Plugin struct {
	Name    string
	Drivers []*commonv1.DriverManifest
	Version string

	client driverv1connect.DriverPluginClient
	cmd    *exec.Cmd
	dir    string
	http   *http.Client
	once   sync.Once
}

// StartOptions configure Start.
type StartOptions struct {
	// Sha256 pins the plugin binary (hex); a binary with another digest is not run.
	Sha256 string
	// Args and Env are passed to the plugin (Env on top of a minimal environment).
	Args []string
	Env  []string
	// HandshakeTimeout bounds the wait for the handshake line (default 10 s).
	HandshakeTimeout time.Duration
	// Stderr receives the plugin's own logs (default: discarded).
	Stderr io.Writer

	// The sandbox (PLAN.md §5.5; Linux). Shim, when set, is an executable that runs the plugin with
	// no new privileges and a seccomp filter (bcd itself: its ShimCommand runs RunShim).
	Shim string
	// Credential runs the plugin as another user (bcd runs as root; its plugins should not).
	Credential *Credential
	// CgroupDir is a delegated cgroup v2 directory; each plugin runs in CgroupDir/bcx-<name>, limited
	// by MemoryMax bytes and PidsMax tasks (0: no limit).
	CgroupDir string
	MemoryMax int64
	PidsMax   int
}

// Credential is a user and group a plugin runs as.
type Credential struct {
	UID, GID uint32
}

// Start verifies and runs a plugin, completes the handshake and asks it what it serves.
func Start(ctx context.Context, name, path string, o StartOptions) (*Plugin, error) {
	if o.Sha256 == "" {
		return nil, fmt.Errorf("bcx: plugin %s has no sha256 pin", name)
	}
	// The binary is hashed through the file it is then executed from (Linux: /proc/self/fd), so what
	// runs is what was hashed even if the path is replaced in between.
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return nil, err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != o.Sha256 {
		return nil, fmt.Errorf("bcx: plugin %s has sha256 %s, not its pin %s", name, got, o.Sha256)
	}
	host, err := newIdentity("bcd")
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "bcx-"+name+"-")
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(path, o.Args...)
	cmd.Env = append([]string{
		"PATH=" + os.Getenv("PATH"),
		MagicCookieKey + "=" + MagicCookieValue,
		SocketDirEnv + "=" + dir,
		ClientCertEnv + "=" + host.pem(),
	}, o.Env...)
	cmd.Stderr = o.Stderr
	release, err := prepare(cmd, f, path, name, o, dir)
	if err != nil {
		os.RemoveAll(dir)
		return nil, fmt.Errorf("bcx: plugin %s: %w", name, err)
	}
	defer release()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	p := &Plugin{Name: name, cmd: cmd, dir: dir}
	timeout := o.HandshakeTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	lines := make(chan string, 1)
	go func() {
		r := bufio.NewReader(stdout)
		line, _ := r.ReadString('\n')
		lines <- line
		_, _ = io.Copy(io.Discard, r) // keep the pipe drained
	}()
	var line string
	select {
	case line = <-lines:
	case <-time.After(timeout):
		p.Close()
		return nil, fmt.Errorf("bcx: plugin %s sent no handshake within %s", name, timeout)
	case <-ctx.Done():
		p.Close()
		return nil, ctx.Err()
	}
	hs, err := ParseHandshake(line)
	if err != nil {
		p.Close()
		return nil, err
	}
	tlsConfig := &tls.Config{
		MinVersion:            tls.VersionTLS12,
		Certificates:          []tls.Certificate{host.tls},
		ServerName:            "localhost",
		InsecureSkipVerify:    true, //nolint:gosec // replaced by the exact certificate pin
		VerifyPeerCertificate: pinned(hs.Certificate),
		NextProtos:            []string{"h2"},
	}
	transport := &http.Transport{
		TLSClientConfig: tlsConfig,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, hs.Network, hs.Address)
		},
		ForceAttemptHTTP2: true,
		Protocols:         new(http.Protocols),
	}
	transport.Protocols.SetHTTP2(true)
	p.http = &http.Client{Transport: transport}
	p.client = driverv1connect.NewDriverPluginClient(p.http, "https://localhost", connect.WithGRPC())
	resp, err := p.client.Describe(ctx, connect.NewRequest(&driverv1.DescribeRequest{}))
	if err != nil {
		p.Close()
		return nil, fmt.Errorf("bcx: describe %s: %w", name, err)
	}
	if v := resp.Msg.GetProtocolVersion(); v != 0 && v != ProtocolVersion {
		p.Close()
		return nil, fmt.Errorf("bcx: plugin %s speaks protocol %d", name, v)
	}
	p.Drivers, p.Version = resp.Msg.GetDrivers(), resp.Msg.GetPluginVersion()
	return p, nil
}

// Close stops the plugin.
func (p *Plugin) Close() {
	p.once.Do(func() {
		if p.http != nil {
			p.http.CloseIdleConnections()
		}
		if p.cmd != nil && p.cmd.Process != nil {
			killGroup(p.cmd)
			_ = p.cmd.Wait()
		}
		_ = os.RemoveAll(p.dir)
	})
}

// Error is a driver's own failure (DriverError).
type Error struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Invoke runs one operation and returns its JSON result; progress goes to onProgress (may be nil).
func (p *Plugin) Invoke(ctx context.Context, req *driverv1.InvokeRequest, onProgress func(*driverv1.Progress)) (string, error) {
	stream, err := p.client.Invoke(ctx, connect.NewRequest(req))
	if err != nil {
		return "", err
	}
	defer stream.Close()
	for stream.Receive() {
		switch m := stream.Msg().GetMsg().(type) {
		case *driverv1.InvokeResponse_Progress:
			if onProgress != nil {
				onProgress(m.Progress)
			}
		case *driverv1.InvokeResponse_ResultJson:
			return m.ResultJson, nil
		case *driverv1.InvokeResponse_Error:
			return "", &Error{Code: m.Error.GetCode(), Message: m.Error.GetMessage(), Retryable: m.Error.GetRetryable()}
		}
	}
	if err := stream.Err(); err != nil {
		return "", err
	}
	return "", errors.New("bcx: the operation ended without a result")
}

// Health asks the plugin whether it serves.
func (p *Plugin) Health(ctx context.Context) error {
	resp, err := p.client.Health(ctx, connect.NewRequest(&driverv1.HealthRequest{}))
	if err != nil {
		return err
	}
	if resp.Msg.GetStatus() != driverv1.HealthStatus_HEALTH_STATUS_SERVING {
		return fmt.Errorf("bcx: plugin %s is not serving: %s", p.Name, resp.Msg.GetMessage())
	}
	return nil
}
