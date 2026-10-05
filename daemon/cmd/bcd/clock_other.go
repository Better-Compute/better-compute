//go:build !linux

package main

import "errors"

// kernelClock: bcd runs on Linux; other builds (go vet on Windows) cannot ask the kernel.
func kernelClock() (bool, string, error) {
	return false, "", errors.New("clock status is read on Linux only")
}
