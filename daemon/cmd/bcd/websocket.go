package main

import (
	"context"
	"crypto"
	"crypto/x509"
	"errors"
	"fmt"
	"os"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/agent"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/transport"
)

// useWebSocket switches the agent's session and renewals to the WebSocket fallback ([websocket],
// PLAN.md §7.1). Every dial takes the running agent's identity (current), so a renewal takes
// effect at the next one. Tunnels need the gRPC transport and are refused.
func useWebSocket(o *agent.Options, cfg *config.Config, current func() (*agent.State, crypto.Signer)) error {
	pin, err := config.DecodePin(cfg.ServingCASPKIPin)
	if err != nil {
		return err
	}
	base := transport.WSOptions{URL: cfg.WebSocket.URL, ServingCAPin: pin, Audience: cfg.WebSocket.Audience, ServerName: cfg.GatewayServerName}
	if cfg.WebSocket.Audience == "" && cfg.GatewayServerName != "" {
		base.Audience = cfg.GatewayServerName
	}
	if file := cfg.WebSocket.ProxyCAFile; file != "" {
		pem, err := os.ReadFile(file)
		if err != nil {
			return fmt.Errorf("websocket.proxy_ca_file: %w", err)
		}
		base.ProxyRoots = x509.NewCertPool()
		if !base.ProxyRoots.AppendCertsFromPEM(pem) {
			return fmt.Errorf("websocket.proxy_ca_file: %s holds no PEM certificate", file)
		}
	}
	// The running agent's identity: renewal replaces it in memory. Never LoadState here: it discards a
	// node.key.next that a renewal in flight has written.
	identity := func() (transport.WSOptions, *agent.State, error) {
		state, key := current()
		if state == nil || key == nil {
			return transport.WSOptions{}, nil, errors.New("no identity yet")
		}
		ws := base
		ws.NodeID, ws.Key, ws.Chain = state.NodeID, key, state.Chain
		return ws, state, nil
	}
	o.Dial = func(ctx context.Context) (agent.Stream, error) {
		ws, state, err := identity()
		if err != nil {
			return nil, err
		}
		if len(state.TrustRoots) == 0 {
			// The gateway sends a WS session only signed intent; without roots bcd could verify none.
			return nil, errors.New("the WebSocket fallback needs command-signing roots (every command and spec signed)")
		}
		return transport.DialSession(ctx, ws)
	}
	o.DialTunnel = nil
	o.Renewer = wsRenewer{identity: identity}
	o.OnRenewed = nil // no gRPC client to rebuild: the next dial reads the renewed identity
	return nil
}

// wsRenewer renews over the WS endpoint (POST /v1/renew): a proxy that strips client
// certificates breaks the gRPC Renew.
type wsRenewer struct {
	identity func() (transport.WSOptions, *agent.State, error)
}

func (r wsRenewer) Renew(ctx context.Context, req *agentv1.RenewRequest) (*agentv1.RenewResponse, error) {
	ws, _, err := r.identity()
	if err != nil {
		return nil, err
	}
	return transport.RenewOverWS(ctx, ws, req)
}
