//go:build linux

package main

import "golang.org/x/sys/unix"

// kernelClock asks the kernel (adjtimex, read-only) whether an NTP client keeps the clock in sync:
// STA_UNSYNC clear and a state other than TIME_ERROR.
func kernelClock() (bool, string, error) {
	var tx unix.Timex
	state, err := unix.Adjtimex(&tx)
	if err != nil {
		return false, "", err
	}
	synced := tx.Status&unix.STA_UNSYNC == 0 && state != unix.TIME_ERROR
	return synced, clockStatusDetail(synced, int64(tx.Maxerror)), nil
}
