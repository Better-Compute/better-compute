//go:build !linux

package main

import "errors"

// reexec is Linux-only: bcd runs on Linux.
func reexec() error { return errors.New("bcd: restarting in place needs Linux") }

func execInto(string) error { return errors.New("bcd: restarting in place needs Linux") }
