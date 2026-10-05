//go:build linux

package inventory

import (
	"runtime"
	"unsafe"

	"golang.org/x/sys/unix"
)

// nvmeAdminCmd is the kernel's struct nvme_admin_cmd (linux/nvme_ioctl.h), 72 bytes.
type nvmeAdminCmd struct {
	Opcode      uint8
	Flags       uint8
	Rsvd1       uint16
	Nsid        uint32
	Cdw2, Cdw3  uint32
	Metadata    uint64
	Addr        uint64
	MetadataLen uint32
	DataLen     uint32
	Cdw10       uint32
	Cdw11       uint32
	Cdw12       uint32
	Cdw13       uint32
	Cdw14       uint32
	Cdw15       uint32
	TimeoutMs   uint32
	Result      uint32
}

// nvmeIoctlAdminCmd is _IOWR('N', 0x41, struct nvme_admin_cmd).
const nvmeIoctlAdminCmd = 0xC0484E41

var _ [72]byte = [unsafe.Sizeof(nvmeAdminCmd{})]byte{}

// NVMeHealth reads a controller's SMART / Health Information log page (Get Log Page, log 0x02, the
// controller-wide namespace). Read-only; it needs root (the controller device is 0600). nil when the
// device cannot be opened or the command fails.
func NVMeHealth(controller string) *SmartStatus {
	if !nvmeController.MatchString(controller) {
		return nil
	}
	fd, err := unix.Open("/dev/"+controller, unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil
	}
	defer unix.Close(fd)
	page := make([]byte, 512)
	cmd := nvmeAdminCmd{
		Opcode:    0x02, // Get Log Page
		Nsid:      0xffffffff,
		Addr:      uint64(uintptr(unsafe.Pointer(&page[0]))),
		DataLen:   uint32(len(page)),
		Cdw10:     uint32(len(page)/4-1)<<16 | 0x02, // NUMDL (dwords - 1), log id
		TimeoutMs: 5000,
	}
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), nvmeIoctlAdminCmd, uintptr(unsafe.Pointer(&cmd)))
	runtime.KeepAlive(page)
	if errno != 0 {
		return nil
	}
	return parseNVMeHealth(page)
}
