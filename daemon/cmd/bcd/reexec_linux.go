package main

import (
	"os"
	"syscall"
)

// reexec replaces the process with a fresh copy of itself (a fakehw "reboot"). Go opens files
// close-on-exec, so the journal's lock is released.
func reexec() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return syscall.Exec(exe, os.Args, os.Environ())
}

// execInto replaces the process with the binary at path (the self-update entrypoint), same
// arguments and environment.
func execInto(path string) error {
	return syscall.Exec(path, os.Args, os.Environ())
}
