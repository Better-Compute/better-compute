//go:build unix

package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"syscall"
	"time"
)

// sendFile writes msg with f's descriptor attached (SCM_RIGHTS).
func sendFile(conn *net.UnixConn, msg []byte, f *os.File) error {
	_, _, err := conn.WriteMsgUnix(msg, syscall.UnixRights(int(f.Fd())), nil)
	return err
}

// openPty opens a console pty for the node: a pty slave (character device, Unix98 major 136-143),
// never a controlling terminal of the helper.
func openPty(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	st, ok := fi.Sys().(*syscall.Stat_t)
	if err != nil || !ok || fi.Mode()&os.ModeCharDevice == 0 || major(uint64(st.Rdev)) < 136 || major(uint64(st.Rdev)) > 143 {
		f.Close()
		return nil, fmt.Errorf("%s is not a pty", path)
	}
	return f, nil
}

// major is a Linux device number's major part.
func major(dev uint64) uint64 { return ((dev >> 8) & 0xfff) | ((dev >> 32) &^ 0xfff) }

// callForFile sends one request whose answer carries a descriptor.
func (c Client) callForFile(ctx context.Context, req Request) (*os.File, error) {
	req.V = Version
	timeout := c.Timeout
	if timeout == 0 {
		timeout = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var d net.Dialer
	raw, err := d.DialContext(ctx, "unix", c.Socket)
	if err != nil {
		return nil, fmt.Errorf("helper: %w", err)
	}
	conn := raw.(*net.UnixConn)
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return nil, fmt.Errorf("helper: %w", err)
	}
	buf := make([]byte, 64<<10)
	oob := make([]byte, syscall.CmsgSpace(4))
	n, oobn, _, _, err := conn.ReadMsgUnix(buf, oob)
	if err != nil {
		return nil, fmt.Errorf("helper: %w", err)
	}
	var files []*os.File
	if msgs, err := syscall.ParseSocketControlMessage(oob[:oobn]); err == nil {
		for _, m := range msgs {
			if fds, err := syscall.ParseUnixRights(&m); err == nil {
				for _, fd := range fds {
					files = append(files, os.NewFile(uintptr(fd), "helper-console"))
				}
			}
		}
	}
	closeAll := func() {
		for _, f := range files {
			f.Close()
		}
	}
	dec := json.NewDecoder(bytes.NewReader(buf[:n]))
	dec.DisallowUnknownFields()
	var resp Response
	if err := dec.Decode(&resp); err != nil {
		closeAll()
		return nil, fmt.Errorf("helper: %w", err)
	}
	if resp.V != Version || !resp.OK {
		closeAll()
		if resp.Error != "" {
			return nil, fmt.Errorf("helper: %s", resp.Error)
		}
		return nil, errors.New("helper: no answer")
	}
	if len(files) != 1 {
		closeAll()
		return nil, errors.New("helper: the answer carries no descriptor")
	}
	return files[0], nil
}
