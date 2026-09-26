//go:build !linux

package tpm

import "errors"

// DefaultDevice is the kernel's TPM resource manager on Linux.
const DefaultDevice = "/dev/tpmrm0"

// Device is a TPM character device (Linux only).
type Device struct{}

// OpenDevice fails: TPM devices are Linux's here.
func OpenDevice(string) (*Device, error) { return nil, errors.New("tpm: TPM devices need Linux") }

func (d *Device) Send([]byte) ([]byte, error) { return nil, errors.New("tpm: TPM devices need Linux") }

func (d *Device) Close() error { return nil }
