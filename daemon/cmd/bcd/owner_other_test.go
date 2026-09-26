//go:build !unix

package main

import "testing"

// ownerOf: no uids off Unix (the tests that need it run as root on Linux only).
func ownerOf(t *testing.T, _ string) string {
	t.Helper()
	t.Skip("file owners need Unix")
	return ""
}
