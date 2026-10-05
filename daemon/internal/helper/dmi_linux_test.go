package helper

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeDMI(t *testing.T, root, name, content string) {
	t.Helper()
	dir := filepath.Join(root, "sys", "class", "dmi", "id")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o400); err != nil {
		t.Fatal(err)
	}
}

// The root-only values come back trimmed, capped and printable; a missing file reads empty.
func TestDMIReadReturnsTheRootOnlyValues(t *testing.T) {
	c, _, root := serve(t, me)
	writeDMI(t, root, "product_uuid", "4C4C4544-0051-3010-8044-B4C04F4E3433\n")
	writeDMI(t, root, "product_serial", "  7Q4D3S3\x00\x1b[31m\n")
	writeDMI(t, root, "board_serial", strings.Repeat("B", 400))
	// A symlink in place of a file is never followed.
	if err := os.WriteFile(filepath.Join(root, "secret"), []byte("root's secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "secret"), filepath.Join(root, "sys", "class", "dmi", "id", "chassis_serial")); err != nil {
		t.Fatal(err)
	}
	got, err := c.ReadDMI(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got["product_uuid"] != "4C4C4544-0051-3010-8044-B4C04F4E3433" || got["product_serial"] != "7Q4D3S3[31m" {
		t.Fatalf("values = %q", got)
	}
	if len(got["board_serial"]) != maxDMIValue {
		t.Fatalf("board_serial is %d bytes", len(got["board_serial"]))
	}
	if got["chassis_serial"] != "" || got["board_asset_tag"] != "" {
		t.Fatalf("a symlink or missing file read %q / %q", got["chassis_serial"], got["board_asset_tag"])
	}
	if len(got) != len(DMIFiles) {
		t.Fatalf("keys = %v", got)
	}
}

// Any argument is refused: dmi.read names no path, no kind, nothing.
func TestDMIReadRefusesArguments(t *testing.T) {
	c, _, root := serve(t, me)
	writeDMI(t, root, "product_uuid", "x\n")
	for _, req := range []Request{
		{Op: "dmi.read", Name: "product_uuid"},
		{Op: "dmi.read", Kind: "cdi"},
		{Op: "dmi.read", Reason: "../../etc/shadow"},
	} {
		if _, err := c.Call(context.Background(), req); err == nil || !strings.Contains(err.Error(), "takes no arguments") {
			t.Fatalf("%+v: %v", req, err)
		}
	}
	// A field the protocol does not have fails the strict decoder.
	conn, err := net.Dial("unix", c.Socket)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte(`{"v":1,"op":"dmi.read","path":"/etc/shadow"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	var resp Response
	if err := json.NewDecoder(io.LimitReader(conn, 1<<16)).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.OK || resp.Error != "malformed request" {
		t.Fatalf("resp = %+v", resp)
	}
}

// A machine without SMBIOS answers empty, not an error.
func TestDMIReadWithoutSMBIOS(t *testing.T) {
	c, _, _ := serve(t, me)
	got, err := c.ReadDMI(context.Background())
	if err != nil || len(got) != 0 {
		t.Fatalf("got %v, %v", got, err)
	}
	// And a peer the policy refuses gets nothing.
	refused, _, _ := serve(t, func(Peer) error { return errors.New("no") })
	if _, err := refused.ReadDMI(context.Background()); err == nil {
		t.Fatal("a refused peer read DMI")
	}
}
