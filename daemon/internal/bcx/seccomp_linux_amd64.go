//go:build linux && amd64

package bcx

import "golang.org/x/sys/unix"

func seccompArch() (arch uint32, denied []uintptr, x32 bool) {
	return unix.AUDIT_ARCH_X86_64, []uintptr{
		unix.SYS_KEXEC_LOAD, unix.SYS_KEXEC_FILE_LOAD,
		unix.SYS_INIT_MODULE, unix.SYS_FINIT_MODULE, unix.SYS_DELETE_MODULE,
		unix.SYS_MOUNT, unix.SYS_UMOUNT2, unix.SYS_PIVOT_ROOT, unix.SYS_FSOPEN, unix.SYS_FSMOUNT,
		unix.SYS_FSCONFIG, unix.SYS_MOVE_MOUNT, unix.SYS_OPEN_TREE,
		unix.SYS_SWAPON, unix.SYS_SWAPOFF, unix.SYS_REBOOT,
		unix.SYS_BPF, unix.SYS_PTRACE, unix.SYS_PROCESS_VM_READV, unix.SYS_PROCESS_VM_WRITEV,
		unix.SYS_KEYCTL, unix.SYS_ADD_KEY, unix.SYS_REQUEST_KEY,
		unix.SYS_PERF_EVENT_OPEN, unix.SYS_USERFAULTFD, unix.SYS_OPEN_BY_HANDLE_AT,
		unix.SYS_IOPL, unix.SYS_IOPERM,
		unix.SYS_SETTIMEOFDAY, unix.SYS_CLOCK_SETTIME, unix.SYS_CLOCK_ADJTIME, unix.SYS_ADJTIMEX,
		unix.SYS_ACCT, unix.SYS_QUOTACTL, unix.SYS_LOOKUP_DCOOKIE, unix.SYS_SYSLOG,
	}, true
}
