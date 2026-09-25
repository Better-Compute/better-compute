//go:build !linux

package runtime

import (
	"errors"
	"os"
)

func openTap(string) (*os.File, error) { return nil, errors.New("taps need Linux") }
