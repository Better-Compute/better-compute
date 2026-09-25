package agent

import (
	"bytes"
	"context"
	"fmt"
	"os"
	osexec "os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Writing into a deployed image without the kernel parsing it: the image may be a tenant's, and a
// crafted filesystem is an attack on whatever kernel mounts it. For ext2/3/4 (the root filesystem of
// most images) the ramdisk uses debugfs, which reads and writes the filesystem in userspace; other
// filesystems fall back to a nodev,nosuid kernel mount.

// debugfsPath is e2fsprogs' debugfs (tests may point it elsewhere).
var debugfsPath = "debugfs"

func isExtFS(fstype string) bool { return fstype == "ext2" || fstype == "ext3" || fstype == "ext4" }

// imagePath is a path bcd writes into an image: absolute, plain components only.
var imagePath = regexp.MustCompile(`^(/[A-Za-z0-9._-]+)+$`)

// extHas reports whether dir exists in the ext filesystem on dev.
func extHas(ctx context.Context, dev, dir string) bool {
	out, err := osexec.CommandContext(ctx, debugfsPath, "-R", "stat "+dir, dev).CombinedOutput()
	return err == nil && strings.Contains(string(out), "Type: directory")
}

// extWrite writes files (absolute paths in the image) into the ext filesystem on dev, each a
// root-owned 0600 regular file: whatever the image has at a path (a file, a symlink, a device
// node) is unlinked first, never followed, and every file is read back.
func extWrite(ctx context.Context, dev string, files map[string][]byte) error {
	tmp, err := os.MkdirTemp("", "bcd-install-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	names := make([]string, 0, len(files))
	for name := range files {
		if !imagePath.MatchString(name) || strings.Contains(name, "/../") || strings.HasSuffix(name, "/..") {
			return fmt.Errorf("%q is not a path bcd writes into an image", name)
		}
		names = append(names, name)
	}
	sort.Strings(names)
	var script []string
	made := map[string]bool{}
	for i, name := range names {
		local := filepath.Join(tmp, strconv.Itoa(i))
		if err := os.WriteFile(local, files[name], 0o600); err != nil {
			return err
		}
		// Parents first (an existing one only makes debugfs complain), then the file itself.
		var parents []string
		for dir := path.Dir(name); dir != "/"; dir = path.Dir(dir) {
			parents = append([]string{dir}, parents...)
		}
		for _, dir := range parents {
			if !made[dir] {
				made[dir] = true
				script = append(script, "mkdir "+dir)
			}
		}
		script = append(script,
			"rm "+name,
			"write "+filepath.ToSlash(local)+" "+name,
			"sif "+name+" mode 0100600",
			"sif "+name+" uid 0",
			"sif "+name+" gid 0")
	}
	cmds := filepath.Join(tmp, "commands")
	if err := os.WriteFile(cmds, []byte(strings.Join(script, "\n")+"\n"), 0o600); err != nil {
		return err
	}
	if out, err := osexec.CommandContext(ctx, debugfsPath, "-w", "-f", cmds, dev).CombinedOutput(); err != nil {
		return fmt.Errorf("debugfs: %v: %s", err, strings.TrimSpace(string(out)))
	}
	for _, name := range names {
		got, err := osexec.CommandContext(ctx, debugfsPath, "-R", "cat "+name, dev).Output()
		if err != nil || !bytes.Equal(got, files[name]) {
			return fmt.Errorf("%s did not read back from the image as written", name)
		}
		stat, _ := osexec.CommandContext(ctx, debugfsPath, "-R", "stat "+name, dev).CombinedOutput()
		if !strings.Contains(string(stat), "Type: regular") {
			return fmt.Errorf("%s is not a regular file in the image", name)
		}
	}
	return nil
}

// installOnExt writes files into the first ext partition of parts holding /etc, in userspace. ok is
// false when there is none (the caller falls back to a mount).
func installOnExt(ctx context.Context, parts []blockDevice, files map[string][]byte) (ok bool, err error) {
	if _, err := osexec.LookPath(debugfsPath); err != nil {
		return false, nil
	}
	for _, p := range parts {
		dev := "/dev/" + p.Name
		if isExtFS(p.FSType) && extHas(ctx, dev, "/etc") {
			return true, extWrite(ctx, dev, files)
		}
	}
	return false, nil
}
