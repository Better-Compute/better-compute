package agent

import (
	"bytes"
	"context"
	"errors"
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

// haveTool reports whether a program is installed.
func haveTool(name string) bool {
	_, err := osexec.LookPath(name)
	return err == nil
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

// readPath is a path bcd reads out of an image (kernel versions carry + and ~).
var readPath = regexp.MustCompile(`^(/[A-Za-z0-9._+~-]+)+$`)

// maxBootFile bounds a kernel or initrd read out of an image.
const maxBootFile = 512 << 20

// extStat describes path in the ext filesystem on dev without following a final symlink (debugfs
// resolves earlier components inside the filesystem, never on the host).
func extStat(ctx context.Context, dev, p string) (kind, link string, size int64, ok bool) {
	if !readPath.MatchString(p) {
		return "", "", 0, false
	}
	out, err := osexec.CommandContext(ctx, debugfsPath, "-R", "stat "+p, dev).CombinedOutput()
	if err != nil {
		return "", "", 0, false
	}
	text := string(out)
	switch {
	case strings.Contains(text, "Type: regular"):
		kind = "regular"
	case strings.Contains(text, "Type: symlink"):
		kind = "symlink"
		if m := regexp.MustCompile(`Fast link dest: "([^"]*)"`).FindStringSubmatch(text); m != nil {
			link = m[1]
		}
	case strings.Contains(text, "Type: directory"):
		kind = "directory"
	default:
		return "", "", 0, false
	}
	if m := regexp.MustCompile(`Size: (\d+)`).FindStringSubmatch(text); m != nil {
		size, _ = strconv.ParseInt(m[1], 10, 64)
	}
	return kind, link, size, true
}

// extResolve follows symlinks inside the image (at most 8, targets resolved against the image's own
// root) to a regular file, and returns its path and size.
func extResolve(ctx context.Context, dev, p string) (string, int64, bool) {
	for hops := 0; hops < 8; hops++ {
		kind, link, size, ok := extStat(ctx, dev, p)
		switch {
		case !ok:
			return "", 0, false
		case kind == "regular":
			return p, size, true
		case kind != "symlink" || link == "":
			return "", 0, false
		}
		if strings.HasPrefix(link, "/") {
			p = path.Clean(link)
		} else {
			p = path.Clean(path.Join(path.Dir(p), link))
		}
	}
	return "", 0, false
}

// extRead copies a regular file (symlinks followed inside the image) out of the ext filesystem on
// dev into local, in userspace.
func extRead(ctx context.Context, dev, p, local string) error {
	resolved, size, ok := extResolve(ctx, dev, p)
	if !ok {
		return fmt.Errorf("%s is not a regular file in the image", p)
	}
	if size > maxBootFile {
		return fmt.Errorf("%s is %d bytes; at most %d are read", p, size, maxBootFile)
	}
	_ = os.Remove(local)
	if out, err := osexec.CommandContext(ctx, debugfsPath, "-R", "dump "+resolved+" "+filepath.ToSlash(local), dev).CombinedOutput(); err != nil {
		return fmt.Errorf("debugfs dump %s: %v: %s", resolved, err, strings.TrimSpace(string(out)))
	}
	if fi, err := os.Stat(local); err != nil || fi.Size() != size {
		return fmt.Errorf("%s did not read back whole", p)
	}
	return nil
}

// extList lists the names in a directory of the ext filesystem on dev.
func extList(ctx context.Context, dev, dir string) []string {
	if !readPath.MatchString(dir) {
		return nil
	}
	out, err := osexec.CommandContext(ctx, debugfsPath, "-R", "ls -p "+dir, dev).Output()
	if err != nil {
		return nil
	}
	var names []string
	for _, line := range strings.Split(string(out), "\n") {
		// /inode/mode/uid/gid/name/size/
		f := strings.Split(strings.TrimSpace(line), "/")
		if len(f) >= 7 && f[5] != "." && f[5] != ".." && f[5] != "" {
			names = append(names, f[5])
		}
	}
	return names
}

// extBootFiles is bootFiles over an unmounted ext filesystem: the kernel and initrd paths (absolute
// in the image), "" when it holds no kernel.
func extBootFiles(ctx context.Context, dev, kernel, initrd string) (string, string) {
	has := func(p string) bool { _, _, ok := extResolve(ctx, dev, p); return ok }
	if kernel != "" {
		k, i := "/"+strings.TrimPrefix(kernel, "/"), ""
		if !has(k) {
			return "", ""
		}
		if initrd != "" {
			i = "/" + strings.TrimPrefix(initrd, "/")
		}
		return k, i
	}
	if has("/boot/vmlinuz") {
		if has("/boot/initrd.img") {
			return "/boot/vmlinuz", "/boot/initrd.img"
		}
		return "/boot/vmlinuz", ""
	}
	var kernels []string
	for _, n := range extList(ctx, dev, "/boot") {
		if strings.HasPrefix(n, "vmlinuz-") {
			kernels = append(kernels, n)
		}
	}
	if len(kernels) == 0 {
		return "", ""
	}
	sort.Strings(kernels)
	k := "/boot/" + kernels[len(kernels)-1]
	version := strings.TrimPrefix(kernels[len(kernels)-1], "vmlinuz-")
	for _, cand := range []string{"/boot/initrd.img-" + version, "/boot/initramfs-" + version + ".img", "/boot/initrd-" + version} {
		if has(cand) {
			return k, cand
		}
	}
	return k, ""
}

// ---- FAT (EFI system and some boot partitions), with mtools --------------------------------------

// mtoolsDir holds mtools (tests may point it elsewhere).
var mtoolsDir = ""

func mtool(name string) string {
	if mtoolsDir != "" {
		return filepath.Join(mtoolsDir, name)
	}
	return name
}

func isFatFS(fstype string) bool { return fstype == "vfat" || fstype == "fat" || fstype == "msdos" }

// fatWrite writes files into the FAT filesystem on dev in userspace (FAT has no symlinks or device
// nodes; whatever is at a path is replaced), and reads each back.
func fatWrite(ctx context.Context, dev string, files map[string][]byte) error {
	if _, err := osexec.LookPath(mtool("mcopy")); err != nil {
		return errors.New("mtools is not installed")
	}
	tmp, err := os.MkdirTemp("", "bcd-fat-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	env := append(os.Environ(), "MTOOLS_SKIP_CHECK=1")
	mt := func(name string, args ...string) ([]byte, error) {
		cmd := osexec.CommandContext(ctx, mtool(name), append([]string{"-i", dev}, args...)...)
		cmd.Env = env
		return cmd.CombinedOutput()
	}
	names := make([]string, 0, len(files))
	for name := range files {
		if !imagePath.MatchString(name) {
			return fmt.Errorf("%q is not a path bcd writes into an image", name)
		}
		names = append(names, name)
	}
	sort.Strings(names)
	for i, name := range names {
		for _, dir := range parentsOf(name) {
			if _, err := mt("mdir", "::"+dir); err != nil {
				if out, err := mt("mmd", "::"+dir); err != nil {
					return fmt.Errorf("mmd %s: %v: %s", dir, err, strings.TrimSpace(string(out)))
				}
			}
		}
		local := filepath.Join(tmp, strconv.Itoa(i))
		if err := os.WriteFile(local, files[name], 0o600); err != nil {
			return err
		}
		if out, err := mt("mcopy", "-o", "-n", local, "::"+name); err != nil {
			return fmt.Errorf("mcopy %s: %v: %s", name, err, strings.TrimSpace(string(out)))
		}
		back := local + ".back"
		if _, err := mt("mcopy", "-n", "::"+name, back); err != nil {
			return fmt.Errorf("%s did not read back from the image", name)
		}
		if got, err := os.ReadFile(back); err != nil || !bytes.Equal(got, files[name]) {
			return fmt.Errorf("%s did not read back from the image as written", name)
		}
	}
	return nil
}

// parentsOf lists the directories above an absolute path, outermost first.
func parentsOf(name string) []string {
	var parents []string
	for dir := path.Dir(name); dir != "/"; dir = path.Dir(dir) {
		parents = append([]string{dir}, parents...)
	}
	return parents
}
