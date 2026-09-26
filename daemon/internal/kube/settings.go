// Package kube makes a bcd node a Kubernetes worker and gives the cluster exactly the GPUs compute
// bound to it (PLAN.md §3.8):
//
//   - JoinUnit is the `k8s-join` config unit of NodeSpec.host (hostconfig): it installs kubeadm, the
//     kubelet and containerd when missing, sets the kernel prerequisites, joins with a bootstrap token
//     fetched by reference (never carried in the spec), and keeps the Node's labels and taints in step
//     with the kubelet's own credentials;
//   - Plugin is a kubelet device plugin (deviceplugin/v1beta1 over the kubelet's unix sockets, spoken
//     with connect's gRPC protocol and hand-encoded messages, so no Kubernetes modules): it advertises
//     only the devices of holds bound with Binding.KUBERNETES (bcd.dev/gpu, bcd.dev/gpu.mig,
//     bcd.dev/gpu.slot) and answers Allocate with CDI device names;
//   - Reaper deletes the pods still using a device after compute released it (the kubelet's
//     PodResources API names them).
//
// Compute never schedules pods and never runs a control plane: it hands a cluster machines and GPUs
// and takes them back.
package kube

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// UnitName is the config unit's name in NodeSpec.host.
const UnitName = "k8s-join"

// Settings are the k8s-join unit's settings, as provision validates them (config-units.ts
// validateK8sJoin).
type Settings struct {
	// Server is the API server, https://host[:port].
	Server string `json:"server"`
	// CaCertSha256 pins the cluster CA's public key (kubeadm --discovery-token-ca-cert-hash), hex.
	CaCertSha256 string `json:"caCertSha256"`
	// TokenRef names the bootstrap token (secret://, vault://, env://); the daemon fetches it.
	TokenRef string `json:"tokenRef"`
	// KubernetesVersion, e.g. "1.34.1", picks the pkgs.k8s.io repository when the packages are
	// missing.
	KubernetesVersion string            `json:"kubernetesVersion,omitempty"`
	NodeLabels        map[string]string `json:"nodeLabels,omitempty"`
	// Taints are "key[=value]:Effect".
	Taints []string `json:"taints,omitempty"`
	// GPU exposes compute-bound GPUs to the kubelet (default true), through bcd's device plugins or,
	// with GPUAPI "dra", its DRA driver (gpu.bcd.dev ResourceSlices).
	GPU    *bool  `json:"gpu,omitempty"`
	GPUAPI string `json:"gpuApi,omitempty"`
}

var (
	pinPattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	versionPattern = regexp.MustCompile(`^1\.([0-9]{2})\.[0-9]{1,3}$`)
	labelName      = regexp.MustCompile(`^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$`)
	dnsSubdomain   = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)*$`)
	taintPattern   = regexp.MustCompile(`^([^=:]+)(?:=([^:]*))?:(NoSchedule|PreferNoSchedule|NoExecute)$`)
	// A kubeadm bootstrap token.
	tokenPattern = regexp.MustCompile(`^[a-z0-9]{6}\.[a-z0-9]{16}$`)
)

// Taint is one parsed taint.
type Taint struct {
	Key, Value, Effect string
}

func (t Taint) String() string {
	if t.Value == "" {
		return t.Key + ":" + t.Effect
	}
	return t.Key + "=" + t.Value + ":" + t.Effect
}

// parsed is Settings checked again on the node: the control plane validated them, but the daemon
// only acts on what it understands itself (the labels and taints reach command lines and YAML).
type parsed struct {
	Settings
	endpoint string // host:port for kubeadm
	minor    string // "1.34" when KubernetesVersion is set
	taints   []Taint
	gpu      bool
}

func terminal(format string, args ...any) error {
	return converge.Terminal(fmt.Errorf(UnitName+": "+format, args...))
}

// checkLabelKey accepts a Kubernetes label key outside the kubernetes.io and k8s.io prefixes.
func checkLabelKey(key string) error {
	prefix, name, hasPrefix := strings.Cut(key, "/")
	if !hasPrefix {
		name, prefix = key, ""
	}
	if !labelName.MatchString(name) {
		return fmt.Errorf("%q is not a label name", key)
	}
	if hasPrefix {
		if len(prefix) > 253 || !dnsSubdomain.MatchString(prefix) {
			return fmt.Errorf("%q has a prefix that is not a DNS subdomain", key)
		}
		for _, reserved := range []string{"kubernetes.io", "k8s.io"} {
			if prefix == reserved || strings.HasSuffix(prefix, "."+reserved) {
				return fmt.Errorf("%q uses a prefix reserved for Kubernetes", key)
			}
		}
	}
	return nil
}

func checkLabelValue(value string) bool { return value == "" || labelName.MatchString(value) }

func parseSettings(raw json.RawMessage) (*parsed, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = json.RawMessage("{}")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	var s Settings
	if err := d.Decode(&s); err != nil {
		return nil, terminal("settings: %v", err)
	}
	if d.More() {
		return nil, terminal("settings: trailing data")
	}
	p := &parsed{Settings: s, gpu: s.GPU == nil || *s.GPU}
	u, err := url.Parse(s.Server)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" {
		return nil, terminal("server must be https://host[:port], not %q", s.Server)
	}
	host, port := u.Hostname(), u.Port()
	if port == "" {
		port = "443"
	}
	p.endpoint = net.JoinHostPort(host, port)
	p.CaCertSha256 = strings.TrimPrefix(strings.ToLower(s.CaCertSha256), "sha256:")
	if !pinPattern.MatchString(p.CaCertSha256) {
		return nil, terminal("caCertSha256 must be 64 hex digits")
	}
	if s.TokenRef == "" {
		return nil, terminal("tokenRef is required")
	}
	if s.GPUAPI != "" && s.GPUAPI != APIDevicePlugin && s.GPUAPI != APIDRA {
		return nil, terminal("gpuApi must be %q or %q", APIDevicePlugin, APIDRA)
	}
	if s.KubernetesVersion != "" {
		if !versionPattern.MatchString(s.KubernetesVersion) {
			return nil, terminal("kubernetesVersion %q is not a release such as 1.34.1", s.KubernetesVersion)
		}
		major, rest, _ := strings.Cut(s.KubernetesVersion, ".")
		minor, _, _ := strings.Cut(rest, ".")
		p.minor = major + "." + minor
	}
	if len(s.NodeLabels) > 64 {
		return nil, terminal("more than 64 nodeLabels")
	}
	for k, v := range s.NodeLabels {
		if err := checkLabelKey(k); err != nil {
			return nil, terminal("nodeLabels: %v", err)
		}
		if !checkLabelValue(v) {
			return nil, terminal("nodeLabels: the value of %s is not a label value", k)
		}
	}
	seen := map[string]bool{}
	for _, t := range s.Taints {
		m := taintPattern.FindStringSubmatch(t)
		if m == nil {
			return nil, terminal("taint %q is not key[=value]:Effect", t)
		}
		if err := checkLabelKey(m[1]); err != nil {
			return nil, terminal("taint %q: %v", t, err)
		}
		if !checkLabelValue(m[2]) {
			return nil, terminal("taint %q: the value is not a label value", t)
		}
		if seen[m[1]+":"+m[3]] {
			return nil, terminal("taint %s:%s is listed twice", m[1], m[3])
		}
		seen[m[1]+":"+m[3]] = true
		p.taints = append(p.taints, Taint{Key: m[1], Value: m[2], Effect: m[3]})
	}
	sort.Slice(p.taints, func(i, j int) bool { return p.taints[i].String() < p.taints[j].String() })
	return p, nil
}
