//go:build linux && (amd64 || arm64 || ppc64le || riscv64 || s390x || loong64)

package inventory

import (
	"errors"
	"runtime"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// The kernel's IPMI device interface (linux/ipmi.h). Pointer fields are unsafe.Pointer so the
// buffers they name stay on the heap while the kernel reads and writes them.
type ipmiMsg struct {
	Netfn   uint8
	Cmd     uint8
	DataLen uint16
	Data    unsafe.Pointer
}

type ipmiReq struct {
	Addr    unsafe.Pointer
	AddrLen uint32
	Msgid   int64
	Msg     ipmiMsg
}

type ipmiRecv struct {
	RecvType int32
	Addr     unsafe.Pointer
	AddrLen  uint32
	Msgid    int64
	Msg      ipmiMsg
}

// ipmiSystemInterfaceAddr addresses the BMC itself (IPMI_SYSTEM_INTERFACE_ADDR_TYPE, IPMI_BMC_CHANNEL).
type ipmiSystemInterfaceAddr struct {
	AddrType int32
	Channel  int16
	Lun      uint8
	_        uint8
}

const (
	ipmiMagic        = 'i'
	ipmiResponseRecv = 1
	ipmiMaxAddr      = 32
	ipmiMaxMsg       = 272
)

func ioc(dir, nr, size uintptr) uintptr { return dir<<30 | size<<16 | ipmiMagic<<8 | nr }

var (
	ipmictlSendCommand     = ioc(2, 13, unsafe.Sizeof(ipmiReq{}))  // _IOR
	ipmictlReceiveMsgTrunc = ioc(3, 11, unsafe.Sizeof(ipmiRecv{})) // _IOWR
)

var (
	_ [40]byte = [unsafe.Sizeof(ipmiReq{})]byte{}
	_ [48]byte = [unsafe.Sizeof(ipmiRecv{})]byte{}
)

// ipmiDevice is the one place bcd writes to the IPMI device: every request is checked against
// ipmiAllowed first, and the device is opened for that request only.
type ipmiDevice struct {
	path  string
	msgid int64
}

func (d *ipmiDevice) request(netfn, cmd byte, data []byte) ([]byte, error) {
	if err := ipmiAllowed(netfn, cmd, data); err != nil {
		return nil, err
	}
	fd, err := unix.Open(d.path, unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	return d.exchange(fd, netfn, cmd, data)
}

func (d *ipmiDevice) exchange(fd int, netfn, cmd byte, data []byte) ([]byte, error) {
	addr := &ipmiSystemInterfaceAddr{AddrType: 0x0c, Channel: 0x0f}
	d.msgid++
	req := &ipmiReq{Addr: unsafe.Pointer(addr), AddrLen: uint32(unsafe.Sizeof(*addr)), Msgid: d.msgid,
		Msg: ipmiMsg{Netfn: netfn, Cmd: cmd, DataLen: uint16(len(data))}}
	buf := make([]byte, ipmiMaxMsg)
	copy(buf, data)
	if len(data) > 0 {
		req.Msg.Data = unsafe.Pointer(&buf[0])
	}
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), ipmictlSendCommand, uintptr(unsafe.Pointer(req))); errno != 0 {
		return nil, errno
	}
	runtime.KeepAlive(addr)
	deadline := time.Now().Add(5 * time.Second)
	for {
		left := time.Until(deadline)
		if left <= 0 {
			return nil, errors.New("ipmi: no response from the BMC within 5s")
		}
		fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
		if n, err := unix.Poll(fds, int(left/time.Millisecond)+1); err != nil && err != unix.EINTR {
			return nil, err
		} else if n == 0 {
			continue
		}
		raddr := make([]byte, ipmiMaxAddr)
		resp := make([]byte, ipmiMaxMsg)
		recv := &ipmiRecv{Addr: unsafe.Pointer(&raddr[0]), AddrLen: ipmiMaxAddr, Msg: ipmiMsg{Data: unsafe.Pointer(&resp[0]), DataLen: ipmiMaxMsg}}
		_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), ipmictlReceiveMsgTrunc, uintptr(unsafe.Pointer(recv)))
		runtime.KeepAlive(raddr)
		runtime.KeepAlive(resp)
		if errno != 0 && errno != unix.EMSGSIZE {
			if errno == unix.EAGAIN || errno == unix.EINTR {
				continue
			}
			return nil, errno
		}
		// Events and stale answers from an earlier request are skipped.
		if recv.RecvType != ipmiResponseRecv || recv.Msgid != d.msgid {
			continue
		}
		return resp[:min(int(recv.Msg.DataLen), len(resp))], nil
	}
}

// IPMIBMC asks the BMC through the kernel's IPMI interface (/dev/ipmi0; root) for its vendor,
// firmware, MAC and address. nil without an IPMI interface or privilege.
func IPMIBMC() *BmcSection {
	if err := unix.Access("/dev/ipmi0", unix.R_OK|unix.W_OK); err != nil {
		return nil
	}
	s, err := queryBMC(&ipmiDevice{path: "/dev/ipmi0"})
	if err != nil {
		return nil
	}
	return s
}
