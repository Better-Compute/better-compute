//go:build !linux

package helper

import (
	"errors"
	"net"
)

// peerCred needs SO_PEERCRED: the helper runs on Linux only.
func peerCred(*net.UnixConn) (Peer, error) {
	return Peer{}, errors.New("helper: SO_PEERCRED needs Linux")
}
