package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	driverv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1"
)

// fakeTool is an ipmitool that records its arguments, the password it read from fd 3 and its
// environment's.
func fakeTool(t *testing.T, status string) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell script")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	script := "#!/bin/sh\necho \"$@ pw=$(cat /dev/fd/3) env=${IPMI_PASSWORD}\" >> " + log + "\n" +
		"case \"$*\" in *'power status'*) echo '" + status + "' ;; esac\n"
	tool := filepath.Join(dir, "ipmitool")
	if err := os.WriteFile(tool, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return tool, log
}

func invoke(d *driver, kind, op, args string) (string, error) {
	return d.run(context.Background(), &driverv1.InvokeRequest{
		DriverId: "ipmi", Kind: kind, Operation: op, ArgsJson: args,
		ConfigJson: `{"address":"https://10.0.0.9:6230"}`,
		Secrets:    []*driverv1.SecretValue{{Field: "username", Value: []byte("admin")}, {Field: "password", Value: []byte("s3cret")}},
	})
}

func TestIPMIOperations(t *testing.T) {
	tool, log := fakeTool(t, "Chassis Power is on")
	d := &driver{tool: tool}
	if out, err := invoke(d, "power", "getPower", ""); err != nil || out != `{"power":"on"}` {
		t.Fatalf("getPower = %q, %v", out, err)
	}
	if _, err := invoke(d, "power", "setPower", `{"action":"cycle"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := invoke(d, "management", "setBootDevice", `{"device":"PXE","persistent":true}`); err != nil {
		t.Fatal(err)
	}
	calls, _ := os.ReadFile(log)
	for _, want := range []string{
		"-I lanplus -H 10.0.0.9 -U admin -C 17 -f /dev/fd/3 -p 6230 chassis power status pw=s3cret env=\n",
		"chassis power cycle",
		"chassis bootdev pxe options=persistent",
	} {
		if !strings.Contains(string(calls), want) {
			t.Fatalf("calls lack %q:\n%s", want, calls)
		}
	}
	if strings.Contains(strings.ReplaceAll(string(calls), "pw=s3cret", ""), "s3cret") {
		t.Fatal("the password reached ipmitool's arguments")
	}
}

// An old BMC's enrollment options select cipher suite 3.
func TestIPMICipherSuiteOption(t *testing.T) {
	tool, log := fakeTool(t, "Chassis Power is on")
	_, err := (&driver{tool: tool}).run(context.Background(), &driverv1.InvokeRequest{Kind: "power", Operation: "getPower",
		ConfigJson: `{"address":"10.0.0.9","tlsSpkiSha256":"","options":{"cipherSuite":3}}`,
		Secrets:    []*driverv1.SecretValue{{Field: "username", Value: []byte("admin")}, {Field: "password", Value: []byte("s3cret")}}})
	if calls, _ := os.ReadFile(log); err != nil || !strings.Contains(string(calls), "-C 3 ") {
		t.Fatalf("calls = %s, %v", calls, err)
	}
}

// inspect.inspect answers the Redfish driver's shape from fru, mc, lan and sdr.
func TestIPMIInspect(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script")
	}
	dir := t.TempDir()
	outputs := map[string]string{
		"fru": `FRU Device Description : Builtin FRU Device (ID 0)
 Chassis Type          : Rack Mount Chassis
 Chassis Serial        : C0FFEE
 Board Mfg             : Supermicro
 Board Product         : X12DPi-NT6
 Board Serial          : WM12345
 Product Manufacturer  : Supermicro
 Product Name          : SYS-220U-TNR
 Product Serial        : S98765`,
		"mc": `Device ID                 : 32
Firmware Revision         : 1.73
Manufacturer Name         : Supermicro
Additional Device Support :
    Sensor Device`,
		"lan": `IP Address Source       : DHCP Address
IP Address              : 10.0.0.9
MAC Address             : 0C:C4:7A:AA:BB:CC`,
		"sdr": `CPU1 Temp        | 45 degrees C      | ok
CPU2 Temp        | no reading        | ns
FAN3             | 0 RPM             | cr
PS1 Status       | 0x01              | ok`,
	}
	script := "#!/bin/sh\ncat /dev/fd/3 >/dev/null\ncase \"$*\" in\n" +
		"*'mc guid'*) echo 'System GUID  : 4C4C4544-0042-3810-8051-B2C04F4E3232'; echo 'Timestamp    : 01/01/1970 00:00:00' ;;\n"
	for key, out := range outputs {
		file := filepath.Join(dir, key)
		_ = os.WriteFile(file, []byte(out+"\n"), 0o600)
		script += "*' " + key + " '*) cat " + file + " ;;\n"
	}
	script += "*'power status'*) echo 'Chassis Power is on' ;;\nesac\n"
	tool := filepath.Join(dir, "ipmitool")
	_ = os.WriteFile(tool, []byte(script), 0o755)
	out, err := invoke(&driver{tool: tool}, "inspect", "inspect", "")
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Manufacturer, Model, SerialNumber, Power string
		Macs                                     []string
		IPAddresses                              []string `json:"ipAddresses"`
		ProductUUID                              *string  `json:"productUuid"`
		Board                                    map[string]string
		BMC                                      map[string]string `json:"bmc"`
		Sensors                                  struct {
			Count, OK int
			Problems  []map[string]string
		}
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("%s: %v", out, err)
	}
	if got.Manufacturer != "Supermicro" || got.Model != "SYS-220U-TNR" || got.SerialNumber != "S98765" || got.Power != "on" ||
		got.Macs == nil || len(got.Macs) != 0 || got.IPAddresses == nil || got.ProductUUID == nil || *got.ProductUUID != "4c4c4544-0042-3810-8051-b2c04f4e3232" ||
		got.Board["product"] != "X12DPi-NT6" || got.BMC["firmware"] != "1.73" || got.BMC["mac"] != "0c:c4:7a:aa:bb:cc" || got.BMC["ipAddress"] != "10.0.0.9" ||
		got.Sensors.Count != 4 || got.Sensors.OK != 2 || len(got.Sensors.Problems) != 1 || got.Sensors.Problems[0]["name"] != "FAN3" {
		t.Fatalf("inspect = %s", out)
	}
}

func TestIPMIRefusals(t *testing.T) {
	tool, log := fakeTool(t, "Chassis Power is off")
	d := &driver{tool: tool}
	var f *failure
	for name, call := range map[string]func() error{
		"power verb":  func() error { _, err := invoke(d, "power", "setPower", `{"action":"on; reboot"}`); return err },
		"boot device": func() error { _, err := invoke(d, "management", "setBootDevice", `{"device":"usb"}`); return err },
		"operation":   func() error { _, err := invoke(d, "raid", "clear", ""); return err },
		"address": func() error {
			_, err := d.run(context.Background(), &driverv1.InvokeRequest{Kind: "power", Operation: "getPower", ConfigJson: `{"address":"-oProxyCommand=x"}`,
				Secrets: []*driverv1.SecretValue{{Field: "username", Value: []byte("admin")}, {Field: "password", Value: []byte("x")}}})
			return err
		},
		"pinned": func() error {
			_, err := d.run(context.Background(), &driverv1.InvokeRequest{Kind: "power", Operation: "getPower", ConfigJson: `{"address":"10.0.0.9","tlsSpkiSha256":"ab"}`,
				Secrets: []*driverv1.SecretValue{{Field: "username", Value: []byte("admin")}, {Field: "password", Value: []byte("x")}}})
			return err
		},
		"cipher suite": func() error {
			_, err := d.run(context.Background(), &driverv1.InvokeRequest{Kind: "power", Operation: "getPower", ConfigJson: `{"address":"10.0.0.9","options":{"cipherSuite":1}}`,
				Secrets: []*driverv1.SecretValue{{Field: "username", Value: []byte("admin")}, {Field: "password", Value: []byte("x")}}})
			return err
		},
		"unknown option": func() error {
			_, err := d.run(context.Background(), &driverv1.InvokeRequest{Kind: "power", Operation: "getPower", ConfigJson: `{"address":"10.0.0.9","options":{"lanplus":false}}`,
				Secrets: []*driverv1.SecretValue{{Field: "username", Value: []byte("admin")}, {Field: "password", Value: []byte("x")}}})
			return err
		},
		"long password": func() error {
			_, err := d.run(context.Background(), &driverv1.InvokeRequest{Kind: "power", Operation: "getPower", ConfigJson: `{"address":"10.0.0.9"}`,
				Secrets: []*driverv1.SecretValue{{Field: "username", Value: []byte("admin")}, {Field: "password", Value: []byte(strings.Repeat("p", 21))}}})
			return err
		},
		"username": func() error {
			_, err := d.run(context.Background(), &driverv1.InvokeRequest{Kind: "power", Operation: "getPower", ConfigJson: `{"address":"10.0.0.9"}`,
				Secrets: []*driverv1.SecretValue{{Field: "username", Value: []byte("-f/etc/passwd")}, {Field: "password", Value: []byte("x")}}})
			return err
		},
	} {
		if err := call(); !errors.As(err, &f) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if calls, _ := os.ReadFile(log); len(calls) != 0 {
		t.Fatalf("a refused request ran ipmitool: %s", calls)
	}
}
