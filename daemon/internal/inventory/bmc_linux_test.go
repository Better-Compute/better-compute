//go:build linux && (amd64 || arm64 || ppc64le || riscv64 || s390x || loong64)

package inventory

import (
	"errors"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// The device layer refuses a command outside the allowlist before it opens the device; an allowed
// one gets as far as the open.
func TestIPMIDeviceRefusesSetsBeforeTheDevice(t *testing.T) {
	d := &ipmiDevice{path: filepath.Join(t.TempDir(), "ipmi0")}
	if _, err := d.request(0x0c, 0x01, []byte{1, 3, 10, 0, 0, 9}); err == nil || !strings.Contains(err.Error(), "not a command bcd sends") {
		t.Fatalf("Set LAN Configuration Parameters: %v", err)
	}
	if _, err := d.request(0x00, 0x02, []byte{0}); err == nil || !strings.Contains(err.Error(), "not a command bcd sends") {
		t.Fatalf("Chassis Control: %v", err)
	}
	if _, err := d.request(0x06, 0x01, nil); !errors.Is(err, syscall.ENOENT) {
		t.Fatalf("Get Device ID without a device: %v", err)
	}
}
