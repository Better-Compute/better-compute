package bcx

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/better-compute/better-compute/daemon/gen/bettercompute/driver/v1/driverv1connect"
)

// Serve runs a Go plugin: it checks the magic cookie, listens on a unix socket in the host's
// directory with mTLS pinned to the host's certificate, prints the handshake line on out and serves
// the DriverPlugin service until ctx is done.
func Serve(ctx context.Context, impl driverv1connect.DriverPluginHandler, out io.Writer) error {
	if os.Getenv(MagicCookieKey) != MagicCookieValue {
		return errors.New("bcx: this is a better-compute driver plugin; bcd runs it, not a shell")
	}
	hostCert, err := certFromPEM(os.Getenv(ClientCertEnv))
	if err != nil {
		return err
	}
	dir := os.Getenv(SocketDirEnv)
	if dir == "" {
		return errors.New("bcx: no socket directory")
	}
	server, err := newIdentity("bcx-plugin")
	if err != nil {
		return err
	}
	socket := filepath.Join(dir, "plugin.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		return err
	}
	_ = os.Chmod(socket, 0o600)
	tlsLn := tls.NewListener(ln, &tls.Config{
		MinVersion:            tls.VersionTLS12,
		Certificates:          []tls.Certificate{server.tls},
		ClientAuth:            tls.RequireAnyClientCert,
		VerifyPeerCertificate: pinned(hostCert),
		NextProtos:            []string{"h2"},
	})
	mux := http.NewServeMux()
	mux.Handle(driverv1connect.NewDriverPluginHandler(impl))
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second, Protocols: new(http.Protocols)}
	srv.Protocols.SetHTTP2(true)
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	if _, err := fmt.Fprintln(out, Handshake{Network: "unix", Address: socket, Certificate: server.der}.Format()); err != nil {
		return err
	}
	if err := srv.Serve(tlsLn); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
