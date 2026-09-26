package kube

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/converge"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
)

// Host paths the join unit owns or reads.
const (
	// KubeletConf is the kubelet's kubeconfig, written by kubeadm join: its presence means joined.
	KubeletConf = "/etc/kubernetes/kubelet.conf"
	// StateFile records what the unit manages: the cluster, the Node name, the labels and taints it
	// set, and whether the device plugin may run (Manager reads it, unprivileged: 0644). Everything
	// the unit writes lives in root's hostconfig.StateDir: under bcd helper it runs as root on the
	// unprivileged node's request, and a file in a directory the node can write (its data_dir,
	// /run/bcd) could be swapped under it, e.g. a JoinConfiguration naming another cluster.
	StateFile = hostconfig.StateDir + "/k8s-join.json"
	// JoinConfigFile holds the JoinConfiguration (with the token) only while kubeadm join runs.
	JoinConfigFile = hostconfig.StateDir + "/k8s-join.yaml"

	modulesFile          = "/etc/modules-load.d/90-bcd-k8s.conf"
	sysctlFile           = "/etc/sysctl.d/90-bcd-k8s.conf"
	containerdConfig     = "/etc/containerd/config.toml"
	containerdDropInDir  = "/etc/containerd/conf.d"
	containerdDropIn     = containerdDropInDir + "/90-bcd-k8s.toml"
	containerdImportGlob = containerdDropInDir + "/*.toml"
	aptSource            = "/etc/apt/sources.list.d/bcd-kubernetes.list"
	aptKeyring           = "/etc/apt/keyrings/bcd-kubernetes.gpg"
	aptKeyDownload       = hostconfig.StateDir + "/k8s-release.key"
	dnfRepo              = "/etc/yum.repos.d/bcd-kubernetes.repo"
	criSocket            = "unix:///run/containerd/containerd.sock"
)

// BcdLabelPrefix is the label namespace bcd owns on its Node.
const BcdLabelPrefix = "bcd.dev/"

// State is StateFile's content.
type State struct {
	Server   string `json:"server"`
	NodeName string `json:"nodeName"`
	// Labels and Taints are what the unit set, so it can remove what the spec drops.
	Labels []string `json:"labels"`
	Taints []string `json:"taints"`
	// GPU lets the device plugins (or the DRA driver, GPUAPI "dra") offer GPUs.
	GPU    bool   `json:"gpu"`
	GPUAPI string `json:"gpuApi,omitempty"`
}

// ReadState reads StateFile; ok is false when the node was never joined by bcd.
func ReadState(sys hostconfig.System) (State, bool, error) {
	b, err := sys.ReadFile(StateFile)
	if errors.Is(err, fs.ErrNotExist) {
		return State{}, false, nil
	}
	if err != nil {
		return State{}, false, err
	}
	var s State
	if err := json.Unmarshal(b, &s); err != nil {
		return State{}, false, fmt.Errorf("%s: %w", StateFile, err)
	}
	return s, true, nil
}

// TokenFile is where an unprivileged bcd node stages the bootstrap token for bcd helper (helper
// file kind "k8s-token", root's 0600 file in root's directory, so the node cannot point it at
// another file): the helper cannot ask the control plane for secrets. The join removes it.
const TokenFile = hostconfig.StateDir + "/k8s/bootstrap-token"

// JoinUnit is the k8s-join config unit.
type JoinUnit struct {
	// Token fetches the bootstrap token a tokenRef names (a SecretRequest to the control plane). nil
	// (bcd helper) reads TokenFile instead.
	Token func(ctx context.Context, ref string) ([]byte, error)
	// Allowed are the clusters root allows ([kubernetes] allowed_clusters); with RequireAllowed an
	// empty list refuses every join (bcd helper).
	Allowed        []Cluster
	RequireAllowed bool
	// Labels returns the bcd.dev/* labels the Node carries besides the spec's (node id, GPU
	// product, ...); keys outside bcd.dev/ are ignored.
	Labels func() map[string]string
	// NodeName overrides the Node name (default: the host name, lowercased).
	NodeName string
}

func (JoinUnit) Name() string { return UnitName }

// errContinue ends a pass that changed what later steps plan against (packages installed, modules
// loaded): the section stays progressing and the next pass plans the rest.
var errContinue = errors.New(UnitName + ": prerequisites changed; continuing on the next pass")

// Plan converges, in order: packages, kernel prerequisites, containerd, the join itself, the
// kubelet running, and the Node's labels and taints. It never resets a node joined elsewhere.
func (u JoinUnit) Plan(ctx context.Context, sys hostconfig.System, settings json.RawMessage) ([]converge.Action, error) {
	p, err := parseSettings(settings)
	if err != nil {
		return nil, err
	}
	if err := u.allowedCluster(p); err != nil {
		return nil, err
	}
	var actions []converge.Action
	if steps, err := planPackages(sys, p); err != nil {
		return nil, err
	} else if len(steps) > 0 {
		return append(steps, stop(nil)), nil
	}
	steps, reload, err := planKernel(sys)
	if err != nil {
		return nil, err
	}
	if reload {
		return append(steps, stop(nil)), nil
	}
	actions = append(actions, steps...)
	steps, err = planContainerd(ctx, sys)
	if err != nil {
		return nil, err
	}
	actions = append(actions, steps...)

	state, _, err := ReadState(sys)
	if err != nil {
		return nil, err
	}
	joined, server, err := kubeletServer(sys)
	if err != nil {
		return nil, err
	}
	name := state.NodeName
	if name == "" {
		if name, err = u.nodeName(sys); err != nil {
			return nil, err
		}
	}
	labels := u.desiredLabels(p)
	if !joined {
		actions = append(actions, u.joinSteps(sys, p, name, labels)...)
		actions = append(actions, writeState(sys, State{Server: p.Server, NodeName: name, Labels: keys(labels), Taints: taintStrings(p.taints), GPU: p.gpu, GPUAPI: p.GPUAPI}))
		return append(actions, stop(nil)), nil
	}
	if !sameServer(server, p) {
		return nil, terminal("this node's kubelet belongs to %s, not %s; reset it by hand (kubeadm reset) to move it", server, p.Server)
	}
	if !active(ctx, sys, "kubelet") {
		actions = append(actions, runCmd(sys, hostconfig.Cmd{Name: "systemctl", Args: []string{"enable", "--now", "kubelet"}}))
	}
	steps, err = planNode(ctx, sys, name, state, labels, p.taints)
	if err != nil {
		return nil, err
	}
	actions = append(actions, steps...)
	want := State{Server: p.Server, NodeName: name, Labels: keys(labels), Taints: taintStrings(p.taints), GPU: p.gpu, GPUAPI: p.GPUAPI}
	if !equalState(state, want) {
		actions = append(actions, writeState(sys, want))
	}
	return actions, nil
}

// PendingToken returns the tokenRef an unjoined node still needs (bcd node stages it at TokenFile
// before handing the unit to bcd helper); none once the kubelet is joined or the token is staged.
func PendingToken(sys hostconfig.System, settings json.RawMessage) (ref string, err error) {
	p, err := parseSettings(settings)
	if err != nil {
		return "", err
	}
	// Listing, not reading: an unprivileged node may list /etc/kubernetes and the token's directory
	// but cannot read the root-only files in them.
	if names, _ := sys.ReadDir("/etc/kubernetes"); contains(names, "kubelet.conf") {
		return "", nil
	}
	if names, _ := sys.ReadDir(path.Dir(TokenFile)); contains(names, path.Base(TokenFile)) {
		return "", nil
	}
	return p.TokenRef, nil
}

func contains(names []string, name string) bool {
	for _, n := range names {
		if n == name {
			return true
		}
	}
	return false
}

// stop is the last step of a pass that must plan again: errContinue (retryable) or err.
func stop(err error) converge.Action {
	if err == nil {
		err = errContinue
	}
	return converge.Action{Description: "plan the rest of " + UnitName, Apply: func(context.Context) error { return err }}
}

// runCmd is a step that runs cmd on sys.
func runCmd(sys hostconfig.System, cmd hostconfig.Cmd) converge.Action {
	return converge.Action{
		Description: "run " + cmd.String(),
		Apply: func(ctx context.Context) error {
			_, err := sys.Run(ctx, cmd)
			return err
		},
	}
}

func ensureFile(sys hostconfig.System, abs string, data []byte, mode fs.FileMode) ([]converge.Action, bool, error) {
	have, err := sys.ReadFile(abs)
	if err == nil && bytes.Equal(have, data) {
		return nil, false, nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, false, err
	}
	return []converge.Action{{
		Description: "write " + abs,
		Apply:       func(context.Context) error { return sys.WriteFile(abs, data, mode) },
	}}, true, nil
}

const header = "# Written by bcd for the k8s-join config unit of this node's NodeSpec. Local edits are replaced.\n"

// ---- packages ------------------------------------------------------------------------------------

// osFamily reads /etc/os-release: "debian" (apt) or "rhel" (dnf).
func osFamily(sys hostconfig.System) string {
	b, _ := sys.ReadFile("/etc/os-release")
	ids := ""
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if ok && (k == "ID" || k == "ID_LIKE") {
			ids += " " + strings.Trim(v, `"'`)
		}
	}
	for _, id := range strings.Fields(ids) {
		switch id {
		case "debian", "ubuntu":
			return "debian"
		case "rhel", "fedora", "centos", "rocky", "almalinux":
			return "rhel"
		}
	}
	return ""
}

// planPackages installs kubeadm, kubelet, kubectl (from pkgs.k8s.io, the minor of
// kubernetesVersion) and containerd when missing.
func planPackages(sys hostconfig.System, p *parsed) ([]converge.Action, error) {
	var missing []string
	for _, prog := range []string{"kubeadm", "kubelet", "kubectl"} {
		if !sys.LookPath(prog) {
			missing = append(missing, prog)
		}
	}
	needContainerd := !sys.LookPath("containerd")
	if len(missing) == 0 && !needContainerd {
		return nil, nil
	}
	if len(missing) > 0 && p.minor == "" {
		return nil, terminal("%s not installed and no kubernetesVersion to install it from", strings.Join(missing, ", "))
	}
	family := osFamily(sys)
	var actions []converge.Action
	switch family {
	case "debian":
		env := []string{"DEBIAN_FRONTEND=noninteractive"}
		if len(missing) > 0 {
			repo := "https://pkgs.k8s.io/core:/stable:/v" + p.minor + "/deb/"
			steps, _, err := ensureFile(sys, aptSource, []byte(header+"deb [signed-by="+aptKeyring+"] "+repo+" /\n"), 0o644)
			if err != nil {
				return nil, err
			}
			actions = append(actions, steps...)
			actions = append(actions,
				runCmd(sys, hostconfig.Cmd{Name: "curl", Args: []string{"-fsSL", "--proto", "=https", "-o", aptKeyDownload, repo + "Release.key"}}),
				runCmd(sys, hostconfig.Cmd{Name: "gpg", Args: []string{"--batch", "--yes", "--dearmor", "-o", aptKeyring, aptKeyDownload}}),
			)
		}
		actions = append(actions, runCmd(sys, hostconfig.Cmd{Name: "apt-get", Args: []string{"update"}, Env: env}))
		install := append([]string{"install", "-y"}, missing...)
		if needContainerd {
			install = append(install, "containerd")
		}
		actions = append(actions, runCmd(sys, hostconfig.Cmd{Name: "apt-get", Args: install, Env: env}))
		if len(missing) > 0 {
			actions = append(actions, runCmd(sys, hostconfig.Cmd{Name: "apt-mark", Args: append([]string{"hold"}, missing...)}))
		}
	case "rhel":
		if len(missing) > 0 {
			base := "https://pkgs.k8s.io/core:/stable:/v" + p.minor + "/rpm/"
			repo := header + "[bcd-kubernetes]\nname=Kubernetes v" + p.minor + "\nbaseurl=" + base +
				"\nenabled=1\ngpgcheck=1\ngpgkey=" + base + "repodata/repomd.xml.key\nexclude=kubelet kubeadm kubectl cri-tools kubernetes-cni\n"
			steps, _, err := ensureFile(sys, dnfRepo, []byte(repo), 0o644)
			if err != nil {
				return nil, err
			}
			actions = append(actions, steps...)
			actions = append(actions, runCmd(sys, hostconfig.Cmd{Name: "dnf", Args: append([]string{"install", "-y", "--disableexcludes=bcd-kubernetes"}, missing...)}))
		}
		if needContainerd {
			actions = append(actions, runCmd(sys, hostconfig.Cmd{Name: "dnf", Args: []string{"install", "-y", "containerd"}}))
		}
	default:
		if needContainerd {
			missing = append(missing, "containerd")
		}
		return nil, terminal("cannot install %s on this OS (apt or dnf hosts only); install it in the image", strings.Join(missing, ", "))
	}
	return actions, nil
}

// ---- kernel --------------------------------------------------------------------------------------

var kernelSysctls = []struct{ key, value string }{
	{"net.bridge.bridge-nf-call-ip6tables", "1"},
	{"net.bridge.bridge-nf-call-iptables", "1"},
	{"net.ipv4.ip_forward", "1"},
}

// planKernel loads overlay and br_netfilter (now and at boot), sets the bridge and forwarding
// sysctls, and turns swap off. reload is set when modules were loaded: the sysctls they provide are
// planned on the next pass.
func planKernel(sys hostconfig.System) (actions []converge.Action, reload bool, err error) {
	steps, _, err := ensureFile(sys, modulesFile, []byte(header+"overlay\nbr_netfilter\n"), 0o644)
	if err != nil {
		return nil, false, err
	}
	actions = append(actions, steps...)
	loaded, _ := sys.ReadDir("/sys/module")
	have := map[string]bool{}
	for _, m := range loaded {
		have[m] = true
	}
	for _, m := range []string{"overlay", "br_netfilter"} {
		if !have[m] {
			actions = append(actions, runCmd(sys, hostconfig.Cmd{Name: "modprobe", Args: []string{m}}))
			reload = true
		}
	}
	if reload {
		return actions, true, nil
	}
	var file strings.Builder
	file.WriteString(header)
	for _, s := range kernelSysctls {
		fmt.Fprintf(&file, "%s = %s\n", s.key, s.value)
	}
	steps, _, err = ensureFile(sys, sysctlFile, []byte(file.String()), 0o644)
	if err != nil {
		return nil, false, err
	}
	actions = append(actions, steps...)
	for _, s := range kernelSysctls {
		path := "/proc/sys/" + strings.ReplaceAll(s.key, ".", "/")
		b, err := sys.ReadFile(path)
		if err != nil {
			return nil, false, fmt.Errorf("%s: %w", s.key, err)
		}
		if strings.TrimSpace(string(b)) != s.value {
			value := s.value
			actions = append(actions, converge.Action{
				Description: "set " + s.key + " = " + value,
				Apply:       func(context.Context) error { return sys.WriteKernel(path, value) },
			})
		}
	}
	// The kubelet refuses to start with swap on (failSwapOn). Level-triggered: swap an fstab turns
	// back on at boot is turned off again on the next pass.
	if swaps, err := sys.ReadFile("/proc/swaps"); err == nil && len(strings.Split(strings.TrimSpace(string(swaps)), "\n")) > 1 {
		actions = append(actions, runCmd(sys, hostconfig.Cmd{Name: "swapoff", Args: []string{"-a"}}))
	}
	return actions, false, nil
}

// ---- containerd ----------------------------------------------------------------------------------

// planContainerd makes containerd import bcd's drop-in (CDI on, the systemd cgroup driver the
// kubelet expects) and keeps it running. The drop-in uses the config version of the installed
// containerd (2.x reads version 3).
func planContainerd(ctx context.Context, sys hostconfig.System) ([]converge.Action, error) {
	var actions []converge.Action
	changed := false
	config, err := sys.ReadFile(containerdConfig)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	out, _ := sys.Run(ctx, hostconfig.Cmd{Name: "containerd", Args: []string{"--version"}})
	v2 := containerdV2(string(out))
	updated, err := withImport(string(config), v2)
	if err != nil {
		return nil, err
	}
	if updated != string(config) {
		data := []byte(updated)
		actions = append(actions, converge.Action{
			Description: "import " + containerdImportGlob + " in " + containerdConfig,
			Apply:       func(context.Context) error { return sys.WriteFile(containerdConfig, data, 0o644) },
		})
		changed = true
	}
	steps, wrote, err := ensureFile(sys, containerdDropIn, containerdDropInFile(v2), 0o644)
	if err != nil {
		return nil, err
	}
	actions = append(actions, steps...)
	changed = changed || wrote
	switch {
	case changed:
		actions = append(actions, runCmd(sys, hostconfig.Cmd{Name: "systemctl", Args: []string{"restart", "containerd"}}))
	case !active(ctx, sys, "containerd"):
		actions = append(actions, runCmd(sys, hostconfig.Cmd{Name: "systemctl", Args: []string{"enable", "--now", "containerd"}}))
	}
	return actions, nil
}

// containerdV2 reads `containerd --version` ("containerd github.com/containerd/containerd/v2 v2.1.4 …",
// "containerd containerd.io 1.7.27 …").
func containerdV2(version string) bool {
	for _, f := range strings.Fields(version) {
		if strings.HasPrefix(f, "v2.") || strings.HasPrefix(f, "2.") {
			return true
		}
	}
	return false
}

func containerdDropInFile(v2 bool) []byte {
	plugin, version := `"io.containerd.grpc.v1.cri"`, "2"
	if v2 {
		plugin, version = `"io.containerd.cri.v1.runtime"`, "3"
	}
	return []byte(header + "version = " + version + "\n\n" +
		"[plugins." + plugin + "]\n  enable_cdi = true\n  cdi_spec_dirs = [\"/etc/cdi\", \"/var/run/cdi\"]\n\n" +
		"[plugins." + plugin + ".containerd.runtimes.runc.options]\n  SystemdCgroup = true\n")
}

// withImport returns containerd's config with bcd's drop-in directory imported: a new file when
// there is none, an `imports` line added before the first table otherwise. An imports list that
// does not include the directory is left to the operator (terminal).
func withImport(config string, v2 bool) (string, error) {
	glob := `"` + containerdImportGlob + `"`
	if strings.TrimSpace(config) == "" {
		version := "2"
		if v2 {
			version = "3"
		}
		return header + "version = " + version + "\nimports = [" + glob + "]\n", nil
	}
	lines := strings.Split(config, "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			break
		}
		if k, v, ok := strings.Cut(trimmed, "="); ok && strings.TrimSpace(k) == "imports" {
			if strings.Contains(v, glob) {
				return config, nil
			}
			return "", terminal("%s imports %s; add %s to it", containerdConfig, strings.TrimSpace(v), glob)
		}
	}
	// After the leading comments and top-level keys, before the first table.
	at := len(lines)
	for i, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "[") {
			at = i
			break
		}
	}
	out := append([]string{}, lines[:at]...)
	out = append(out, "imports = ["+glob+"]")
	out = append(out, lines[at:]...)
	return strings.Join(out, "\n"), nil
}

func active(ctx context.Context, sys hostconfig.System, unit string) bool {
	out, err := sys.Run(ctx, hostconfig.Cmd{Name: "systemctl", Args: []string{"is-active", unit}})
	return err == nil && strings.TrimSpace(string(out)) == "active"
}

// ---- join ----------------------------------------------------------------------------------------

// kubeletServer reads the API server the kubelet's kubeconfig points at; joined is false when there
// is no kubeconfig.
func kubeletServer(sys hostconfig.System) (joined bool, server string, err error) {
	b, err := sys.ReadFile(KubeletConf)
	if errors.Is(err, fs.ErrNotExist) {
		return false, "", nil
	}
	if err != nil {
		return false, "", err
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "server:"); ok {
			return true, strings.Trim(strings.TrimSpace(v), `"'`), nil
		}
	}
	return true, "", nil
}

func sameServer(server string, p *parsed) bool {
	s := strings.TrimSuffix(server, "/")
	return s == strings.TrimSuffix(p.Server, "/") || s == "https://"+p.endpoint
}

var nodeNameInvalid = strings.NewReplacer("_", "-", " ", "-")

func (u JoinUnit) nodeName(sys hostconfig.System) (string, error) {
	name := u.NodeName
	if name == "" {
		b, err := sys.ReadFile("/proc/sys/kernel/hostname")
		if err != nil {
			return "", fmt.Errorf("host name: %w", err)
		}
		name = strings.TrimSpace(string(b))
	}
	name = strings.ToLower(nodeNameInvalid.Replace(name))
	if len(name) > 253 || !dnsSubdomain.MatchString(name) {
		return "", terminal("the host name %q is not a valid Node name; set one", name)
	}
	return name, nil
}

func (u JoinUnit) desiredLabels(p *parsed) map[string]string {
	out := map[string]string{}
	for k, v := range p.NodeLabels {
		out[k] = v
	}
	if u.Labels != nil {
		for k, v := range u.Labels() {
			if strings.HasPrefix(k, BcdLabelPrefix) && checkLabelKey(k) == nil && checkLabelValue(v) {
				out[k] = v
			}
		}
	}
	return out
}

// joinSteps fetch the token, write the JoinConfiguration (0600, removed afterwards whatever
// happens) and run kubeadm join with it.
func (u JoinUnit) joinSteps(sys hostconfig.System, p *parsed, name string, labels map[string]string) []converge.Action {
	return []converge.Action{{
		Description: "kubeadm join " + p.endpoint + " as " + name,
		Apply: func(ctx context.Context) error {
			var raw []byte
			var err error
			if u.Token != nil {
				if raw, err = u.Token(ctx, p.TokenRef); err != nil {
					return fmt.Errorf("fetch the bootstrap token: %w", err)
				}
			} else if raw, err = sys.ReadFile(TokenFile); errors.Is(err, fs.ErrNotExist) {
				return fmt.Errorf("waiting for bcd node to stage the bootstrap token (%s)", TokenFile)
			} else if err != nil {
				return err
			}
			token := strings.TrimSpace(string(raw))
			if !tokenPattern.MatchString(token) {
				return terminal("%s is not a kubeadm bootstrap token (abcdef.0123456789abcdef)", p.TokenRef)
			}
			version, err := sys.Run(ctx, hostconfig.Cmd{Name: "kubeadm", Args: []string{"version", "-o", "short"}})
			if err != nil {
				return err
			}
			config := joinConfiguration(apiVersion(string(version)), p, token, name, labels)
			if err := sys.WriteFile(JoinConfigFile, config, 0o600); err != nil {
				return err
			}
			defer sys.RemoveFile(JoinConfigFile)
			if _, err := sys.Run(ctx, hostconfig.Cmd{Name: "kubeadm", Args: []string{"join", "--config", JoinConfigFile}}); err != nil {
				return err
			}
			// A bootstrap token is single-purpose; keep no copy once joined.
			return sys.RemoveFile(TokenFile)
		},
	}}
}

// apiVersion picks the kubeadm config API: v1beta4 from kubeadm 1.31, v1beta3 before.
func apiVersion(kubeadmVersion string) string {
	v := strings.TrimPrefix(strings.TrimSpace(kubeadmVersion), "v")
	major, rest, _ := strings.Cut(v, ".")
	minorText, _, _ := strings.Cut(rest, ".")
	minor := 0
	fmt.Sscanf(minorText, "%d", &minor)
	if major == "1" && minor < 31 {
		return "kubeadm.k8s.io/v1beta3"
	}
	return "kubeadm.k8s.io/v1beta4"
}

// q quotes a YAML scalar (a JSON string is a YAML double-quoted scalar).
func q(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func joinConfiguration(api string, p *parsed, token, name string, labels map[string]string) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "apiVersion: %s\nkind: JoinConfiguration\n", api)
	fmt.Fprintf(&b, "discovery:\n  bootstrapToken:\n    apiServerEndpoint: %s\n    token: %s\n    caCertHashes:\n    - %s\n",
		q(p.endpoint), q(token), q("sha256:"+p.CaCertSha256))
	fmt.Fprintf(&b, "nodeRegistration:\n  name: %s\n  criSocket: %s\n", q(name), q(criSocket))
	if len(labels) > 0 {
		pairs := make([]string, 0, len(labels))
		for _, k := range keys(labels) {
			pairs = append(pairs, k+"="+labels[k])
		}
		if api == "kubeadm.k8s.io/v1beta3" {
			fmt.Fprintf(&b, "  kubeletExtraArgs:\n    node-labels: %s\n", q(strings.Join(pairs, ",")))
		} else {
			fmt.Fprintf(&b, "  kubeletExtraArgs:\n  - name: node-labels\n    value: %s\n", q(strings.Join(pairs, ",")))
		}
	}
	b.WriteString("  taints:")
	if len(p.taints) == 0 {
		b.WriteString(" []\n")
	} else {
		b.WriteString("\n")
		for _, t := range p.taints {
			fmt.Fprintf(&b, "  - key: %s\n    effect: %s\n", q(t.Key), q(t.Effect))
			if t.Value != "" {
				fmt.Fprintf(&b, "    value: %s\n", q(t.Value))
			}
		}
	}
	return []byte(b.String())
}

// ---- the Node ------------------------------------------------------------------------------------

type nodeObject struct {
	Metadata struct {
		Labels map[string]string `json:"labels"`
	} `json:"metadata"`
	Spec struct {
		Taints []struct {
			Key    string `json:"key"`
			Value  string `json:"value"`
			Effect string `json:"effect"`
		} `json:"taints"`
	} `json:"spec"`
}

func kubectl(args ...string) hostconfig.Cmd {
	return hostconfig.Cmd{Name: "kubectl", Args: append([]string{"--kubeconfig", KubeletConf}, args...)}
}

// planNode keeps the Node's labels and taints: the spec's and bcd.dev/*, with the kubelet's own
// credentials (NodeRestriction lets a node label itself outside kubernetes.io and k8s.io). It
// removes only what bcd set before (State) or owns (bcd.dev/*).
func planNode(ctx context.Context, sys hostconfig.System, name string, state State, labels map[string]string, taints []Taint) ([]converge.Action, error) {
	out, err := sys.Run(ctx, kubectl("get", "node", name, "-o", "json"))
	if err != nil {
		// Registering right after the join, or the API server unreachable: retry.
		return nil, fmt.Errorf("read Node %s: %w", name, err)
	}
	var node nodeObject
	if err := json.Unmarshal(out, &node); err != nil {
		return nil, fmt.Errorf("Node %s: %w", name, err)
	}
	var actions []converge.Action
	var set, remove []string
	for _, k := range keys(labels) {
		if have, ok := node.Metadata.Labels[k]; !ok || have != labels[k] {
			set = append(set, k+"="+labels[k])
		}
	}
	managed := map[string]bool{}
	for _, k := range state.Labels {
		managed[k] = true
	}
	for k := range node.Metadata.Labels {
		if strings.HasPrefix(k, BcdLabelPrefix) {
			managed[k] = true
		}
	}
	for _, k := range keys(managed) {
		if _, want := labels[k]; !want {
			if _, has := node.Metadata.Labels[k]; has {
				remove = append(remove, k+"-")
			}
		}
	}
	if len(set)+len(remove) > 0 {
		actions = append(actions, runCmd(sys, kubectl(append([]string{"label", "node", name, "--overwrite"}, append(set, remove...)...)...)))
	}
	have := map[string]string{}
	for _, t := range node.Spec.Taints {
		have[t.Key+":"+t.Effect] = t.Value
	}
	want := map[string]bool{}
	var taintArgs []string
	for _, t := range taints {
		want[t.Key+":"+t.Effect] = true
		if v, ok := have[t.Key+":"+t.Effect]; !ok || v != t.Value {
			taintArgs = append(taintArgs, t.String())
		}
	}
	for _, s := range state.Taints {
		m := taintPattern.FindStringSubmatch(s)
		if m == nil || want[m[1]+":"+m[3]] {
			continue
		}
		if _, ok := have[m[1]+":"+m[3]]; ok {
			taintArgs = append(taintArgs, m[1]+":"+m[3]+"-")
		}
	}
	if len(taintArgs) > 0 {
		actions = append(actions, runCmd(sys, kubectl(append([]string{"taint", "node", name, "--overwrite"}, taintArgs...)...)))
	}
	return actions, nil
}

func writeState(sys hostconfig.System, s State) converge.Action {
	return converge.Action{
		Description: "record " + StateFile,
		Apply: func(context.Context) error {
			b, err := json.MarshalIndent(s, "", "  ")
			if err != nil {
				return err
			}
			return sys.WriteFile(StateFile, append(b, '\n'), 0o644)
		},
	}
}

func equalState(a, b State) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func taintStrings(ts []Taint) []string {
	out := make([]string, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.String())
	}
	return out
}
