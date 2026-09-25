//go:build !unix

package runtime

import (
	"context"
	"errors"
	"os"
)

func unixAPI(context.Context, string, string, string, any, []*os.File) ([]byte, int, error) {
	return nil, 0, errors.New("cloud-hypervisor needs Linux")
}
