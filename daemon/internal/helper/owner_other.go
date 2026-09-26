//go:build !unix

package helper

import "io/fs"

// rootOnly: the helper runs on Linux only (peer_other.go refuses every peer elsewhere).
func rootOnly(fs.FileInfo) bool { return true }
