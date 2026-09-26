package main

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/config"
)

// k8sContract is testdata/k8s-daemonset.json, written by scripts/daemon-k8s-contract.mjs from
// @better-compute/provider-kubernetes: the config.toml its ConfigMap carries and its containers' commands.
type k8sContract struct {
	Options struct {
		GatewayURL        string `json:"gatewayUrl"`
		SiteID            string `json:"siteId"`
		ControlPlaneURL   string `json:"controlPlaneUrl"`
		GatewayServerName string `json:"gatewayServerName"`
		Pins              struct {
			ServingCA      string `json:"servingCaPin"`
			JoinSigning    string `json:"joinSigningPin"`
			JoinEncryption string `json:"joinEncryptionPin"`
		} `json:"pins"`
	} `json:"options"`
	Config string   `json:"config"`
	Join   []string `json:"join"`
	Node   []string `json:"node"`
	Probe  []string `json:"probe"`
}

func TestKubernetesDaemonSetContract(t *testing.T) {
	raw, err := os.ReadFile("testdata/k8s-daemonset.json")
	if err != nil {
		t.Fatal(err)
	}
	var kc k8sContract
	if err := json.Unmarshal(raw, &kc); err != nil {
		t.Fatal(err)
	}
	o := kc.Options

	// The ConfigMap's config.toml parses with bcd's strict parser, and leaves the host to the cluster.
	cfg, err := config.Parse([]byte(kc.Config))
	if err != nil {
		t.Fatalf("config.toml: %v\n%s", err, kc.Config)
	}
	if cfg.GatewayURL != o.GatewayURL || cfg.Site != o.SiteID || cfg.ServingCASPKIPin != o.Pins.ServingCA ||
		cfg.JoinSigningKeyPin != o.Pins.JoinSigning || cfg.JoinEncryptionKeyPin != o.Pins.JoinEncryption ||
		cfg.DataDir != config.DefaultDataDir || cfg.GatewayServerName != o.GatewayServerName || !cfg.ExternalHost {
		t.Fatalf("config = %+v", cfg)
	}

	// The join init container: the installed config, the Secret's token file, the well-known join key.
	name, join := parseInstalled(t, kc.Join)
	if name != "join" || join["config"] != config.DefaultPath || join["token-file"] != "/etc/bcd/token/token" ||
		join["server"] != o.ControlPlaneURL || join["node-id"] != "" || join["role"] != "node" {
		t.Fatalf("join = %s %v", name, join)
	}
	// The node container and its liveness probe.
	if name, node := parseInstalled(t, kc.Node); name != "node" || node["config"] != config.DefaultPath {
		t.Fatalf("node = %s %v", name, node)
	}
	if name, _ := parseInstalled(t, kc.Probe); name != "status" {
		t.Fatalf("probe = %s", name)
	}
}
