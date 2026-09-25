package bcx

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	driverv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1"
	"github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1/driverv1connect"
)

// echoPlugin is a plugin serving one driver, "echo", implementing the power kind.
type echoPlugin struct {
	driverv1connect.UnimplementedDriverPluginHandler
}

func (echoPlugin) Describe(context.Context, *connect.Request[driverv1.DescribeRequest]) (*connect.Response[driverv1.DescribeResponse], error) {
	return connect.NewResponse(&driverv1.DescribeResponse{
		Drivers:         []*commonv1.DriverManifest{{Id: "echo", Version: "1.0.0", Kinds: []string{"power"}}},
		PluginVersion:   "1.0.0",
		ProtocolVersion: ProtocolVersion,
	}), nil
}

func (echoPlugin) Invoke(_ context.Context, req *connect.Request[driverv1.InvokeRequest], out *connect.ServerStream[driverv1.InvokeResponse]) error {
	_ = out.Send(&driverv1.InvokeResponse{Msg: &driverv1.InvokeResponse_Progress{Progress: &driverv1.Progress{Percent: 50, Phase: "working"}}})
	switch req.Msg.GetOperation() {
	case "fail":
		return out.Send(&driverv1.InvokeResponse{Msg: &driverv1.InvokeResponse_Error{Error: &driverv1.DriverError{Code: "unreachable", Message: "no BMC"}}})
	case "probe":
		// What a denied system call answers in this process (the sandbox test).
		return out.Send(&driverv1.InvokeResponse{Msg: &driverv1.InvokeResponse_ResultJson{ResultJson: `"` + probeDenied() + `"`}})
	}
	secret := ""
	for _, s := range req.Msg.GetSecrets() {
		secret += s.GetField() + "=" + string(s.GetValue())
	}
	return out.Send(&driverv1.InvokeResponse{Msg: &driverv1.InvokeResponse_ResultJson{
		ResultJson: `{"op":"` + req.Msg.GetOperation() + `","args":` + req.Msg.GetArgsJson() + `,"secret":"` + secret + `"}`}})
}

func (echoPlugin) Health(context.Context, *connect.Request[driverv1.HealthRequest]) (*connect.Response[driverv1.HealthResponse], error) {
	return connect.NewResponse(&driverv1.HealthResponse{Status: driverv1.HealthStatus_HEALTH_STATUS_SERVING}), nil
}

// TestMain turns this test binary into the echo plugin when the host runs it as one.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == ShimCommand {
		// The host ran this binary as the sandbox shim.
		err := RunShim(os.Args[2:])
		os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}
	if os.Getenv("BCX_TEST_PLUGIN") == "1" {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := Serve(ctx, echoPlugin{}, os.Stdout); err != nil {
			os.Stderr.WriteString(err.Error() + "\n")
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func selfPin(t *testing.T) (string, string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	f, _ := os.Open(exe)
	defer f.Close()
	h := sha256.New()
	_, _ = io.Copy(h, f)
	return exe, hex.EncodeToString(h.Sum(nil))
}

func TestHostRunsAPinnedPlugin(t *testing.T) {
	exe, pin := selfPin(t)
	ctx := context.Background()
	p, err := Start(ctx, "echo", exe, StartOptions{Sha256: pin, Env: []string{"BCX_TEST_PLUGIN=1"}, Stderr: os.Stderr})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if len(p.Drivers) != 1 || p.Drivers[0].GetId() != "echo" || p.Version != "1.0.0" {
		t.Fatalf("describe = %v %s", p.Drivers, p.Version)
	}
	if err := p.Health(ctx); err != nil {
		t.Fatal(err)
	}
	var progress []uint32
	result, err := p.Invoke(ctx, &driverv1.InvokeRequest{DriverId: "echo", Kind: "power", Operation: "setPower", ArgsJson: `{"action":"on"}`,
		Secrets: []*driverv1.SecretValue{{Field: "password", Value: []byte("pw")}}}, func(pr *driverv1.Progress) { progress = append(progress, pr.GetPercent()) })
	if err != nil || result != `{"op":"setPower","args":{"action":"on"},"secret":"password=pw"}` || len(progress) != 1 {
		t.Fatalf("invoke = %q, %v, %v", result, err, progress)
	}
	var de *Error
	if _, err := p.Invoke(ctx, &driverv1.InvokeRequest{DriverId: "echo", Kind: "power", Operation: "fail"}, nil); !errors.As(err, &de) || de.Code != "unreachable" {
		t.Fatalf("driver error = %v", err)
	}
}

func TestHostRefusesAnUnpinnedBinary(t *testing.T) {
	exe, _ := selfPin(t)
	_, err := Start(context.Background(), "echo", exe, StartOptions{Sha256: strings.Repeat("0", 64), Env: []string{"BCX_TEST_PLUGIN=1"}})
	if err == nil || !strings.Contains(err.Error(), "not its pin") {
		t.Fatalf("unpinned = %v", err)
	}
	if _, err := Start(context.Background(), "echo", exe, StartOptions{Env: []string{"BCX_TEST_PLUGIN=1"}}); err == nil {
		t.Fatal("a plugin without a pin was started")
	}
}

func TestHandshakeRoundTrip(t *testing.T) {
	id, _ := newIdentity("x")
	h := Handshake{Network: "unix", Address: "/tmp/a|b/plugin.sock", Certificate: id.der}
	got, err := ParseHandshake(h.Format() + "\n")
	if err != nil || got.Address != h.Address || string(got.Certificate) != string(id.der) {
		t.Fatalf("round trip = %+v, %v", got, err)
	}
	for _, bad := range []string{"bcx|2|unix|/s|grpc|AA", "bcx|1|udp|/s|grpc|AA", "bcx|1|unix|/s|http|AA", "nope"} {
		if _, err := ParseHandshake(bad); err == nil {
			t.Errorf("parsed %q", bad)
		}
	}
}
