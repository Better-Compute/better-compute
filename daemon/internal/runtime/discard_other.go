//go:build !linux

package runtime

import "os"

// discard: volumes live on Linux hosts only.
func discard(*os.File, int64) error { return nil }
