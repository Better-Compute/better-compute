package helper

import (
	"net"

	"golang.org/x/sys/unix"
)

// peerCred is the connecting process as the kernel vouches for it (SO_PEERCRED).
func peerCred(c *net.UnixConn) (Peer, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return Peer{}, err
	}
	var cred *unix.Ucred
	var serr error
	if err := raw.Control(func(fd uintptr) {
		cred, serr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return Peer{}, err
	}
	if serr != nil {
		return Peer{}, serr
	}
	return Peer{PID: cred.Pid, UID: cred.Uid, GID: cred.Gid}, nil
}
