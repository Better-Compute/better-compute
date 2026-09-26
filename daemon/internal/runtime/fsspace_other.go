//go:build !linux

package runtime

import (
	"errors"
	"os"
)

// statfsBytes: volumes live on Linux hosts only (no space check elsewhere).
func statfsBytes(string) (uint64, uint64, error) { return 0, 0, errors.ErrUnsupported }

func allocatedBytes(info os.FileInfo) uint64 { return uint64(info.Size()) }
