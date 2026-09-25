package agent

import (
	"fmt"
	"os"
	osexec "os/exec"
	"strconv"
	"syscall"
	"unsafe"
)

func ioctl(fd, req, arg uintptr) error {
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, req, arg); errno != 0 {
		return errno
	}
	return nil
}

// startPTY starts cmd on a new pseudo-terminal (/dev/ptmx), as its session leader with the terminal
// as controlling tty, and returns the master side.
func startPTY(cmd *osexec.Cmd) (*os.File, error) {
	ptmx, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	var unlock int32
	if err := ioctl(ptmx.Fd(), syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock))); err != nil {
		ptmx.Close()
		return nil, fmt.Errorf("unlock pty: %w", err)
	}
	var n uint32
	if err := ioctl(ptmx.Fd(), syscall.TIOCGPTN, uintptr(unsafe.Pointer(&n))); err != nil {
		ptmx.Close()
		return nil, fmt.Errorf("pty number: %w", err)
	}
	tty, err := os.OpenFile("/dev/pts/"+strconv.Itoa(int(n)), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		ptmx.Close()
		return nil, err
	}
	defer tty.Close()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = tty, tty, tty
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		ptmx.Close()
		return nil, err
	}
	return ptmx, nil
}

// setWinsize sets the terminal size (TIOCSWINSZ); the shell gets SIGWINCH.
func setWinsize(pty *os.File, rows, cols uint32) error {
	ws := struct{ Row, Col, X, Y uint16 }{Row: uint16(rows), Col: uint16(cols)}
	return ioctl(pty.Fd(), syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
}

// hangupGroup sends SIGHUP to a session's process group, as a closed terminal would.
func hangupGroup(pid int) { _ = syscall.Kill(-pid, syscall.SIGHUP) }
