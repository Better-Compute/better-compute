package kube

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// eksEndpoint is spelled as DescribeCluster writes it (an upper-case id); nodeadm writes it as given.
const eksEndpoint = "https://ABCDEF0123456789ABCDEF0123456789.gr7.us-east-1.eks.amazonaws.com"

// eksCA returns a self-signed cluster CA as DescribeCluster's certificateAuthority.data (base64 PEM)
// and its kubeadm-style pin (sha256 of the SubjectPublicKeyInfo).
func eksCA(t *testing.T) (data, pin string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "kubernetes"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), hex.EncodeToString(sum[:])
}

func eksSettings(ca string, extra string) string {
	return `{"mode":"eks","cluster":{"name":"training","apiServerEndpoint":"` + eksEndpoint + `","certificateAuthority":"` + ca +
		`","cidr":"172.20.0.0/16"},"nodeLabels":{"team":"ml"},"taints":["nvidia.com/gpu=:NoSchedule"]` + extra + `}`
}

// nodeadmJoined is what an AL2023 EKS AMI leaves once nodeadm ran from the NodeConfig: the kubelet's
// kubeconfig (an exec credential plugin with the instance role) and the Node registered with the
// NodeConfig's taints.
func nodeadmJoined(c *fakeCluster, server string) {
	c.sys.Set(EksKubeletConf, "apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority: /etc/kubernetes/pki/ca.crt\n    server: "+server+
		"\n  name: kubernetes\nusers:\n- name: kubelet\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: aws\n      args: [eks, get-token, --cluster-name, training, --region, us-east-1]\n")
	c.mu.Lock()
	defer c.mu.Unlock()
	n := &nodeObject{}
	n.Metadata.Labels = map[string]string{"kubernetes.io/hostname": "gpu-node-7"}
	n.Spec.Taints = append(n.Spec.Taints, struct {
		Key    string `json:"key"`
		Value  string `json:"value"`
		Effect string `json:"effect"`
	}{"nvidia.com/gpu", "", "NoSchedule"})
	c.node = n
}

func TestEksJoinWaitsForNodeadmAndNeverRunsKubeadm(t *testing.T) {
	c := newFakeCluster(t)
	ca, _ := eksCA(t)
	var tokens []string
	u := unit(&tokens)
	settings := eksSettings(ca, "")
	// Before nodeadm ran: retryable, and nothing installed, loaded or written.
	_, err := settle(t, c.sys, u, settings)
	if err == nil || errors.Is(err, converge.ErrTerminal) || !strings.Contains(err.Error(), "nodeadm") {
		t.Fatalf("before nodeadm: %v", err)
	}
	if cmds := c.sys.Commands(); len(cmds) != 0 {
		t.Fatalf("ran %v before the node joined", cmds)
	}
	if ref, err := PendingToken(c.sys, json.RawMessage(settings)); ref != "" || err != nil {
		t.Fatalf("PendingToken = %q, %v (EKS has no bootstrap token)", ref, err)
	}

	nodeadmJoined(c, strings.ToLower(eksEndpoint))
	if _, err := settle(t, c.sys, u, settings); err != nil {
		t.Fatalf("joined: %v\ncommands: %v", err, c.sys.Commands())
	}
	if len(tokens) != 0 {
		t.Fatalf("fetched tokens %v", tokens)
	}
	for _, cmd := range c.sys.Commands() {
		for _, banned := range []string{"kubeadm", "apt-get", "dnf", "modprobe", "swapoff", "containerd", "systemctl restart"} {
			if strings.Contains(cmd, banned) {
				t.Fatalf("ran %q on an EKS node", cmd)
			}
		}
		if strings.HasPrefix(cmd, "kubectl ") && !strings.HasPrefix(cmd, "kubectl --kubeconfig "+EksKubeletConf+" ") {
			t.Fatalf("kubectl without the kubelet's EKS kubeconfig: %q", cmd)
		}
	}
	if !c.active["kubelet"] {
		t.Fatal("the kubelet was not started")
	}
	labels := c.node.Metadata.Labels
	if labels["team"] != "ml" || labels["bcd.dev/node-id"] != "node-7" {
		t.Fatalf("labels = %v", labels)
	}
	state, ok, err := ReadState(c.sys)
	if err != nil || !ok || state.Mode != ModeEKS || state.Server != eksEndpoint || state.NodeName != "gpu-node-7" ||
		len(state.Taints) != 1 || state.Taints[0] != "nvidia.com/gpu:NoSchedule" || !state.GPU {
		t.Fatalf("state = %+v %v %v", state, ok, err)
	}
	if conds := u.Conditions(context.Background(), c.sys, json.RawMessage(settings)); len(conds) != 0 {
		t.Fatalf("no drift with the NodeConfig's taints: %+v", conds)
	}
	// Converged.
	if steps, err := u.Plan(context.Background(), c.sys, json.RawMessage(settings)); err != nil || len(steps) != 0 {
		t.Fatalf("second plan = %d steps, %v", len(steps), err)
	}
}

func TestEksJoinRefusesAnotherClusterAndChecksTheAllowlist(t *testing.T) {
	c := newFakeCluster(t)
	ca, caPin := eksCA(t)
	settings := eksSettings(ca, "")
	nodeadmJoined(c, "https://FEDCBA9876543210FEDCBA9876543210.gr7.us-east-1.eks.amazonaws.com")
	if _, err := settle(t, c.sys, JoinUnit{}, settings); !errors.Is(err, converge.ErrTerminal) || !strings.Contains(err.Error(), "belongs to") {
		t.Fatalf("another cluster: %v", err)
	}

	c = newFakeCluster(t)
	nodeadmJoined(c, eksEndpoint)
	// The allowlist pins the CA's key, derived from the certificateAuthority.
	allowed, err := ParseAllowedClusters(strings.ToLower(eksEndpoint) + "#sha256:" + caPin)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := settle(t, c.sys, JoinUnit{RequireAllowed: true, Allowed: allowed}, settings); err != nil {
		t.Fatalf("allowed: %v", err)
	}
	other := []Cluster{{Server: allowed[0].Server, CaCertSha256: strings.Repeat("f", 64)}}
	if _, err := settle(t, c.sys, JoinUnit{RequireAllowed: true, Allowed: other}, settings); !errors.Is(err, converge.ErrTerminal) {
		t.Fatalf("another CA: %v", err)
	}
}

func TestEksSettingsAreCheckedAgain(t *testing.T) {
	ca, _ := eksCA(t)
	notCert := base64.StdEncoding.EncodeToString([]byte("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"))
	for name, raw := range map[string]string{
		"kubeadm fields": eksSettings(ca, `,"tokenRef":"secret://pool-a/k8s"`),
		"server":         eksSettings(ca, `,"server":"https://10.0.0.1:6443"`),
		"version":        eksSettings(ca, `,"kubernetesVersion":"1.34.1"`),
		"unknown mode":   `{"mode":"kops","server":"https://10.0.0.1:6443","caCertSha256":"` + pin + `","tokenRef":"x"}`,
		"no cluster":     `{"mode":"eks"}`,
		"cluster field":  strings.Replace(eksSettings(ca, ""), `"cidr":`, `"token":"x","cidr":`, 1),
		"http endpoint":  strings.Replace(eksSettings(ca, ""), "https://", "http://", 1),
		"endpoint path":  strings.Replace(eksSettings(ca, ""), ".com\"", ".com/x\"", 1),
		"bad name":       strings.Replace(eksSettings(ca, ""), `"name":"training"`, `"name":"-x"`, 1),
		"not base64":     strings.Replace(eksSettings(ca, ""), ca, "%%%", 1),
		"not a cert":     strings.Replace(eksSettings(ca, ""), ca, notCert, 1),
		"bad cidr":       strings.Replace(eksSettings(ca, ""), "172.20.0.0/16", "172.20.0.0", 1),
		"bad taint":      strings.Replace(eksSettings(ca, ""), "nvidia.com/gpu=:NoSchedule", "x", 1),
		"reserved label": strings.Replace(eksSettings(ca, ""), `"team":"ml"`, `"kubernetes.io/role":"x"`, 1),
	} {
		if _, err := parseSettings(json.RawMessage(raw)); !errors.Is(err, converge.ErrTerminal) {
			t.Errorf("%s: %v", name, err)
		}
	}
	p, err := parseSettings(json.RawMessage(eksSettings(ca, "")))
	if err != nil || !p.eks || p.Server != eksEndpoint || p.endpoint != strings.TrimPrefix(eksEndpoint, "https://")+":443" {
		t.Fatalf("parsed = %+v, %v", p, err)
	}
}
