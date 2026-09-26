package kube

import (
	"fmt"
	"net/url"
	"strings"
)

// Cluster is a cluster this node may join: its API server and CA pin.
type Cluster struct {
	Server       string
	CaCertSha256 string
}

// ParseAllowedClusters reads bcd's [kubernetes] allowed_clusters: comma-separated
// "https://host[:port]#sha256:<hex>" entries (the pin may omit "sha256:"). Empty is none.
func ParseAllowedClusters(s string) ([]Cluster, error) {
	var out []Cluster
	for _, entry := range strings.Split(s, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		server, pin, ok := strings.Cut(entry, "#")
		pin = strings.TrimPrefix(strings.ToLower(pin), "sha256:")
		u, err := url.Parse(server)
		if !ok || err != nil || u.Scheme != "https" || u.Host == "" || (u.Path != "" && u.Path != "/") || !pinPattern.MatchString(pin) {
			return nil, fmt.Errorf("[kubernetes] allowed_clusters: %q is not https://host[:port]#sha256:<64 hex>", entry)
		}
		out = append(out, Cluster{Server: normalServer(u), CaCertSha256: pin})
	}
	return out, nil
}

// normalServer spells an API server https://host:port.
func normalServer(u *url.URL) string {
	port := u.Port()
	if port == "" {
		port = "443"
	}
	host := u.Hostname()
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return "https://" + host + ":" + port
}

// allowedCluster checks the settings against the allowlist. With RequireAllowed (bcd helper: the
// join runs as root on a request from the unprivileged node), an empty list refuses every join:
// joining a cluster hands it root on this machine (privileged pods), so root decides which.
func (u JoinUnit) allowedCluster(p *parsed) error {
	if len(u.Allowed) == 0 {
		if u.RequireAllowed {
			return terminal("joining a Kubernetes cluster needs [kubernetes] allowed_clusters in bcd's config (root decides which clusters get this machine)")
		}
		return nil
	}
	server, err := url.Parse(p.Server)
	if err != nil {
		return terminal("server: %v", err)
	}
	want := normalServer(server)
	for _, c := range u.Allowed {
		if c.Server == want && c.CaCertSha256 == p.CaCertSha256 {
			return nil
		}
	}
	return terminal("%s (CA sha256:%s…) is not in [kubernetes] allowed_clusters", want, p.CaCertSha256[:12])
}
