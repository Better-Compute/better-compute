package agent

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/pki"
)

// Files in the data directory. The identity outlives a lost journal: a corrupt or wiped journal
// starts over with a new journal_id, but the node keeps its key and certificate (PLAN.md §6).
const (
	// KeyFile is the node key (0600): PKCS#8 PEM, or the record of a key in the TPM (nodekey.go).
	KeyFile = "node.key"
	// NextKeyFile holds the key a renewal is certifying until its certificate is stored.
	NextKeyFile = "node.key.next"
	// StateFile is the identity from the signed JoinResponse and later renewals (0600).
	StateFile = "identity.json"
)

// ErrNotJoined reports a data directory without an identity: run bcd join first.
var ErrNotJoined = errors.New("agent: this node has not joined (run bcd join)")

// State is the node's identity: what the verified JoinResponse (and later Renew and Welcome trust
// bundles) established.
type State struct {
	NodeID      string `json:"nodeId"`
	SiteID      string `json:"siteId"`
	TrustDomain string `json:"trustDomain"`
	// Role is the certificate role: node, site or ramdisk.
	Role string `json:"role"`
	// Chain is the node certificate chain, leaf first (DER).
	Chain    [][]byte  `json:"chain"`
	NotAfter time.Time `json:"notAfter"`
	// TrustVersion and TrustRoots are the command-signing trust (TrustBundle); no roots means signed
	// intent is not enforced (v0.1).
	TrustVersion uint64   `json:"trustVersion"`
	TrustRoots   [][]byte `json:"trustRoots,omitempty"`
	// TrustBundle is the whole bundle (serialized): its approver keys, thresholds and caps (v1.0
	// quorum) besides the roots.
	TrustBundle []byte `json:"trustBundle,omitempty"`
	// SignedTrustBundle is the SignedTrustBundle of TrustVersion as the JoinService key signed it
	// (serialized; from a Welcome): bcd helper takes host units' command-signing roots from it.
	SignedTrustBundle []byte `json:"signedTrustBundle,omitempty"`
	// ServerTime mirrors the journal's server time high-water mark at each Welcome, so a lost journal
	// does not reset it (journal.Meta.ServerTime).
	ServerTime time.Time `json:"serverTime,omitempty"`
}

// Leaf parses the node certificate.
func (s *State) Leaf() (*x509.Certificate, error) {
	if len(s.Chain) == 0 {
		return nil, errors.New("agent: no node certificate")
	}
	return x509.ParseCertificate(s.Chain[0])
}

// LoadState reads the identity and the node key from dir (a file key, or one in the TPM). A renewal
// interrupted after its certificate was stored promotes the next key; one interrupted before keeps
// the current key.
func LoadState(dir string) (*State, crypto.Signer, error) {
	data, err := os.ReadFile(filepath.Join(dir, StateFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, ErrNotJoined
	}
	if err != nil {
		return nil, nil, fmt.Errorf("agent: %w", err)
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, nil, fmt.Errorf("agent: %s: %w", StateFile, err)
	}
	leaf, err := s.Leaf()
	if err != nil {
		return nil, nil, fmt.Errorf("agent: %s: %w", StateFile, err)
	}
	leafKey, ok := leaf.PublicKey.(*ecdsa.PublicKey)
	if !ok {
		return nil, nil, errors.New("agent: the node certificate is not P-256")
	}
	if next, err := loadNodeKey(filepath.Join(dir, NextKeyFile)); err == nil {
		pub, _ := pki.NodePublic(next)
		closeKey(next)
		if pub != nil && pub.Equal(leafKey) {
			if err := os.Rename(filepath.Join(dir, NextKeyFile), filepath.Join(dir, KeyFile)); err != nil {
				return nil, nil, fmt.Errorf("agent: promote the renewed key: %w", err)
			}
		} else {
			_ = os.Remove(filepath.Join(dir, NextKeyFile))
		}
	}
	key, err := loadNodeKey(filepath.Join(dir, KeyFile))
	if err != nil {
		return nil, nil, fmt.Errorf("agent: %w", err)
	}
	if pub, err := pki.NodePublic(key); err != nil || !pub.Equal(leafKey) {
		kind := NodeKeyKind(key)
		closeKey(key)
		if kind == "tpm" {
			// The TPM derives another key from the same record: its owner hierarchy's seed changed
			// (TPM2_Clear, a firmware reset). The key is gone for good.
			return nil, nil, errors.New("agent: the node key does not match the node certificate: the TPM derives another key " +
				"from node.key (was the TPM cleared?); join again: bcd join --reset --yes, then bcd join")
		}
		return nil, nil, errors.New("agent: the node key does not match the node certificate; join again: bcd join --reset --yes, then bcd join")
	}
	return &s, key, nil
}

// SaveState writes the identity atomically with mode 0600.
func SaveState(dir string, s *State) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return pki.WriteFileAtomic(filepath.Join(dir, StateFile), append(data, '\n'), 0o600)
}

// stateFromLeaf fills the identity fields from a verified leaf certificate.
func stateFromLeaf(chain [][]byte) (*State, error) {
	leaf, err := x509.ParseCertificate(chain[0])
	if err != nil {
		return nil, err
	}
	id, err := pki.NodeIdentity(leaf)
	if err != nil {
		return nil, err
	}
	return &State{
		NodeID:      id.NodeID,
		SiteID:      id.SiteID,
		TrustDomain: id.TrustDomain,
		Role:        id.Role,
		Chain:       chain,
		NotAfter:    leaf.NotAfter,
	}, nil
}
