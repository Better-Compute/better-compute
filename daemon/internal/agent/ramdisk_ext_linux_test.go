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

// kexec's kernel and initrd come out of a real ext4 image in userspace: symlinks resolve inside the
// image (an absolute target is the image's path, never the ramdisk's), loops end.
func TestExtBootFilesInUserspace(t *testing.T) {
	mkfs, err := osexec.LookPath("mkfs.ext4")
	if err != nil {
		t.Skip("no mkfs.ext4")
	}
	if _, err := osexec.LookPath(debugfsPath); err != nil {
		t.Skip("no debugfs")
	}
	ctx := context.Background()
	dir := t.TempDir()
	img := filepath.Join(dir, "root.img")
	if out, err := osexec.Command(mkfs, "-q", "-F", img, "16M").CombinedOutput(); err != nil {
		t.Fatalf("mkfs.ext4: %v %s", err, out)
	}
	kernel := filepath.Join(dir, "k")
	initrd := filepath.Join(dir, "i")
	_ = os.WriteFile(kernel, []byte("kernel 6.8.0-1+deb"), 0o600)
	_ = os.WriteFile(initrd, []byte("initrd 6.8.0-1+deb"), 0o600)
	debugfs := func(script ...string) {
		t.Helper()
		plant := filepath.Join(dir, "plant")
		_ = os.WriteFile(plant, []byte(strings.Join(script, "\n")+"\n"), 0o600)
		if out, err := osexec.Command(debugfsPath, "-w", "-f", plant, img).CombinedOutput(); err != nil {
			t.Fatalf("debugfs: %v %s", err, out)
		}
	}
	debugfs(
		"mkdir /boot",
		"write "+kernel+" /boot/vmlinuz-6.8.0-1+deb",
		"write "+initrd+" /boot/initrd.img-6.8.0-1+deb",
		"symlink /boot/vmlinuz /boot/vmlinuz-6.8.0-1+deb",
		"symlink /boot/initrd.img initrd.img-6.8.0-1+deb",
		"symlink /boot/loop-a /boot/loop-b",
		"symlink /boot/loop-b /boot/loop-a",
		"symlink /boot/shadow /etc/shadow",
	)
	k, i := extBootFiles(ctx, img, "", "")
	if k != "/boot/vmlinuz" || i != "/boot/initrd.img" {
		t.Fatalf("boot files = %q %q", k, i)
	}
	out := filepath.Join(dir, "out")
	if err := extRead(ctx, img, k, out); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(out); string(b) != "kernel 6.8.0-1+deb" {
		t.Fatalf("kernel = %q", b)
	}
	if err := extRead(ctx, img, i, out); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"/boot/loop-a", "/boot/shadow", "/boot", "/boot/../../etc/passwd"} {
		if err := extRead(ctx, img, bad, out); err == nil {
			t.Errorf("%s was read", bad)
		}
	}
	// Without the default names: the newest vmlinuz-* and its initrd.
	debugfs("unlink /boot/vmlinuz", "unlink /boot/initrd.img")
	if k, i := extBootFiles(ctx, img, "", ""); k != "/boot/vmlinuz-6.8.0-1+deb" || i != "/boot/initrd.img-6.8.0-1+deb" {
		t.Fatalf("boot files = %q %q", k, i)
	}
}
