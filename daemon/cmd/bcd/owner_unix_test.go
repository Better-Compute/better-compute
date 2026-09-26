//go:build unix

package main

import (
	"os"
	"strconv"
	"syscall"
	"testing"
)

// ownerOf is a file's owner uid.
func ownerOf(t *testing.T, path string) string {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return strconv.FormatUint(uint64(fi.Sys().(*syscall.Stat_t).Uid), 10)
}
