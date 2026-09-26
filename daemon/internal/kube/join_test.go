package kube

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/converge"
	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
)

const pin = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// fakeCluster is a Debian host with nothing installed, a kubelet and an API server that answer
// kubeadm and kubectl.
type fakeCluster struct {
	sys     *hostconfig.FakeSystem
	mu      sync.Mutex
	active  map[string]bool
	node    *nodeObject // nil until kubeadm join registers it
	joinCfg string
	server  string
}

func newFakeCluster(t *testing.T) *fakeCluster {
	t.Helper()
	c := &fakeCluster{sys: hostconfig.NewFakeSystem(), active: map[string]bool{}, server: "https://10.0.0.1:6443"}
	c.sys.Set("/etc/os-release", "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n")
	c.sys.Set("/proc/sys/kernel/hostname", "GPU_Node-7\n")
	c.sys.Set("/proc/sys/net/ipv4/ip_forward", "0\n")
	c.sys.Set("/proc/swaps", "Filename\tType\tSize\tUsed\tPriority\n/swap.img\tfile\t8388604\t0\t-2\n")
	c.sys.Set("/sys/module/overlay/refcnt", "3")
	c.sys.Programs["curl"], c.sys.Programs["gpg"] = true, true
	c.sys.Handler = c.handle
	return c
}

func (c *fakeCluster) handle(_ context.Context, cmd hostconfig.Cmd) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	args := strings.Join(cmd.Args, " ")
	switch cmd.Name {
	case "apt-get":
		if strings.HasPrefix(args, "install") {
			for _, p := range cmd.Args[2:] {
				c.sys.Programs[p] = true
			}
		}
	case "modprobe":
		c.sys.Set("/sys/module/"+cmd.Args[0]+"/refcnt", "1")
		if cmd.Args[0] == "br_netfilter" {
			c.sys.Set("/proc/sys/net/bridge/bridge-nf-call-iptables", "0\n")
			c.sys.Set("/proc/sys/net/bridge/bridge-nf-call-ip6tables", "0\n")
		}
	case "swapoff":
		c.sys.Set("/proc/swaps", "Filename\tType\tSize\tUsed\tPriority\n")
	case "containerd":
		return []byte("containerd github.com/containerd/containerd/v2 v2.1.4 75cb2b7\n"), nil
	case "systemctl":
		switch cmd.Args[0] {
		case "is-active":
			if c.active[cmd.Args[1]] {
				return []byte("active\n"), nil
			}
			return []byte("inactive\n"), errors.New("exit status 3")
		case "restart":
			c.active[cmd.Args[1]] = true
		case "enable":
			c.active[cmd.Args[2]] = true
		}
	case "kubeadm":
		if args == "version -o short" {
			return []byte("v1.34.1\n"), nil
		}
		if strings.HasPrefix(args, "join --config ") {
			cfg, ok := c.sys.Get(JoinConfigFile)
			if !ok {
				return nil, errors.New("no join config")
			}
			c.joinCfg = cfg
			c.sys.Set(KubeletConf, "apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: LS0t\n    server: "+c.server+"\n  name: default-cluster\n")
			c.active["kubelet"] = true
			n := &nodeObject{}
			n.Metadata.Labels = map[string]string{"kubernetes.io/hostname": "gpu-node-7"}
			// The kubelet registers with the labels and taints of the configuration.
			for _, line := range strings.Split(cfg, "\n") {
				if v, ok := strings.CutPrefix(strings.TrimSpace(line), "value: "); ok && strings.Contains(v, "=") {
					var pairs string
					json.Unmarshal([]byte(v), &pairs)
					for _, pair := range strings.Split(pairs, ",") {
						k, v, _ := strings.Cut(pair, "=")
						n.Metadata.Labels[k] = v
					}
				}
			}
			c.node = n
		}
	case "kubectl":
		if c.node == nil {
			return nil, errors.New(`Error from server (NotFound): nodes "gpu-node-7" not found`)
		}
		rest := cmd.Args[2:] // after --kubeconfig <file>
		switch rest[0] {
		case "get":
			return json.Marshal(c.node)
		case "label":
			for _, a := range rest[4:] {
				if k, ok := strings.CutSuffix(a, "-"); ok {
					delete(c.node.Metadata.Labels, k)
				} else {
					k, v, _ := strings.Cut(a, "=")
					c.node.Metadata.Labels[k] = v
				}
			}
		case "taint":
			for _, a := range rest[4:] {
				if s, ok := strings.CutSuffix(a, "-"); ok {
					key, effect, _ := strings.Cut(s, ":")
					kept := c.node.Spec.Taints[:0]
					for _, t := range c.node.Spec.Taints {
						if t.Key != key || t.Effect != effect {
							kept = append(kept, t)
						}
					}
					c.node.Spec.Taints = kept
					continue
				}
				m := taintPattern.FindStringSubmatch(a)
				c.node.Spec.Taints = append(c.node.Spec.Taints, struct {
					Key    string `json:"key"`
					Value  string `json:"value"`
					Effect string `json:"effect"`
				}{m[1], m[2], m[3]})
			}
		}
	}
	return nil, nil
}

// settle plans and applies the unit until it converges (no steps), fails, or runs 10 passes.
func settle(t *testing.T, sys hostconfig.System, u JoinUnit, settings string) (passes int, err error) {
	t.Helper()
	ctx := context.Background()
	for passes = 1; passes <= 10; passes++ {
		steps, err := u.Plan(ctx, sys, json.RawMessage(settings))
		if err != nil {
			return passes, err
		}
		if len(steps) == 0 {
			return passes, nil
		}
		for _, s := range steps {
			if err := s.Apply(ctx); err != nil {
				if errors.Is(err, errContinue) {
					break
				}
				return passes, fmt.Errorf("%s: %w", s.Description, err)
			}
		}
	}
	return passes, errors.New("did not converge in 10 passes")
}

func unit(tokens *[]string) JoinUnit {
	return JoinUnit{
		Token: func(_ context.Context, ref string) ([]byte, error) {
			*tokens = append(*tokens, ref)
			return []byte("abcdef.0123456789abcdef\n"), nil
		},
		Labels: func() map[string]string {
			return map[string]string{"bcd.dev/node-id": "node-7", "bcd.dev/gpu.product": "NVIDIA-H100-80GB-HBM3", "other/label": "dropped"}
		},
	}
}

const settings = `{"server":"https://10.0.0.1:6443","caCertSha256":"sha256:` + pin + `","tokenRef":"secret://pool-a/k8s","kubernetesVersion":"1.34.1","nodeLabels":{"team":"ml"},"taints":["gpu=true:NoSchedule"]}`

func TestJoinFromBareHost(t *testing.T) {
	c := newFakeCluster(t)
	var tokens []string
	u := unit(&tokens)
	passes, err := settle(t, c.sys, u, settings)
	if err != nil {
		t.Fatalf("pass %d: %v\ncommands: %v", passes, err, c.sys.Commands())
	}
	if want := []string{"secret://pool-a/k8s"}; fmt.Sprint(tokens) != fmt.Sprint(want) {
		t.Fatalf("tokens fetched = %v", tokens)
	}
	source, _ := c.sys.Get(aptSource)
	if !strings.Contains(source, "https://pkgs.k8s.io/core:/stable:/v1.34/deb/ /") || !strings.Contains(source, "signed-by="+aptKeyring) {
		t.Fatalf("apt source = %q", source)
	}
	dropIn, _ := c.sys.Get(containerdDropIn)
	if !strings.Contains(dropIn, "version = 3") || !strings.Contains(dropIn, `[plugins."io.containerd.cri.v1.runtime"]`) || !strings.Contains(dropIn, "enable_cdi = true") {
		t.Fatalf("containerd drop-in = %q", dropIn)
	}
	config, _ := c.sys.Get(containerdConfig)
	if !strings.Contains(config, `imports = ["/etc/containerd/conf.d/*.toml"]`) {
		t.Fatalf("containerd config = %q", config)
	}
	for path, want := range map[string]string{
		"/proc/sys/net/ipv4/ip_forward":                 "1\n",
		"/proc/sys/net/bridge/bridge-nf-call-iptables":  "1\n",
		"/proc/sys/net/bridge/bridge-nf-call-ip6tables": "1\n",
	} {
		if have, _ := c.sys.Get(path); have != want {
			t.Fatalf("%s = %q", path, have)
		}
	}
	// The token lived only in the join configuration, which is gone.
	if _, ok := c.sys.Get(JoinConfigFile); ok {
		t.Fatal("the join configuration was left behind")
	}
	for _, want := range []string{
		"apiVersion: kubeadm.k8s.io/v1beta4",
		`apiServerEndpoint: "10.0.0.1:6443"`,
		`token: "abcdef.0123456789abcdef"`,
		`- "sha256:` + pin + `"`,
		`name: "gpu-node-7"`,
		"  - name: node-labels\n    value: \"bcd.dev/gpu.product=NVIDIA-H100-80GB-HBM3,bcd.dev/node-id=node-7,team=ml\"",
		"  - key: \"gpu\"\n    effect: \"NoSchedule\"\n    value: \"true\"",
	} {
		if !strings.Contains(c.joinCfg, want) {
			t.Fatalf("join configuration lacks %q:\n%s", want, c.joinCfg)
		}
	}
	if c.node.Metadata.Labels["team"] != "ml" || c.node.Metadata.Labels["bcd.dev/node-id"] != "node-7" || c.node.Metadata.Labels["other/label"] != "" {
		t.Fatalf("labels = %v", c.node.Metadata.Labels)
	}
	if len(c.node.Spec.Taints) != 1 || c.node.Spec.Taints[0].Key != "gpu" {
		t.Fatalf("taints = %+v", c.node.Spec.Taints)
	}
	state, ok, err := ReadState(c.sys)
	if err != nil || !ok || state.NodeName != "gpu-node-7" || !state.GPU || state.Server != "https://10.0.0.1:6443" {
		t.Fatalf("state = %+v %v %v", state, ok, err)
	}

	// Converged: nothing to do, and no second join.
	before := len(c.sys.Commands())
	if steps, err := u.Plan(context.Background(), c.sys, json.RawMessage(settings)); err != nil || len(steps) != 0 {
		t.Fatalf("second plan = %d steps, %v", len(steps), err)
	}
	for _, cmd := range c.sys.Commands()[before:] {
		if !strings.Contains(cmd, "is-active") && !strings.Contains(cmd, "--version") && !strings.Contains(cmd, " get node ") {
			t.Fatalf("a converged plan ran %q", cmd)
		}
	}

	// Labels and taints follow the spec; a label the Node carries that bcd never set stays.
	c.node.Metadata.Labels["someone/else"] = "x"
	changed := strings.Replace(settings, `"nodeLabels":{"team":"ml"},"taints":["gpu=true:NoSchedule"]`, `"nodeLabels":{"tier":"a"},"gpu":false`, 1)
	if _, err := settle(t, c.sys, u, changed); err != nil {
		t.Fatal(err)
	}
	labels := c.node.Metadata.Labels
	if labels["tier"] != "a" || labels["team"] != "" || labels["someone/else"] != "x" || labels["bcd.dev/node-id"] != "node-7" || len(c.node.Spec.Taints) != 0 {
		t.Fatalf("after the change: labels %v taints %+v", labels, c.node.Spec.Taints)
	}
	if state, _, _ := ReadState(c.sys); state.GPU {
		t.Fatal("gpu: false must reach the state the device plugin reads")
	}
}

func TestJoinRefusesAnotherCluster(t *testing.T) {
	c := newFakeCluster(t)
	var tokens []string
	if _, err := settle(t, c.sys, unit(&tokens), settings); err != nil {
		t.Fatal(err)
	}
	other := strings.Replace(settings, "10.0.0.1:6443", "10.9.9.9:6443", 1)
	_, err := settle(t, c.sys, unit(&tokens), other)
	if !errors.Is(err, converge.ErrTerminal) || !strings.Contains(err.Error(), "kubeadm reset") {
		t.Fatalf("err = %v", err)
	}
}

func TestJoinSettingsAreCheckedAgain(t *testing.T) {
	c := newFakeCluster(t)
	var tokens []string
	for name, s := range map[string]string{
		"unknown field": `{"server":"https://a","caCertSha256":"` + pin + `","tokenRef":"secret://x","extra":1}`,
		"http server":   `{"server":"http://a","caCertSha256":"` + pin + `","tokenRef":"secret://x"}`,
		"short pin":     `{"server":"https://a","caCertSha256":"abc","tokenRef":"secret://x"}`,
		"reserved key":  `{"server":"https://a","caCertSha256":"` + pin + `","tokenRef":"secret://x","nodeLabels":{"node-role.kubernetes.io/gpu":""}}`,
		"bad effect":    `{"server":"https://a","caCertSha256":"` + pin + `","tokenRef":"secret://x","taints":["a=b:Sometimes"]}`,
		"injection":     `{"server":"https://a","caCertSha256":"` + pin + `","tokenRef":"secret://x","nodeLabels":{"a":"b,c=d"}}`,
		"no version":    `{"server":"https://a","caCertSha256":"` + pin + `","tokenRef":"secret://x"}`,
	} {
		if _, err := settle(t, c.sys, unit(&tokens), s); !errors.Is(err, converge.ErrTerminal) {
			t.Errorf("%s: err = %v; want terminal", name, err)
		}
	}
	// A fetched token that is not a bootstrap token is refused before it reaches any file.
	bad := JoinUnit{Token: func(context.Context, string) ([]byte, error) { return []byte("x\"\n evil: 1"), nil }}
	if _, err := settle(t, c.sys, bad, settings); !errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("bad token: %v", err)
	}
	if _, ok := c.sys.Get(JoinConfigFile); ok {
		t.Fatal("a join configuration was written for a bad token")
	}
}

// Under bcd helper: no secret access (the node stages the token file) and only allowed clusters.
func TestJoinUnderHelper(t *testing.T) {
	c := newFakeCluster(t)
	allowed, err := ParseAllowedClusters(" https://10.0.0.1:6443#sha256:" + pin + " , https://k8s.example.com#" + pin)
	if err != nil || len(allowed) != 2 || allowed[1].Server != "https://k8s.example.com:443" {
		t.Fatalf("allowed = %+v, %v", allowed, err)
	}
	if _, err := ParseAllowedClusters("http://x#" + pin); err == nil {
		t.Fatal("an http cluster was allowed")
	}

	// No allowlist: the helper refuses every join.
	if _, err := settle(t, c.sys, JoinUnit{RequireAllowed: true}, settings); !errors.Is(err, converge.ErrTerminal) || !strings.Contains(err.Error(), "allowed_clusters") {
		t.Fatalf("no allowlist: %v", err)
	}
	// A cluster outside it, or the right server with another CA, is refused too.
	helper := JoinUnit{RequireAllowed: true, Allowed: allowed[1:]}
	if _, err := settle(t, c.sys, helper, settings); !errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("outside the allowlist: %v", err)
	}
	otherCA := JoinUnit{RequireAllowed: true, Allowed: []Cluster{{Server: "https://10.0.0.1:6443", CaCertSha256: strings.Repeat("f", 64)}}}
	if _, err := settle(t, c.sys, otherCA, settings); !errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("another CA: %v", err)
	}

	// The node sees the token is still needed; until it is staged the helper waits (retryable).
	if ref, err := PendingToken(c.sys, json.RawMessage(settings)); ref != "secret://pool-a/k8s" || err != nil {
		t.Fatalf("PendingToken = %q, %v", ref, err)
	}
	helper = JoinUnit{RequireAllowed: true, Allowed: allowed}
	if _, err := settle(t, c.sys, helper, settings); err == nil || errors.Is(err, converge.ErrTerminal) || !strings.Contains(err.Error(), TokenFile) {
		t.Fatalf("without the token: %v", err)
	}
	c.sys.Set(TokenFile, "abcdef.0123456789abcdef\n")
	if ref, _ := PendingToken(c.sys, json.RawMessage(settings)); ref != "" {
		t.Fatalf("PendingToken after staging = %q", ref)
	}
	if _, err := settle(t, c.sys, helper, settings); err != nil {
		t.Fatalf("with the token: %v", err)
	}
	if _, ok := c.sys.Get(TokenFile); ok {
		t.Fatal("the bootstrap token outlived the join")
	}
	if ref, _ := PendingToken(c.sys, json.RawMessage(settings)); ref != "" {
		t.Fatalf("PendingToken once joined = %q", ref)
	}
}

// The spec drops k8s-join: bcd cordons the Node, deletes its workload pods (not DaemonSet or static
// ones, not finished ones), records the release; the unit's return uncordons it.
func TestReleaseCordonsAndDrains(t *testing.T) {
	c := newFakeCluster(t)
	var tokens []string
	u := unit(&tokens)
	if _, err := settle(t, c.sys, u, settings); err != nil {
		t.Fatal(err)
	}
	prev := c.sys.Handler
	c.sys.Handler = func(ctx context.Context, cmd hostconfig.Cmd) ([]byte, error) {
		if cmd.Name == "kubectl" && len(cmd.Args) > 3 && cmd.Args[2] == "get" && cmd.Args[3] == "pods" {
			return []byte(`{"items":[
				{"metadata":{"name":"train","namespace":"ml"},"status":{"phase":"Running"}},
				{"metadata":{"name":"bcd-x","namespace":"bcd-system","ownerReferences":[{"kind":"DaemonSet"}]},"status":{"phase":"Running"}},
				{"metadata":{"name":"etcd","namespace":"kube-system","annotations":{"kubernetes.io/config.mirror":"x"}},"status":{"phase":"Running"}},
				{"metadata":{"name":"done","namespace":"ml"},"status":{"phase":"Succeeded"}},
				{"metadata":{"name":"infer","namespace":"ai"},"status":{"phase":"Pending"}}]}`), nil
		}
		return prev(ctx, cmd)
	}
	before := len(c.sys.Commands())
	steps, err := u.Clean(context.Background(), c.sys)
	if err != nil || len(steps) != 3 {
		t.Fatalf("clean = %d steps, %v", len(steps), err)
	}
	for _, s := range steps {
		if err := s.Apply(context.Background()); err != nil {
			t.Fatalf("%s: %v", s.Description, err)
		}
	}
	var ran []string
	for _, cmd := range c.sys.Commands()[before:] {
		ran = append(ran, strings.TrimPrefix(cmd, "kubectl --kubeconfig /etc/kubernetes/kubelet.conf "))
	}
	want := []string{
		"cordon gpu-node-7",
		"get pods --all-namespaces --field-selector spec.nodeName=gpu-node-7 -o json",
		"delete pod --namespace ai infer --wait=false --ignore-not-found",
		"delete pod --namespace ml train --wait=false --ignore-not-found",
	}
	if strings.Join(ran, "\n") != strings.Join(want, "\n") {
		t.Fatalf("ran:\n%s", strings.Join(ran, "\n"))
	}
	state, _, _ := ReadState(c.sys)
	if !state.Released || state.GPU {
		t.Fatalf("state = %+v", state)
	}
	if steps, err := u.Clean(context.Background(), c.sys); err != nil || len(steps) != 0 {
		t.Fatalf("a second clean = %d steps, %v", len(steps), err)
	}
	// The unit comes back: uncordoned, no longer released.
	before = len(c.sys.Commands())
	if _, err := settle(t, c.sys, u, settings); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(c.sys.Commands()[before:], "\n"), "uncordon gpu-node-7") {
		t.Fatalf("no uncordon: %v", c.sys.Commands()[before:])
	}
	if state, _, _ := ReadState(c.sys); state.Released || !state.GPU {
		t.Fatalf("state after the return = %+v", state)
	}
	// A node bcd never joined has nothing to release.
	fresh := newFakeCluster(t)
	if steps, err := u.Clean(context.Background(), fresh.sys); err != nil || len(steps) != 0 {
		t.Fatalf("clean of a stranger = %d steps, %v", len(steps), err)
	}
}

func TestContainerdImport(t *testing.T) {
	existing := "# local\nversion = 2\nroot = \"/var/lib/containerd\"\n\n[plugins.\"io.containerd.grpc.v1.cri\"]\n  sandbox_image = \"x\"\n"
	got, err := withImport(existing, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "root = \"/var/lib/containerd\"\n\nimports = [\"/etc/containerd/conf.d/*.toml\"]\n[plugins.") {
		t.Fatalf("config = %q", got)
	}
	if again, _ := withImport(got, false); again != got {
		t.Fatal("not idempotent")
	}
	if _, err := withImport("version = 2\nimports = [\"/etc/other/*.toml\"]\n", false); !errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("foreign imports: %v", err)
	}
	if !containerdV2("containerd github.com/containerd/containerd/v2 v2.0.4 1a43cb6") || containerdV2("containerd containerd.io 1.7.27 05044ec") {
		t.Fatal("containerdV2")
	}
}

func TestJoinConfigurationV1beta3(t *testing.T) {
	p, err := parseSettings(json.RawMessage(settings))
	if err != nil {
		t.Fatal(err)
	}
	if apiVersion("v1.30.4") != "kubeadm.k8s.io/v1beta3" || apiVersion("v1.31.0") != "kubeadm.k8s.io/v1beta4" {
		t.Fatal("apiVersion")
	}
	cfg := string(joinConfiguration("kubeadm.k8s.io/v1beta3", p, "abcdef.0123456789abcdef", "n1", map[string]string{"a": "b"}))
	if !strings.Contains(cfg, "  kubeletExtraArgs:\n    node-labels: \"a=b\"\n") {
		t.Fatalf("v1beta3 = %s", cfg)
	}
}
