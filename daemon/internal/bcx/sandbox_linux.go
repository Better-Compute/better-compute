//go:build linux

package bcx

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// ShimCommand is the argument that makes the shim executable (bcd) run RunShim:
// `<shim> __bcx-exec <plugin name> <plugin args>...`, with the verified binary on fd 3.
const ShimCommand = "__bcx-exec"

// prepare makes cmd run the verified binary from its open file bin (fd 3 in the child, executed as
// /proc/self/fd/3, never by path again), through the shim when there is one, as o.Credential, in
// its own process group and cgroup. release closes what the parent no longer needs once the child
// started.
func prepare(cmd *exec.Cmd, bin *os.File, _ string, name string, o StartOptions, socketDir string) (release func(), err error) {
	cmd.ExtraFiles = []*os.File{bin}
	if o.Shim != "" {
		cmd.Path = o.Shim
		cmd.Args = append([]string{o.Shim, ShimCommand, name}, o.Args...)
	} else {
		cmd.Path = "/proc/self/fd/3"
		cmd.Args = append([]string{name}, o.Args...)
	}
	attr := &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	if c := o.Credential; c != nil {
		// No supplementary groups: none of root's.
		attr.Credential = &syscall.Credential{Uid: c.UID, Gid: c.GID, Groups: []uint32{}}
		// The plugin creates its socket there.
		if err := os.Chown(socketDir, int(c.UID), int(c.GID)); err != nil {
			return nil, err
		}
	}
	release = func() {}
	if o.CgroupDir != "" {
		dir := filepath.Join(o.CgroupDir, "bcx-"+name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("cgroup: %w", err)
		}
		limits := map[string]string{}
		if o.MemoryMax > 0 {
			limits["memory.max"] = strconv.FormatInt(o.MemoryMax, 10)
		}
		if o.PidsMax > 0 {
			limits["pids.max"] = strconv.Itoa(o.PidsMax)
		}
		for file, value := range limits {
			if err := os.WriteFile(filepath.Join(dir, file), []byte(value), 0o644); err != nil {
				return nil, fmt.Errorf("cgroup %s: %w", file, err)
			}
		}
		fd, err := unix.Open(dir, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
		if err != nil {
			return nil, fmt.Errorf("cgroup: %w", err)
		}
		attr.UseCgroupFD, attr.CgroupFD = true, fd
		release = func() { _ = unix.Close(fd) }
	}
	cmd.SysProcAttr = attr
	return release, nil
}

// cgroupRoot is where the cgroup v2 hierarchy is mounted.
const cgroupRoot = "/sys/fs/cgroup"

// ownCgroup is this process's cgroup directory, from /proc/self/cgroup ("0::<path>").
func ownCgroup(procSelfCgroup string) (string, error) {
	for _, line := range strings.Split(procSelfCgroup, "\n") {
		if path, ok := strings.CutPrefix(line, "0::"); ok {
			return filepath.Join(cgroupRoot, path), nil
		}
	}
	return "", errors.New("not on the cgroup v2 hierarchy")
}

// PrepareCgroup readies a delegated cgroup v2 directory for plugins (bcd.service with Delegate=yes):
// it exists, and the memory and pids controllers are enabled in it and in its parent, so each
// plugin's child can be limited. cgroup v2 gives no controllers to the children of a cgroup that
// holds processes itself: when bcd runs directly in the parent (systemd < 254, no
// DelegateSubgroup=main), it first moves itself into a "main" leaf beside the plugins.
func PrepareCgroup(dir string) error {
	if !strings.HasPrefix(filepath.Clean(dir)+"/", cgroupRoot+"/") {
		return fmt.Errorf("cgroup %s is not under %s", dir, cgroupRoot)
	}
	parent := filepath.Dir(filepath.Clean(dir))
	if raw, err := os.ReadFile("/proc/self/cgroup"); err == nil {
		if self, err := ownCgroup(string(raw)); err == nil && filepath.Clean(self) == parent {
			leaf := filepath.Join(parent, "main")
			if err := os.MkdirAll(leaf, 0o755); err != nil {
				return fmt.Errorf("cgroup: %w", err)
			}
			// "0" moves the writing process, all its threads.
			if err := os.WriteFile(filepath.Join(leaf, "cgroup.procs"), []byte("0"), 0o644); err != nil {
				return fmt.Errorf("cgroup: move bcd into %s: %w", leaf, err)
			}
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("cgroup: %w", err)
	}
	for _, d := range []string{parent, dir} {
		if err := os.WriteFile(filepath.Join(d, "cgroup.subtree_control"), []byte("+memory +pids"), 0o644); err != nil {
			return fmt.Errorf("cgroup: enable memory and pids in %s (is it delegated to bcd, Delegate=yes?): %w", d, err)
		}
	}
	return nil
}

// killGroup kills the plugin and whatever it started (its process group).
func killGroup(cmd *exec.Cmd) {
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	_ = cmd.Process.Kill()
}

// RunShim runs inside the plugin's process, before the plugin (args: the plugin's name and
// arguments): no new privileges, the seccomp filter, then the verified binary on fd 3. It returns
// only on failure.
func RunShim(args []string) error {
	if len(args) < 1 {
		return errors.New("bcx shim: no plugin name")
	}
	// no_new_privs and the filter are per thread: everything, the execve included, happens on this
	// one, and the filter is synchronised to every other thread of the process (TSYNC).
	goruntime.LockOSThread()
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return fmt.Errorf("bcx shim: no_new_privs: %w", err)
	}
	if err := installSeccomp(); err != nil {
		return fmt.Errorf("bcx shim: seccomp: %w", err)
	}
	// fd 3 stays open across the exec: a script plugin's interpreter opens /proc/self/fd/3 again.
	return unix.Exec("/proc/self/fd/3", args, os.Environ())
}

// Seccomp return values (linux/seccomp.h).
const (
	seccompRetKillProcess = 0x80000000
	seccompRetErrno       = 0x00050000
	seccompRetAllow       = 0x7fff0000
)

// cloneNewFlags are clone's namespace flags (CLONE_NEWNS, NEWCGROUP, NEWUTS, NEWIPC, NEWUSER,
// NEWPID, NEWNET, NEWTIME): a plugin never makes namespaces, which would open nf_tables and other
// root-in-a-namespace surfaces to it.
const cloneNewFlags = 0x7e020080

// installSeccomp denies what no driver plugin needs and a compromised one could abuse: loading
// kernels and modules, mounts, namespaces (unshare, setns, clone with CLONE_NEW*), swap, reboot,
// eBPF, io_uring, tracing other processes, the kernel keyring, perf, userfaultfd, handle-based
// opens, raw I/O ports, the system clock, accounting and quotas. Denied calls fail with EPERM;
// clone3 fails with ENOSYS (its flags sit in memory a filter cannot read; libc falls back to clone).
// A call from another ABI (x32, a foreign arch) kills the process.
func installSeccomp() error {
	arch, denied, x32 := seccompArch()
	if arch == 0 {
		return nil // no filter for this architecture
	}
	ld := func(k uint32) unix.SockFilter {
		return unix.SockFilter{Code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, K: k}
	}
	ret := func(k uint32) unix.SockFilter { return unix.SockFilter{Code: unix.BPF_RET | unix.BPF_K, K: k} }
	prog := []unix.SockFilter{
		ld(4), // seccomp_data.arch
		{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, Jt: 1, Jf: 0, K: arch},
		ret(seccompRetKillProcess),
		ld(0), // seccomp_data.nr
	}
	if x32 {
		prog = append(prog,
			unix.SockFilter{Code: unix.BPF_JMP | unix.BPF_JGE | unix.BPF_K, Jt: 0, Jf: 1, K: 0x40000000},
			ret(seccompRetKillProcess))
	}
	jump := func(k uint32, jt, jf uint8) unix.SockFilter {
		return unix.SockFilter{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, Jt: jt, Jf: jf, K: k}
	}
	prog = append(prog,
		jump(uint32(unix.SYS_CLONE3), 0, 1),
		ret(seccompRetErrno|uint32(unix.ENOSYS)),
		jump(uint32(unix.SYS_CLONE), 0, 4),
		ld(16), // seccomp_data.args[0], its low 32 bits (little-endian): the clone flags
		unix.SockFilter{Code: unix.BPF_JMP | unix.BPF_JSET | unix.BPF_K, Jt: 0, Jf: 1, K: cloneNewFlags},
		ret(seccompRetErrno|uint32(unix.EPERM)),
		ret(seccompRetAllow))
	for _, nr := range denied {
		prog = append(prog,
			unix.SockFilter{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, Jt: 0, Jf: 1, K: uint32(nr)},
			ret(seccompRetErrno|uint32(unix.EPERM)))
	}
	prog = append(prog, ret(seccompRetAllow))
	fprog := unix.SockFprog{Len: uint16(len(prog)), Filter: &prog[0]}
	_, _, errno := unix.Syscall(unix.SYS_SECCOMP, unix.SECCOMP_SET_MODE_FILTER, unix.SECCOMP_FILTER_FLAG_TSYNC, uintptr(unsafe.Pointer(&fprog)))
	if errno != 0 {
		return errno
	}
	return nil
}
