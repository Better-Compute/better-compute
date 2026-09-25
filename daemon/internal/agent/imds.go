package agent

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/imds"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// IMDS is the host's metadata service over this agent's instances: a request is from the running
// instance that holds its source address, and its workload token is minted by the control plane
// through a node-signed WorkloadTokenRequest.
func (a *Agent) IMDS() *imds.Service {
	return imds.New(a.instanceOf, func(ctx context.Context, instanceID, audience string) (string, error) {
		token, _, err := a.RequestWorkloadToken(ctx, instanceID, audience)
		if errors.Is(err, pki.ErrRefused) {
			// "pki: refused: <code>" → the code the metadata service maps to a status.
			msg := err.Error()
			return "", imds.Refusal(msg[strings.LastIndex(msg, ": ")+2:])
		}
		return token, err
	})
}

// instanceOf maps a request's source address to the running instance holding it.
func (a *Agent) instanceOf(r *http.Request) (string, bool) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return "", false
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return "", false
	}
	for _, rt := range a.o.Runtimes {
		domains, err := rt.List(r.Context())
		if err != nil {
			continue
		}
		for _, d := range domains {
			if !d.Managed || d.State != runtime.StateRunning {
				continue
			}
			for _, cidr := range d.Addresses {
				addr, _, err := net.ParseCIDR(cidr)
				if err != nil {
					addr = net.ParseIP(cidr)
				}
				if addr != nil && addr.Equal(ip) {
					return d.ID, true
				}
			}
		}
	}
	return "", false
}

// ServeIMDS serves the metadata service on listen (the host's link-local metadata address) until
// ctx is done.
func (a *Agent) ServeIMDS(ctx context.Context, listen string) error {
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: a.IMDS(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	a.log.Info("metadata service listening", "addr", ln.Addr().String())
	if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
