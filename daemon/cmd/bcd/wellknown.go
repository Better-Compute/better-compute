package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/pki"
)

// wellKnownClient fetches the well-known document (system roots: the control plane's public TLS).
var wellKnownClient = &http.Client{Timeout: 30 * time.Second}

// wellKnownDoc is the part of <server>/.well-known/better-compute that bcd join reads: JoinService's
// public keys (PLAN.md §6 Install) and, when the control plane publishes it, where its gateway is.
type wellKnownDoc struct {
	Gateway *struct {
		URL          string `json:"url"`
		ServerName   string `json:"serverName"`
		ServingCAPin string `json:"servingCaPin"`
	} `json:"gateway"`
	Join *struct {
		EncryptionJwk    json.RawMessage `json:"encryptionJwk"`
		EncryptionKeyPin string          `json:"encryptionKeyPin"`
		SigningKeyPin    string          `json:"signingKeyPin"`
	} `json:"join"`
}

// fetchWellKnown reads <server>/.well-known/better-compute. The control plane must be https (a
// fakehw development build also takes http://, for a dev stack).
func fetchWellKnown(server string) (*wellKnownDoc, error) {
	if !strings.HasPrefix(server, "https://") && !(devBuild && strings.HasPrefix(server, "http://")) {
		return nil, errors.New("--server must be an https:// URL")
	}
	url := strings.TrimRight(server, "/") + "/.well-known/better-compute"
	// The document comes from the URL the install named, never from wherever a redirect points.
	client := *wellKnownClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s returned %s", url, resp.Status)
	}
	var doc wellKnownDoc
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&doc); err != nil {
		return nil, fmt.Errorf("%s: %w", url, err)
	}
	if doc.Join == nil || len(doc.Join.EncryptionJwk) == 0 {
		return nil, errors.New("the control plane publishes no join keys")
	}
	return &doc, nil
}

// wellKnownJWK fetches join.encryptionJwk from the well-known document.
func wellKnownJWK(server string) ([]byte, error) {
	doc, err := fetchWellKnown(server)
	if err != nil {
		return nil, err
	}
	return doc.Join.EncryptionJwk, nil
}

// installPins are the pins an install passes on bcd join's command line (--serving-ca-pin,
// --join-signing-pin, --join-encryption-pin): they come with the token from the control plane that
// provisioned the machine, so they do not depend on the well-known document's transport.
type installPins struct {
	ServingCA, JoinSigning, JoinEncryption string
}

func (p installPins) empty() bool {
	return p.ServingCA == "" && p.JoinSigning == "" && p.JoinEncryption == ""
}

// pinned returns the install's pin when there is one, refusing a published value that differs.
func pinned(name, install, published string) (string, error) {
	if install == "" {
		return published, nil
	}
	if _, err := config.DecodePin(install); err != nil {
		return "", fmt.Errorf("--%s: %w", name, err)
	}
	if published != "" && published != install {
		return "", fmt.Errorf("the control plane's well-known document does not match --%s: refusing to join", name)
	}
	return install, nil
}

// bootstrapConfig builds the configuration of a machine that has none yet (an OS provisioned with a
// token, the control plane URL and the pins) from the well-known document: the gateway and its
// server name, checked against the install's pins. The pins are required: a document authenticated
// only by the control plane's TLS certificate could otherwise hand the token to whoever serves it
// (DNS plus a certificate for the name). Only a fakehw development build joins without them. The
// site is not known until the join answers: the caller sets it before writing the file.
func bootstrapConfig(server string, pins installPins, dataDir string) (*config.Config, []byte, error) {
	if (pins.ServingCA == "" || pins.JoinSigning == "" || pins.JoinEncryption == "") && !(devBuild && pins.empty()) {
		return nil, nil, errors.New("joining without config.toml needs --serving-ca-pin, --join-signing-pin and --join-encryption-pin from the install")
	}
	doc, err := fetchWellKnown(server)
	if err != nil {
		return nil, nil, err
	}
	if doc.Gateway == nil || doc.Gateway.URL == "" {
		return nil, nil, errors.New("the control plane does not publish its gateway (well-known gateway.url); install /etc/bcd/config.toml instead")
	}
	cfg := config.Defaults()
	cfg.DataDir = dataDir
	cfg.GatewayURL = doc.Gateway.URL
	cfg.GatewayServerName = doc.Gateway.ServerName
	cfg.Site = "unknown" // replaced by the site the join answers with
	if cfg.ServingCASPKIPin, err = pinned("serving-ca-pin", pins.ServingCA, doc.Gateway.ServingCAPin); err != nil {
		return nil, nil, err
	}
	if cfg.JoinSigningKeyPin, err = pinned("join-signing-pin", pins.JoinSigning, doc.Join.SigningKeyPin); err != nil {
		return nil, nil, err
	}
	if cfg.JoinEncryptionKeyPin, err = pinned("join-encryption-pin", pins.JoinEncryption, doc.Join.EncryptionKeyPin); err != nil {
		return nil, nil, err
	}
	if cfg.ServingCASPKIPin == "" {
		return nil, nil, errors.New("the control plane publishes no serving-CA pin (well-known gateway.servingCaPin) and none was given")
	}
	cfg.DevInsecureH2C = devBuild && strings.HasPrefix(cfg.GatewayURL, "http://")
	if err := cfg.Validate(); err != nil {
		return nil, nil, fmt.Errorf("the well-known document: %w", err)
	}
	return cfg, doc.Join.EncryptionJwk, nil
}

// writeConfig installs a bootstrapped configuration (0600) and the JoinService encryption key beside
// it (0644, public), each through a temporary file so a crash never leaves half a file.
func writeConfig(file string, cfg *config.Config, jwk []byte) error {
	dir := filepath.Dir(file)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := pki.WriteFileAtomic(file, []byte(config.Render(cfg)), 0o600); err != nil {
		return err
	}
	if len(jwk) > 0 {
		return pki.WriteFileAtomic(filepath.Join(dir, joinKeyFile), jwk, 0o644)
	}
	return nil
}
