//go:build linux

package runtime

import (
	"os"
	"unsafe"

	"golang.org/x/sys/unix"
)

// openTap opens a queue of an existing persistent tap (TUNSETIFF by name): what a VMM is handed,
// so it never needs CAP_NET_ADMIN. IFF_VNET_HDR: cloud-hypervisor sets the header size itself.
func openTap(name string) (*os.File, error) {
	fd, err := unix.Open("/dev/net/tun", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	var ifr [unix.IFNAMSIZ + 64]byte
	copy(ifr[:unix.IFNAMSIZ-1], name)
	*(*uint16)(unsafe.Pointer(&ifr[unix.IFNAMSIZ])) = unix.IFF_TAP | unix.IFF_NO_PI | unix.IFF_VNET_HDR
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), unix.TUNSETIFF, uintptr(unsafe.Pointer(&ifr[0]))); errno != 0 {
		unix.Close(fd)
		return nil, errno
	}
	return os.NewFile(uintptr(fd), "tap:"+name), nil
}
