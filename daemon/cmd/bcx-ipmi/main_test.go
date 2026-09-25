package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	driverv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1"
)

// fakeTool is an ipmitool that records its arguments and whether the password came by environment.
func fakeTool(t *testing.T, status string) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell script")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	script := "#!/bin/sh\necho \"$@ pw=${IPMI_PASSWORD}\" >> " + log + "\n" +
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
		"-I lanplus -H 10.0.0.9 -U admin -E -p 6230 chassis power status pw=s3cret",
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
