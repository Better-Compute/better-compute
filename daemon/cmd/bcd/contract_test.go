package main

import (
	"encoding/json"
	"flag"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/config"
)

// installContract is testdata/install-contract.json, written by scripts/daemon-install-contract.mjs
// from provision's user-data renderers and the Hetzner Robot bootstrap.
type installContract struct {
	Variables map[string]string `json:"variables"`
	Pins      struct {
		ServingCA      string `json:"servingCa"`
		JoinSigning    string `json:"joinSigning"`
		JoinEncryption string `json:"joinEncryption"`
	} `json:"pins"`
	Provision struct {
		Join      []string `json:"join"`
		Node      []string `json:"node"`
		CloudInit string   `json:"cloudInit"`
		Ignition  string   `json:"ignition"`
	} `json:"provision"`
	Robot struct {
		Join   []string `json:"join"`
		Script string   `json:"script"`
	} `json:"robot"`
}

// parseInstalled parses a rendered command line with bcd's real flag set, as the installed binary
// would, and returns the flag values.
func parseInstalled(t *testing.T, argv []string) (string, map[string]string) {
	t.Helper()
	if len(argv) < 2 || argv[0] != "/usr/local/bin/bcd" {
		t.Fatalf("not a bcd command line: %q", argv)
	}
	var stderr strings.Builder
	c, fs, code := parse(argv[1:], io.Discard, &stderr)
	if c == nil {
		t.Fatalf("bcd rejects %q (exit %d): %s", argv, code, stderr.String())
	}
	flags := map[string]string{}
	fs.VisitAll(func(f *flag.Flag) { flags[f.Name] = f.Value.String() })
	return c.name, flags
}

// execStarts returns the commands of a text's systemd ExecStart= lines.
func execStarts(text string) [][]string {
	var out [][]string
	for _, line := range strings.Split(text, "\n") {
		if cmd, ok := strings.CutPrefix(strings.TrimSpace(line), "ExecStart="); ok {
			out = append(out, strings.Fields(cmd))
		}
	}
	return out
}

func TestInstallContract(t *testing.T) {
	raw, err := os.ReadFile("testdata/install-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var ic installContract
	if err := json.Unmarshal(raw, &ic); err != nil {
		t.Fatal(err)
	}
	v := ic.Variables

	// provision: join as the node the OS was installed for, then run the node agent on the config
	// bcd join wrote.
	name, join := parseInstalled(t, ic.Provision.Join)
	if name != "join" || join["server"] != v["controlPlaneUrl"] || join["node-id"] != v["nodeId"] || join["token-file"] != "/etc/bcd/join-token" {
		t.Fatalf("provision join = %s %v", name, join)
	}
	if join["serving-ca-pin"] != ic.Pins.ServingCA || join["join-signing-pin"] != ic.Pins.JoinSigning || join["join-encryption-pin"] != ic.Pins.JoinEncryption {
		t.Fatalf("provision join pins = %v", join)
	}
	name, node := parseInstalled(t, ic.Provision.Node)
	if name != "node" || node["config"] != join["config"] || node["config"] != config.DefaultPath {
		t.Fatalf("provision node = %s %v; bcd join writes %s", name, node, join["config"])
	}
	// The rendered documents run exactly those command lines.
	var runcmd []string
	for _, line := range strings.Split(ic.Provision.CloudInit, "\n") {
		if item, ok := strings.CutPrefix(line, "  - [/usr/local/bin/bcd, "); ok {
			runcmd = append([]string{"/usr/local/bin/bcd"}, strings.Split(strings.TrimSuffix(item, "]"), ", ")...)
		}
	}
	if !reflect.DeepEqual(runcmd, ic.Provision.Join) {
		t.Fatalf("cloud-init runs %q, not %q", runcmd, ic.Provision.Join)
	}
	if got := execStarts(ic.Provision.CloudInit); len(got) != 1 || !reflect.DeepEqual(got[0], ic.Provision.Node) {
		t.Fatalf("cloud-init bcd.service runs %q", got)
	}
	var ign struct {
		Systemd struct {
			Units []struct {
				Name     string `json:"name"`
				Contents string `json:"contents"`
			} `json:"units"`
		} `json:"systemd"`
	}
	if err := json.Unmarshal([]byte(ic.Provision.Ignition), &ign); err != nil {
		t.Fatal(err)
	}
	units := map[string][][]string{}
	for _, u := range ign.Systemd.Units {
		units[u.Name] = execStarts(u.Contents)
	}
	if !reflect.DeepEqual(units["bcd-join.service"], [][]string{ic.Provision.Join}) || !reflect.DeepEqual(units["bcd.service"], [][]string{ic.Provision.Node}) {
		t.Fatalf("ignition units run %q", units)
	}

	// Hetzner Robot: no node id before the join; the provisioned attestor with a machine-bound token.
	name, robot := parseInstalled(t, ic.Robot.Join)
	if name != "join" || robot["server"] != v["controlPlaneUrl"] || robot["attestor"] != "provisioned" || robot["token-file"] != "/etc/bcd/join-token" {
		t.Fatalf("robot join = %s %v", name, robot)
	}
	// It carries the install's pins (bcd refuses to bootstrap without them), in config.toml's form.
	if robot["serving-ca-pin"] != ic.Pins.ServingCA || robot["join-signing-pin"] != ic.Pins.JoinSigning || robot["join-encryption-pin"] != ic.Pins.JoinEncryption {
		t.Fatalf("robot join pins = %v", robot)
	}
	for _, flag := range []string{"serving-ca-pin", "join-signing-pin", "join-encryption-pin"} {
		if _, err := config.DecodePin(robot[flag]); err != nil {
			t.Fatalf("--%s %q: %v", flag, robot[flag], err)
		}
	}
	if !strings.Contains(ic.Robot.Script, "> /etc/bcd/join-token") {
		t.Fatal("the Robot bootstrap does not write the token where bcd join reads it")
	}
	got := execStarts(ic.Robot.Script)
	if len(got) != 2 || !reflect.DeepEqual(got[0], ic.Robot.Join) {
		t.Fatalf("robot units run %q", got)
	}
	if name, flags := parseInstalled(t, got[1]); name != "node" || flags["config"] != config.DefaultPath {
		t.Fatalf("robot bcd.service runs %q", got[1])
	}
}
