// Command bcx-ipmi is a bcx driver plugin (PLAN.md §5.5) for BMCs that speak IPMI rather than
// Redfish: `bcd site` runs it and sends it the bmc.* operations whose driver is "ipmi". It drives
// ipmitool over IPMI-over-LAN (lanplus):
//
//	power.getPower                          chassis power status   → {"power":"on"|"off"}
//	power.setPower {action}                 chassis power on|off|cycle|reset|soft
//	management.setBootDevice {device, persistent}   chassis bootdev pxe|disk|cdrom|bios [options=persistent]
//	inspect.inspect                         fru print 0, chassis power status, mc info, lan print, sdr list
//	                                        ? the Redfish driver's shape, less the host's NICs and UUID
//
// The BMC's address comes as config ({"address": "10.0.0.5[:623]", "cipherSuite": 17|3}) and its
// credentials as secrets (username, password). The password reaches ipmitool through a pipe it
// reads once (-f /dev/fd/3): never its arguments (a process listing) nor its environment (readable
// in /proc by any process of the same user). The cipher suite is explicit (17: HMAC-SHA256,
// AES-128; 3 only for BMCs without it), and ipmitool is run by absolute path. Every argument is
// checked against a fixed set. IPMI has no TLS: a BMC with a key pin is refused, not run unpinned.
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
	"strconv"
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
	if err := bcx.Serve(ctx, &driver{tool: findTool()}, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "bcx-ipmi:", err)
		os.Exit(1)
	}
}

// findTool is ipmitool's absolute path, never looked up in PATH.
func findTool() string {
	for _, p := range []string{"/usr/bin/ipmitool", "/usr/sbin/ipmitool", "/usr/local/bin/ipmitool", "/usr/local/sbin/ipmitool"} {
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() {
			return p
		}
	}
	return "/usr/bin/ipmitool"
}

// driver is the "ipmi" driver.
type driver struct {
	driverv1connect.UnimplementedDriverPluginHandler
	tool string
}

func (d *driver) Describe(context.Context, *connect.Request[driverv1.DescribeRequest]) (*connect.Response[driverv1.DescribeResponse], error) {
	return connect.NewResponse(&driverv1.DescribeResponse{
		Drivers:         []*commonv1.DriverManifest{{Id: "ipmi", Version: version, Kinds: []string{"power", "management", "inspect"}, RunsOn: commonv1.RunsOn_RUNS_ON_SITE, ConfigSchemaJson: `{"type":"object","required":["address"],"properties":{"address":{"type":"string"},"cipherSuite":{"enum":[3,17]}}}`}},
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
		Address       string `json:"address"`
		CipherSuite   int    `json:"cipherSuite"`
		TLSSpkiSha256 string `json:"tlsSpkiSha256"`
	}
	if err := json.Unmarshal([]byte(req.GetConfigJson()), &config); err != nil || config.Address == "" {
		return "", fail("invalid-config", "the ipmi driver needs config.address")
	}
	if config.TLSSpkiSha256 != "" {
		return "", fail("pin-unsupported", "this BMC has a key pin, and IPMI has no TLS to check it against: use a Redfish driver, or remove the pin")
	}
	switch config.CipherSuite {
	case 0:
		config.CipherSuite = 17
	case 3, 17:
	default:
		return "", fail("invalid-config", "cipherSuite %d is not 17 or 3", config.CipherSuite)
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
	if len(secrets["password"]) > 20 {
		return "", fail("credentials-unavailable", "an IPMI 2.0 password has at most 20 bytes")
	}
	var args map[string]any
	if s := req.GetArgsJson(); s != "" && s != "null" {
		if err := json.Unmarshal([]byte(s), &args); err != nil {
			return "", fail("invalid-args", "the arguments are not an object")
		}
	}
	str := func(k string) string { s, _ := args[k].(string); return strings.ToLower(s) }
	argv := []string{"-I", "lanplus", "-H", host, "-U", secrets["username"], "-C", strconv.Itoa(config.CipherSuite), "-f", "/dev/fd/3"}
	if port != "" {
		argv = append(argv, "-p", port)
	}
	ipmi := func(command ...string) (string, error) {
		return d.ipmitool(ctx, append(append([]string{}, argv...), command...), secrets["password"])
	}
	switch req.GetKind() + "." + req.GetOperation() {
	case "power.getPower":
		power, err := powerState(ipmi)
		if err != nil {
			return "", err
		}
		return `{"power":"` + power + `"}`, nil
	case "power.setPower":
		verb, ok := powerVerbs[str("action")]
		if !ok {
			return "", fail("invalid-args", "power action %q is not one of on, off, cycle, reset, soft", str("action"))
		}
		_, err = ipmi("chassis", "power", verb)
	case "management.setBootDevice":
		dev, ok := bootDevs[str("device")]
		if !ok {
			return "", fail("invalid-args", "boot device %q is not one of pxe, disk, cdrom, bios", str("device"))
		}
		command := []string{"chassis", "bootdev", dev}
		if persistent, _ := args["persistent"].(bool); persistent {
			command = append(command, "options=persistent")
		}
		_, err = ipmi(command...)
	case "inspect.inspect":
		return inspect(ipmi)
	default:
		return "", fail("unsupported-operation", "the ipmi driver does not implement %s.%s", req.GetKind(), req.GetOperation())
	}
	if err != nil {
		return "", err
	}
	return `{}`, nil
}

// ipmitool runs one ipmitool command (argv already checked) and returns its output.
func (d *driver) ipmitool(ctx context.Context, argv []string, password string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, d.tool, argv...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	// -f /dev/fd/3: the password through a pipe, drained by the one read ipmitool makes. It fits the
	// pipe's buffer, so it is written before ipmitool starts.
	pr, pw, err := os.Pipe()
	if err != nil {
		return "", err
	}
	_, err = pw.Write([]byte(password))
	pw.Close()
	if err != nil {
		pr.Close()
		return "", err
	}
	cmd.ExtraFiles = []*os.File{pr}
	output, err := cmd.CombinedOutput()
	pr.Close()
	text := strings.TrimSpace(string(output))
	if err != nil {
		if ctx.Err() != nil {
			return "", &failure{code: "unreachable", msg: "ipmitool timed out", retry: true}
		}
		return "", &failure{code: "bmc-error", msg: firstLine(text), retry: true}
	}
	return text, nil
}

func powerState(ipmi func(...string) (string, error)) (string, error) {
	text, err := ipmi("chassis", "power", "status")
	if err != nil {
		return "", err
	}
	switch {
	case strings.Contains(strings.ToLower(text), "is on"):
		return "on", nil
	case strings.Contains(strings.ToLower(text), "is off"):
		return "off", nil
	}
	return "", fail("bmc-error", "unreadable power status: %s", firstLine(text))
}

// fields parses ipmitool's "Name : value" lines (fru print, mc info, lan print); the first of a
// repeated name wins.
func fields(text string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		name, value = strings.TrimSpace(name), strings.TrimSpace(value)
		if _, seen := out[name]; !seen && name != "" {
			out[name] = value
		}
	}
	return out
}

func first(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// maxProblems bounds the sensors an inspection lists by name.
const maxProblems = 32

// inspect is inspect.inspect in the shape the Redfish driver answers (manufacturer, model,
// serialNumber, productUuid, power, macs, ipAddresses), from the builtin FRU, the power state, the
// BMC's own identity and LAN settings and its sensors. IPMI cannot name the host's NICs or its
// SMBIOS UUID reliably: macs and ipAddresses are empty and productUuid is left out. The FRU and the
// power state are required; the rest is best effort.
func inspect(ipmi func(...string) (string, error)) (string, error) {
	fru, err := ipmi("fru", "print", "0")
	if err != nil {
		return "", err
	}
	power, err := powerState(ipmi)
	if err != nil {
		return "", err
	}
	f := fields(fru)
	result := map[string]any{
		"manufacturer": first(f["Product Manufacturer"], f["Board Mfg"]),
		"model":        first(f["Product Name"], f["Board Product"]),
		"serialNumber": first(f["Product Serial"], f["Chassis Serial"], f["Board Serial"]),
		"power":        power,
		"macs":         []string{},
		"ipAddresses":  []string{},
		"board":        map[string]string{"manufacturer": f["Board Mfg"], "product": f["Board Product"], "serial": f["Board Serial"]},
	}
	bmc := map[string]string{}
	if text, err := ipmi("mc", "info"); err == nil {
		m := fields(text)
		bmc["firmware"], bmc["manufacturer"] = m["Firmware Revision"], m["Manufacturer Name"]
	}
	if text, err := ipmi("lan", "print"); err == nil {
		l := fields(text)
		if mac, err := net.ParseMAC(l["MAC Address"]); err == nil {
			bmc["mac"] = mac.String()
		}
		if ip := net.ParseIP(l["IP Address"]); ip != nil && !ip.IsUnspecified() {
			bmc["ipAddress"] = ip.String()
		}
	}
	result["bmc"] = bmc
	if text, err := ipmi("sdr", "list"); err == nil {
		// "Name | reading | status": ok, ns (no reading), or a threshold state (nc, cr, nr) or other.
		sensors, ok := 0, 0
		problems := []map[string]string{}
		for _, line := range strings.Split(text, "\n") {
			parts := strings.Split(line, "|")
			if len(parts) != 3 {
				continue
			}
			sensors++
			switch status := strings.TrimSpace(parts[2]); status {
			case "ok":
				ok++
			case "ns":
			default:
				if len(problems) < maxProblems {
					problems = append(problems, map[string]string{"name": strings.TrimSpace(parts[0]), "reading": strings.TrimSpace(parts[1]), "status": status})
				}
			}
		}
		result["sensors"] = map[string]any{"count": sensors, "ok": ok, "problems": problems}
	}
	raw, err := json.Marshal(result)
	return string(raw), err
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
