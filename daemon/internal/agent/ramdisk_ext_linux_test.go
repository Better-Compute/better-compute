//go:build linux

package agent

import (
	"context"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A real ext4 image, written in userspace: a symlink the image planted where bcd writes is replaced,
// never followed, and the files read back as root-owned 0600 regular files.
func TestExtWriteInUserspace(t *testing.T) {
	mkfs, err := osexec.LookPath("mkfs.ext4")
	if err != nil {
		t.Skip("no mkfs.ext4")
	}
	if _, err := osexec.LookPath(debugfsPath); err != nil {
		t.Skip("no debugfs")
	}
	ctx := context.Background()
	img := filepath.Join(t.TempDir(), "root.img")
	if out, err := osexec.Command(mkfs, "-q", "-F", img, "16M").CombinedOutput(); err != nil {
		t.Fatalf("mkfs.ext4: %v %s", err, out)
	}
	plant := filepath.Join(t.TempDir(), "plant")
	_ = os.WriteFile(plant, []byte("mkdir /etc\nmkdir /etc/bcd\nsymlink /etc/bcd/config.toml /dev/sdb\n"), 0o600)
	if out, err := osexec.Command(debugfsPath, "-w", "-f", plant, img).CombinedOutput(); err != nil {
		t.Fatalf("plant: %v %s", err, out)
	}
	if !extHas(ctx, img, "/etc") || extHas(ctx, img, "/nope") {
		t.Fatal("extHas")
	}
	files := map[string][]byte{
		"/etc/bcd/config.toml":                  []byte("gateway_url = \"https://gw.example.com\"\n"),
		"/var/lib/cloud/seed/nocloud/user-data": []byte("#cloud-config\nhostname: web\n"),
	}
	if err := extWrite(ctx, img, files); err != nil {
		t.Fatal(err)
	}
	stat, _ := osexec.Command(debugfsPath, "-R", "stat /etc/bcd/config.toml", img).CombinedOutput()
	if !strings.Contains(string(stat), "Type: regular") || !strings.Contains(string(stat), "Mode:  0600") || !strings.Contains(string(stat), "User:     0") {
		t.Fatalf("config.toml = %s", stat)
	}
	for _, bad := range []string{"etc/relative", "/etc/../../x", "/etc/bcd/config.toml;rm -rf"} {
		if err := extWrite(ctx, img, map[string][]byte{bad: []byte("x")}); err == nil {
			t.Errorf("%q was written", bad)
		}
	}
}
