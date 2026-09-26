//go:build !unix

package helper

import (
	"context"
	"errors"
	"net"
	"os"
)

// The helper runs on Linux only; elsewhere descriptors are not passed.
func sendFile(*net.UnixConn, []byte, *os.File) error { return errors.New("helper: needs Linux") }

func openPty(string) (*os.File, error) { return nil, errors.New("helper: needs Linux") }

func (c Client) callForFile(context.Context, Request) (*os.File, error) {
	return nil, errors.New("helper: needs Linux")
}
