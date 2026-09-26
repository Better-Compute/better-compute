//go:build linux

package tpm

import (
	"fmt"
	"os"
)

// DefaultDevice is the kernel's TPM resource manager: each open file has its own sessions and
// transient objects, flushed when it closes.
const DefaultDevice = "/dev/tpmrm0"

// Device is a TPM character device.
type Device struct{ f *os.File }

// OpenDevice opens a TPM character device (DefaultDevice).
func OpenDevice(path string) (*Device, error) {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	return &Device{f: f}, nil
}

// Send writes one command and reads its whole response (the device answers in one read).
func (d *Device) Send(command []byte) ([]byte, error) {
	if _, err := d.f.Write(command); err != nil {
		return nil, err
	}
	buf := make([]byte, 4096)
	n, err := d.f.Read(buf)
	if err != nil {
		return nil, fmt.Errorf("read the response: %w", err)
	}
	return buf[:n], nil
}

func (d *Device) Close() error { return d.f.Close() }
