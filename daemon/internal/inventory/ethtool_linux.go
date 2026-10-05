//go:build linux

package inventory

import (
	"strings"

	"golang.org/x/sys/unix"
)

// EthtoolFirmware asks a NIC's driver for its firmware version (ETHTOOL_GDRVINFO, what `ethtool -i`
// prints as firmware-version): no privilege needed. "" when the driver reports none or the
// interface is gone.
func EthtoolFirmware(ifname string) string {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return ""
	}
	defer unix.Close(fd)
	info, err := unix.IoctlGetEthtoolDrvinfo(fd, ifname)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(unix.ByteSliceToString(info.Fw_version[:]))
}
