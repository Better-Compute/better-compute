package agent

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/imds"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// IMDS is the host's metadata service over this agent's instances: a request is from the running
// instance that holds its source address, and its workload token is minted by the control plane
// through a node-signed WorkloadTokenRequest.
//
// A guest decides how often it asks. Its requests are limited per instance before anything is
// looked up (imds.Service.Claim: the firewall's own binding of the address), the running instances'
// addresses are read from the runtimes at most every few seconds (runningAt), and a mint that the
// session cannot carry now is a 503 to the guest, never a reason to drop the host's session.
func (a *Agent) IMDS() *imds.Service {
	s := imds.New(a.instanceOf, func(ctx context.Context, instanceID, audience string) (string, error) {
		token, _, err := a.RequestWorkloadToken(ctx, instanceID, audience)
		if errors.Is(err, pki.ErrRefused) {
			// "pki: refused: <code>" → the code the metadata service maps to a status.
			msg := err.Error()
			return "", imds.Refusal(msg[strings.LastIndex(msg, ": ")+2:])
		}
		if errors.Is(err, ErrUnavailable) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			return "", imds.ErrUnavailable
		}
		return token, err
	})
	s.Claim = func(r *http.Request) (string, bool) {
		_, owner, ok := a.boundInstance(r)
		return owner, ok
	}
	return s
}

// boundInstance is the instance the loaded anti-spoofing rules bind a request's source address to:
// a map lookup, no runtime asked. The address is only trusted while those rules are loaded (an
// instance cannot send from another's address); a host-local (loopback) caller is never an
// instance, and an address no rule binds to a tap names nobody.
func (a *Agent) boundInstance(r *http.Request) (ip net.IP, owner string, ok bool) {
	if !a.spoofGuard.Load() {
		return nil, "", false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return nil, "", false
	}
	ip = net.ParseIP(host)
	if ip == nil || ip.IsLoopback() || ip.IsUnspecified() {
		return nil, "", false
	}
	a.mu.Lock()
	owner = a.guarded[ip.String()]
	a.mu.Unlock()
	return ip, owner, owner != ""
}

// instanceOf maps a request's source address to the running instance holding it: the one the
// rules bind the address to, when the runtimes say that instance runs with it. An address two
// running instances hold names neither.
func (a *Agent) instanceOf(r *http.Request) (string, bool) {
	ip, owner, ok := a.boundInstance(r)
	if !ok {
		return "", false
	}
	found, ok := a.runningAt(ip.String())
	return found, ok && found == owner
}

// The running instances' addresses are read from the runtimes (a virsh or VMM call per domain) and
// kept for imdsAddressTTL: metadata requests, the unauthenticated token PUT included, do not each
// list every runtime. An address the kept map does not know is looked for again once the map is
// imdsAddressRefresh old, so an instance that just started is found, and a flood of misses still
// lists at most twice a second.
const (
	imdsAddressTTL     = 5 * time.Second
	imdsAddressRefresh = 500 * time.Millisecond
)

// addressCache is the running instances by address ("" for an address two of them hold).
type addressCache struct {
	mu      sync.Mutex
	at      time.Time
	holders map[string]string
}

// runningAt names the running managed instance that holds address.
func (a *Agent) runningAt(address string) (string, bool) {
	c := &a.imdsAddresses
	c.mu.Lock()
	defer c.mu.Unlock()
	id, known := c.holders[address]
	if age := time.Since(c.at); c.holders == nil || age > imdsAddressTTL || (!known && age > imdsAddressRefresh) {
		c.holders, c.at = a.runningAddresses(), time.Now()
		id, known = c.holders[address]
	}
	return id, known && id != ""
}

// runningAddresses lists every runtime once: each running managed instance's addresses.
func (a *Agent) runningAddresses() map[string]string {
	// Not a request's context: one guest hanging up must not leave everyone a half-read map.
	parent := a.ctx
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	holders := map[string]string{}
	for _, rt := range a.o.Runtimes {
		domains, err := rt.List(ctx)
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
				if addr == nil {
					continue
				}
				key := addr.String()
				if other, taken := holders[key]; taken && other != d.ID {
					if other != "" {
						a.log.Warn("metadata requests refused: two instances hold one address", "address", key, "instances", other+","+d.ID)
					}
					holders[key] = ""
					continue
				}
				holders[key] = d.ID
			}
		}
	}
	return holders
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
