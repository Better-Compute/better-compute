// Command bcx-ipmi is a bcx driver plugin (PLAN.md §5.5) for BMCs that speak IPMI rather than
// Redfish: `bcd site` runs it and sends it the bmc.* operations whose driver is "ipmi". It drives
// ipmitool over IPMI-over-LAN (lanplus):
//
//	power.getPower                          chassis power status   → {"power":"on"|"off"}
//	power.setPower {action}                 chassis power on|off|cycle|reset|soft
//	management.setBootDevice {device, persistent}   chassis bootdev pxe|disk|cdrom|bios [options=persistent]
//
// The BMC's address comes as config ({"address": "10.0.0.5[:623]"}) and its credentials as secrets
// (username, password). The password reaches ipmitool through its environment (-E), never its
// arguments, so it never shows in a process listing. Every argument is checked against a fixed set.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	"connectrpc.com/connect"

	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	driverv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1"
	"github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1/driverv1connect"
	"github.com/better-compute/better-compute/daemon/internal/bcx"
)

// version is overridden with -ldflags "-X main.version=<version>".
var version = "0.0.0-dev"

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := bcx.Serve(ctx, &driver{tool: "ipmitool"}, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "bcx-ipmi:", err)
		os.Exit(1)
	}
}

// driver is the "ipmi" driver.
type driver struct {
	driverv1connect.UnimplementedDriverPluginHandler
	tool string
}

func (d *driver) Describe(context.Context, *connect.Request[driverv1.DescribeRequest]) (*connect.Response[driverv1.DescribeResponse], error) {
	return connect.NewResponse(&driverv1.DescribeResponse{
		Drivers:         []*commonv1.DriverManifest{{Id: "ipmi", Version: version, Kinds: []string{"power", "management"}, RunsOn: commonv1.RunsOn_RUNS_ON_SITE, ConfigSchemaJson: `{"type":"object","required":["address"],"properties":{"address":{"type":"string"}}}`}},
		PluginVersion:   version,
		ProtocolVersion: bcx.ProtocolVersion,
	}), nil
}

func (d *driver) Health(context.Context, *connect.Request[driverv1.HealthRequest]) (*connect.Response[driverv1.HealthResponse], error) {
	if _, err := exec.LookPath(d.tool); err != nil {
		return connect.NewResponse(&driverv1.HealthResponse{Status: driverv1.HealthStatus_HEALTH_STATUS_NOT_SERVING, Message: "ipmitool is not installed"}), nil
	}
	return connect.NewResponse(&driverv1.HealthResponse{Status: driverv1.HealthStatus_HEALTH_STATUS_SERVING}), nil
}

// failure is a DriverError answer.
type failure struct {
	code, msg string
	retry     bool
}

func (f *failure) Error() string { return f.code + ": " + f.msg }

func fail(code, format string, args ...any) error {
	return &failure{code: code, msg: fmt.Sprintf(format, args...)}
}

func (d *driver) Invoke(ctx context.Context, req *connect.Request[driverv1.InvokeRequest], out *connect.ServerStream[driverv1.InvokeResponse]) error {
	result, err := d.run(ctx, req.Msg)
	if err != nil {
		var f *failure
		if !errors.As(err, &f) {
			f = &failure{code: "bmc-error", msg: err.Error(), retry: true}
		}
		return out.Send(&driverv1.InvokeResponse{Msg: &driverv1.InvokeResponse_Error{Error: &driverv1.DriverError{Code: f.code, Message: f.msg, Retryable: f.retry}}})
	}
	return out.Send(&driverv1.InvokeResponse{Msg: &driverv1.InvokeResponse_ResultJson{ResultJson: result}})
}

var (
	hostName   = regexp.MustCompile(`^[A-Za-z0-9.-]{1,253}$`)
	userName   = regexp.MustCompile(`^[A-Za-z0-9._@-]{1,64}$`)
	powerVerbs = map[string]string{"on": "on", "off": "off", "cycle": "cycle", "reset": "reset", "soft": "soft", "shutdown": "soft"}
	bootDevs   = map[string]string{"pxe": "pxe", "disk": "disk", "hdd": "disk", "cdrom": "cdrom", "cd": "cdrom", "bios": "bios"}
)

// target parses the BMC address: a host or IP, an optional port, an optional scheme.
func target(address string) (host, port string, err error) {
	a := address
	if strings.Contains(a, "://") {
		u, perr := url.Parse(a)
		if perr != nil || u.Host == "" {
			return "", "", fail("invalid-address", "%q is not a BMC address", address)
		}
		a = u.Host
	}
	host, port = a, ""
	if h, p, splitErr := net.SplitHostPort(a); splitErr == nil {
		host, port = h, p
	}
	if ip := net.ParseIP(host); ip == nil && !hostName.MatchString(host) {
		return "", "", fail("invalid-address", "%q is not a BMC address", address)
	}
	if port != "" && !regexp.MustCompile(`^[0-9]{1,5}$`).MatchString(port) {
		return "", "", fail("invalid-address", "%q is not a port", port)
	}
	return host, port, nil
}

func (d *driver) run(ctx context.Context, req *driverv1.InvokeRequest) (string, error) {
	var config struct {
		Address string `json:"address"`
	}
	if err := json.Unmarshal([]byte(req.GetConfigJson()), &config); err != nil || config.Address == "" {
		return "", fail("invalid-config", "the ipmi driver needs config.address")
	}
	host, port, err := target(config.Address)
	if err != nil {
		return "", err
	}
	secrets := map[string]string{}
	for _, s := range req.GetSecrets() {
		secrets[s.GetField()] = string(s.GetValue())
	}
	if !userName.MatchString(secrets["username"]) || secrets["password"] == "" {
		return "", fail("credentials-unavailable", "the ipmi driver needs a username and a password")
	}
	var args map[string]any
	if s := req.GetArgsJson(); s != "" && s != "null" {
		if err := json.Unmarshal([]byte(s), &args); err != nil {
			return "", fail("invalid-args", "the arguments are not an object")
		}
	}
	str := func(k string) string { s, _ := args[k].(string); return strings.ToLower(s) }
	var command []string
	switch req.GetKind() + "." + req.GetOperation() {
	case "power.getPower":
		command = []string{"chassis", "power", "status"}
	case "power.setPower":
		verb, ok := powerVerbs[str("action")]
		if !ok {
			return "", fail("invalid-args", "power action %q is not one of on, off, cycle, reset, soft", str("action"))
		}
		command = []string{"chassis", "power", verb}
	case "management.setBootDevice":
		dev, ok := bootDevs[str("device")]
		if !ok {
			return "", fail("invalid-args", "boot device %q is not one of pxe, disk, cdrom, bios", str("device"))
		}
		command = []string{"chassis", "bootdev", dev}
		if persistent, _ := args["persistent"].(bool); persistent {
			command = append(command, "options=persistent")
		}
	default:
		return "", fail("unsupported-operation", "the ipmi driver does not implement %s.%s", req.GetKind(), req.GetOperation())
	}
	argv := []string{"-I", "lanplus", "-H", host, "-U", secrets["username"], "-E"}
	if port != "" {
		argv = append(argv, "-p", port)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, d.tool, append(argv, command...)...)
	// -E: the password from IPMI_PASSWORD, never from argv (a process listing would show it).
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "IPMI_PASSWORD=" + secrets["password"]}
	output, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(output))
	if err != nil {
		if ctx.Err() != nil {
			return "", &failure{code: "unreachable", msg: "ipmitool timed out", retry: true}
		}
		return "", &failure{code: "bmc-error", msg: firstLine(text), retry: true}
	}
	if req.GetOperation() == "getPower" {
		switch {
		case strings.Contains(strings.ToLower(text), "is on"):
			return `{"power":"on"}`, nil
		case strings.Contains(strings.ToLower(text), "is off"):
			return `{"power":"off"}`, nil
		}
		return "", fail("bmc-error", "unreadable power status: %s", firstLine(text))
	}
	return `{}`, nil
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
