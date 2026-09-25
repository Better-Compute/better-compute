//go:build unix

package runtime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"syscall"
	"time"
)

// unixAPI calls a VMM's API over its unix socket. files go with the request as SCM_RIGHTS in the
// same write as its first bytes, which is where cloud-hypervisor reads them (vm.add-net's and
// vm.restore's net fds).
func unixAPI(ctx context.Context, socket, method, path string, body any, files []*os.File) ([]byte, int, error) {
	var payload []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		payload = b
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://localhost"+path, bytes.NewReader(payload))
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Close = true
	var raw bytes.Buffer
	if err := req.Write(&raw); err != nil {
		return nil, 0, err
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, 0, err
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(5 * time.Minute))
	}
	uc := conn.(*net.UnixConn)
	var oob []byte
	if len(files) > 0 {
		fds := make([]int, len(files))
		for i, f := range files {
			fds[i] = int(f.Fd())
		}
		oob = syscall.UnixRights(fds...)
	}
	if _, _, err := uc.WriteMsgUnix(raw.Bytes(), oob, nil); err != nil {
		return nil, 0, err
	}
	resp, err := http.ReadResponse(bufio.NewReader(uc), req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	return out, resp.StatusCode, err
}
