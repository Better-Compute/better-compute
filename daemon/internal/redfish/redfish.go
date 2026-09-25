// Package redfish is the site agent's Redfish driver (PLAN.md §5.4, metal's power, management,
// virtual-media, inspect and firmware kinds): the operations metal sends as bmc.* commands, against
// the machine's BMC over HTTPS with basic auth. A BMC enrolled with tls_spki_sha256 is pinned to it
// (BMCs mostly present self-signed certificates); one without a pin is verified against the system
// roots.
package redfish

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Error is an operation failure with a stable code (BmcOperationResult.error_code).
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func fail(code, format string, args ...any) error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Client talks to one BMC.
type Client struct {
	base     string
	username string
	password string
	http     *http.Client
	system   string
	manager  string
}

// New builds a client for address, pinned to pin (the SHA-256 of the BMC certificate's SPKI) when
// set. The address is a host ("10.20.0.5", "bmc.example:8443"), an https:// or redfish:// URL, or
// such a URL naming one system of a multi-system service (a chassis manager, sushy-tools in front
// of libvirt): "https://192.168.122.1:8000/redfish/v1/Systems/<uuid>". Without a system path the
// service's first system is used.
func New(address, username, password string, pin []byte) (*Client, error) {
	if !strings.Contains(address, "://") {
		address = "https://" + address
	}
	u, err := url.Parse(address)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fail("invalid-address", "BMC address %q", address)
	}
	if u.Scheme != "https" && u.Scheme != "redfish" {
		return nil, fail("invalid-address", "BMCs are reached over https only")
	}
	system := strings.TrimRight(u.Path, "/")
	switch {
	case system == "" || system == "/redfish/v1":
		system = ""
	case strings.HasPrefix(system, "/redfish/v1/Systems/") && !strings.Contains(strings.TrimPrefix(system, "/redfish/v1/Systems/"), "/") && !strings.Contains(system, ".."):
	default:
		return nil, fail("invalid-address", "a BMC address path must name a system (/redfish/v1/Systems/<id>), got %q", u.Path)
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if len(pin) > 0 {
		tlsConfig.InsecureSkipVerify = true //nolint:gosec // replaced by the SPKI pin
		tlsConfig.VerifyConnection = func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("the BMC sent no certificate")
			}
			return checkPin(cs.PeerCertificates[0], pin)
		}
	}
	return &Client{
		base:     "https://" + u.Host,
		system:   system,
		username: username,
		password: password,
		http: &http.Client{
			Timeout:   60 * time.Second,
			Transport: &http.Transport{TLSClientConfig: tlsConfig, Proxy: nil},
			// Redfish services answer on their own address; a redirect elsewhere is refused.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

func checkPin(cert *x509.Certificate, pin []byte) error {
	sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	if !bytes.Equal(sum[:], pin) {
		return errors.New("the BMC certificate does not match its pinned SPKI")
	}
	return nil
}

// call makes one request and decodes a JSON answer into out (when non-nil).
func (c *Client) call(ctx context.Context, method, path string, body any, out any) error {
	// Paths come from the BMC's own answers (@odata.id): only absolute paths on this BMC, never
	// another host ("@evil.example/..." would turn the base into userinfo) or a scheme.
	if !strings.HasPrefix(path, "/redfish/v1") || strings.ContainsAny(path, "@?#\\ \t\r\n") || strings.Contains(path, "..") {
		return fail("bmc-error", "the BMC answered with a resource path outside /redfish/v1: %q", path)
	}
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, r)
	if err != nil {
		return err
	}
	req.SetBasicAuth(c.username, c.password)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fail("unreachable", "%v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return fail("auth-failed", "%s %s: %s", method, path, resp.Status)
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed:
		return fail("unsupported", "%s %s: %s", method, path, resp.Status)
	case resp.StatusCode >= 300:
		return fail("bmc-error", "%s %s: %s %s", method, path, resp.Status, extendedMessage(data))
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fail("bmc-error", "%s %s: %v", method, path, err)
		}
	}
	return nil
}

// extendedMessage pulls the first message out of a Redfish error body.
func extendedMessage(data []byte) string {
	var e struct {
		Error struct {
			Message  string `json:"message"`
			Extended []struct {
				Message string `json:"Message"`
			} `json:"@Message.ExtendedInfo"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &e) == nil {
		if len(e.Error.Extended) > 0 {
			return e.Error.Extended[0].Message
		}
		return e.Error.Message
	}
	return ""
}

type collection struct {
	Members []struct {
		ID string `json:"@odata.id"`
	} `json:"Members"`
}

func (c *Client) first(ctx context.Context, path string) (string, error) {
	var col collection
	if err := c.call(ctx, http.MethodGet, path, nil, &col); err != nil {
		return "", err
	}
	if len(col.Members) == 0 {
		return "", fail("unsupported", "%s has no members", path)
	}
	return col.Members[0].ID, nil
}

func (c *Client) systemPath(ctx context.Context) (string, error) {
	if c.system == "" {
		p, err := c.first(ctx, "/redfish/v1/Systems")
		if err != nil {
			return "", err
		}
		c.system = p
	}
	return c.system, nil
}

// managerPath is the manager of the system (its Links.ManagedBy), else the service's first manager.
func (c *Client) managerPath(ctx context.Context) (string, error) {
	if c.manager == "" {
		sys, err := c.systemPath(ctx)
		if err != nil {
			return "", err
		}
		var s struct {
			Links struct {
				ManagedBy []struct {
					ID string `json:"@odata.id"`
				} `json:"ManagedBy"`
			} `json:"Links"`
		}
		if err := c.call(ctx, http.MethodGet, sys, nil, &s); err == nil && len(s.Links.ManagedBy) > 0 && s.Links.ManagedBy[0].ID != "" {
			c.manager = s.Links.ManagedBy[0].ID
			return c.manager, nil
		}
		p, err := c.first(ctx, "/redfish/v1/Managers")
		if err != nil {
			return "", err
		}
		c.manager = p
	}
	return c.manager, nil
}

// Do runs one operation ("<kind>.<operation>") with its JSON args and returns its JSON result.
func (c *Client) Do(ctx context.Context, operation string, args map[string]any) (map[string]any, error) {
	switch operation {
	case "power.getPower":
		return c.getPower(ctx)
	case "power.setPower":
		return c.setPower(ctx, str(args["action"]))
	case "management.setBootDevice":
		return c.setBootDevice(ctx, str(args["device"]), args["persistent"] == true, args["uefi"] != false)
	case "virtual-media.insert":
		return c.virtualMedia(ctx, true, str(args["url"]))
	case "virtual-media.eject":
		return c.virtualMedia(ctx, false, "")
	case "inspect.inspect":
		return c.inspect(ctx)
	case "firmware.components":
		return c.firmware(ctx)
	case "management.rotateCredential":
		return c.rotate(ctx, str(args["username"]), str(args["newPassword"]))
	case "bios.getSettings":
		return c.biosSettings(ctx)
	case "bios.applySettings":
		return c.applyBios(ctx, args)
	case "raid.getLayout":
		return c.raidLayout(ctx)
	case "raid.applyLayout":
		return c.applyRaid(ctx, args)
	case "raid.clear":
		return c.raidClear(ctx)
	case "firmware.update":
		return c.updateFirmware(ctx, str(args["component"]), str(args["url"]))
	}
	return nil, fail("unsupported", "operation %s", operation)
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func (c *Client) getPower(ctx context.Context) (map[string]any, error) {
	sys, err := c.systemPath(ctx)
	if err != nil {
		return nil, err
	}
	var s struct {
		PowerState string `json:"PowerState"`
	}
	if err := c.call(ctx, http.MethodGet, sys, nil, &s); err != nil {
		return nil, err
	}
	power := "unknown"
	switch strings.ToLower(s.PowerState) {
	case "on", "poweringoff":
		power = "on"
	case "off", "poweringon":
		power = "off"
	}
	return map[string]any{"power": power}, nil
}

var resetTypes = map[string]string{
	"on":               "On",
	"off":              "ForceOff",
	"graceful-off":     "GracefulShutdown",
	"reset":            "ForceRestart",
	"graceful-restart": "GracefulRestart",
	"cycle":            "PowerCycle",
	"nmi":              "Nmi",
}

func (c *Client) setPower(ctx context.Context, action string) (map[string]any, error) {
	reset, ok := resetTypes[action]
	if !ok {
		return nil, fail("invalid-args", "power action %q", action)
	}
	sys, err := c.systemPath(ctx)
	if err != nil {
		return nil, err
	}
	if err := c.call(ctx, http.MethodPost, sys+"/Actions/ComputerSystem.Reset", map[string]string{"ResetType": reset}, nil); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

var bootTargets = map[string]string{"pxe": "Pxe", "http": "UefiHttp", "disk": "Hdd", "cd": "Cd"}

func (c *Client) setBootDevice(ctx context.Context, device string, persistent, uefi bool) (map[string]any, error) {
	target, ok := bootTargets[device]
	if !ok {
		return nil, fail("invalid-args", "boot device %q", device)
	}
	sys, err := c.systemPath(ctx)
	if err != nil {
		return nil, err
	}
	enabled, mode := "Once", "UEFI"
	if persistent {
		enabled = "Continuous"
	}
	if !uefi {
		mode = "Legacy"
	}
	patch := map[string]any{"Boot": map[string]string{
		"BootSourceOverrideTarget":  target,
		"BootSourceOverrideEnabled": enabled,
		"BootSourceOverrideMode":    mode,
	}}
	if err := c.call(ctx, http.MethodPatch, sys, patch, nil); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

func (c *Client) virtualMedia(ctx context.Context, insert bool, image string) (map[string]any, error) {
	mgr, err := c.managerPath(ctx)
	if err != nil {
		return nil, err
	}
	var col collection
	if err := c.call(ctx, http.MethodGet, mgr+"/VirtualMedia", nil, &col); err != nil {
		return nil, err
	}
	for _, m := range col.Members {
		var vm struct {
			MediaTypes []string `json:"MediaTypes"`
		}
		if err := c.call(ctx, http.MethodGet, m.ID, nil, &vm); err != nil {
			return nil, err
		}
		cd := false
		for _, t := range vm.MediaTypes {
			if t == "CD" || t == "DVD" {
				cd = true
			}
		}
		if !cd {
			continue
		}
		if insert {
			if !strings.HasPrefix(image, "https://") && !strings.HasPrefix(image, "http://") {
				return nil, fail("invalid-args", "virtual media needs an http(s) image URL")
			}
			err = c.call(ctx, http.MethodPost, m.ID+"/Actions/VirtualMedia.InsertMedia", map[string]any{"Image": image, "Inserted": true}, nil)
		} else {
			err = c.call(ctx, http.MethodPost, m.ID+"/Actions/VirtualMedia.EjectMedia", map[string]any{}, nil)
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{}, nil
	}
	return nil, fail("unsupported", "the BMC has no CD virtual media")
}

func (c *Client) inspect(ctx context.Context) (map[string]any, error) {
	sys, err := c.systemPath(ctx)
	if err != nil {
		return nil, err
	}
	var s struct {
		Manufacturer string `json:"Manufacturer"`
		Model        string `json:"Model"`
		SerialNumber string `json:"SerialNumber"`
		UUID         string `json:"UUID"`
		PowerState   string `json:"PowerState"`
	}
	if err := c.call(ctx, http.MethodGet, sys, nil, &s); err != nil {
		return nil, err
	}
	macs, ips := []string{}, []string{}
	var col collection
	if err := c.call(ctx, http.MethodGet, sys+"/EthernetInterfaces", nil, &col); err == nil {
		for _, m := range col.Members {
			var nic struct {
				MACAddress    string `json:"MACAddress"`
				IPv4Addresses []struct {
					Address string `json:"Address"`
				} `json:"IPv4Addresses"`
			}
			if c.call(ctx, http.MethodGet, m.ID, nil, &nic) != nil {
				continue
			}
			if nic.MACAddress != "" {
				macs = append(macs, strings.ToLower(nic.MACAddress))
			}
			for _, a := range nic.IPv4Addresses {
				if a.Address != "" && a.Address != "0.0.0.0" {
					ips = append(ips, a.Address)
				}
			}
		}
	}
	return map[string]any{
		"macs": macs, "ipAddresses": ips, "manufacturer": s.Manufacturer, "model": s.Model,
		"serialNumber": s.SerialNumber, "productUuid": strings.ToLower(s.UUID), "power": strings.ToLower(s.PowerState),
	}, nil
}

func (c *Client) firmware(ctx context.Context) (map[string]any, error) {
	var col collection
	if err := c.call(ctx, http.MethodGet, "/redfish/v1/UpdateService/FirmwareInventory", nil, &col); err != nil {
		return nil, err
	}
	components := []map[string]string{}
	for _, m := range col.Members {
		var fw struct {
			ID      string `json:"Id"`
			Name    string `json:"Name"`
			Version string `json:"Version"`
		}
		if c.call(ctx, http.MethodGet, m.ID, nil, &fw) != nil {
			continue
		}
		components = append(components, map[string]string{"id": fw.ID, "name": fw.Name, "version": fw.Version})
	}
	return map[string]any{"components": components}, nil
}

// rotate sets the account's password, then proves it by logging in with it.
func (c *Client) rotate(ctx context.Context, username, password string) (map[string]any, error) {
	if password == "" {
		return nil, fail("invalid-args", "no new password")
	}
	if username == "" {
		username = c.username
	}
	var col collection
	if err := c.call(ctx, http.MethodGet, "/redfish/v1/AccountService/Accounts", nil, &col); err != nil {
		return nil, err
	}
	account := ""
	for _, m := range col.Members {
		var a struct {
			UserName string `json:"UserName"`
		}
		if c.call(ctx, http.MethodGet, m.ID, nil, &a) == nil && a.UserName == username {
			account = m.ID
		}
	}
	if account == "" {
		return nil, fail("unsupported", "no BMC account %q", username)
	}
	if err := c.call(ctx, http.MethodPatch, account, map[string]string{"Password": password}, nil); err != nil {
		return nil, err
	}
	proof := &Client{base: c.base, username: username, password: password, http: c.http}
	if _, err := proof.first(ctx, "/redfish/v1/Systems"); err != nil {
		return map[string]any{"verified": false}, nil
	}
	return map[string]any{"verified": true}, nil
}
