package agent

import (
	"crypto"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"

	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/tpm"
)

// The node key (KeyFile, NextKeyFile) is a P-256 key in the host's TPM when it has one, else a
// PKCS#8 file. A TPM key never leaves the TPM: the file holds only the per-key unique its primary is
// derived from (tpm.NodeKeyTemplate), and the key is derived again at each load. Whatever holds it,
// the node key is a crypto.Signer and every signature (TLS, CSRs, Renew proofs, node statements, the
// WebSocket proof) is the same on the wire.

// TPM opens where node keys are made in the host's TPM (cmd/bcd sets it where /dev/tpmrm0 answers;
// fakehw builds on request): the TPM itself when bcd runs as root (tpm.DeviceKeys), else bcd helper,
// so an unprivileged bcd node never holds the TPM (whose hierarchies it could otherwise lock or
// clear). Nil: new node keys are files. A key already in the TPM needs it to load either way.
var TPM func() (tpm.Keys, error)

// tpmKeyBlock is the PEM type of a TPM node key's record: its unique.
const tpmKeyBlock = "BCD TPM NODE KEY"

// The node keys' TPM, opened once: one connection keeps their handles valid together.
var (
	tpmOnce sync.Once
	tpmKeys tpm.Keys
	tpmErr  error
)

// resetTPM forgets the opened connection (tests that change TPM).
func resetTPM() {
	tpmOnce, tpmKeys, tpmErr = sync.Once{}, nil, nil
}

func openTPM() (tpm.Keys, error) {
	if TPM == nil {
		return nil, errors.New("agent: this host has no TPM for node keys")
	}
	tpmOnce.Do(func() { tpmKeys, tpmErr = TPM() })
	return tpmKeys, tpmErr
}

// NodeKeyKind names what holds a node key: "tpm" or "file".
func NodeKeyKind(key crypto.Signer) string {
	if _, ok := key.(tpm.Key); ok {
		return "tpm"
	}
	return "file"
}

// newNodeKey makes a node key: in the TPM when there is one (a warning and a file key when the TPM
// cannot hold it), else a file key. It returns the key and the record to store for it.
func newNodeKey(log *slog.Logger) (crypto.Signer, []byte, error) {
	if TPM != nil {
		key, record, err := newTPMKey()
		if err == nil {
			return key, record, nil
		}
		if log != nil {
			log.Warn("the TPM cannot hold the node key; using a file key", "error", err.Error())
		}
	}
	return newFileKey()
}

// NodeKeyHolder is an attestor that makes the join's node key in its own TPM and certifies it in its
// answer (tpm.Attestor): the control plane then knows the key cannot leave the machine.
type NodeKeyHolder interface {
	HoldNodeKey(unique []byte) (crypto.Signer, error)
}

// joinKey makes the join's node key: in the attestor's TPM, certified, when it holds keys and node keys
// can use the TPM here (bcd node loads it through TPM); else as newNodeKey does.
func joinKey(attest ChallengeAttestor, log *slog.Logger) (crypto.Signer, []byte, error) {
	if holder, ok := attest.(NodeKeyHolder); ok && TPM != nil {
		unique := make([]byte, tpm.NodeKeyUniqueSize)
		if _, err := rand.Read(unique); err != nil {
			return nil, nil, err
		}
		key, err := holder.HoldNodeKey(unique)
		if err != nil {
			return nil, nil, fmt.Errorf("agent: the node key in the attestor's TPM: %w", err)
		}
		return key, tpmKeyRecord(unique), nil
	}
	return newNodeKey(log)
}

func newTPMKey() (tpm.Key, []byte, error) {
	keys, err := openTPM()
	if err != nil {
		return nil, nil, err
	}
	return newKeyIn(keys)
}

// newKeyIn makes a node key of a fresh unique in keys, and its record.
func newKeyIn(keys tpm.Keys) (tpm.Key, []byte, error) {
	unique := make([]byte, tpm.NodeKeyUniqueSize)
	if _, err := rand.Read(unique); err != nil {
		return nil, nil, err
	}
	key, err := keys.NodeKey(unique)
	if err != nil {
		return nil, nil, err
	}
	return key, tpmKeyRecord(unique), nil
}

// tpmKeyRecord is the stored record of a TPM node key.
func tpmKeyRecord(unique []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: tpmKeyBlock, Bytes: unique})
}

func newFileKey() (crypto.Signer, []byte, error) {
	key, err := pki.GenerateKey()
	if err != nil {
		return nil, nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	return key, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

// saveNodeKey writes a node key's record (mode 0600, atomically).
func saveNodeKey(path string, record []byte) error {
	return pki.WriteFileAtomic(path, record, 0o600)
}

// loadNodeKey loads the node key a record file holds: a TPM key derived again, or a file key.
func loadNodeKey(path string) (crypto.Signer, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != tpmKeyBlock {
		return pki.LoadPrivateKey(path)
	}
	keys, err := openTPM()
	if err != nil {
		return nil, fmt.Errorf("%s is a key in the TPM: %w", path, err)
	}
	key, err := keys.NodeKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	return key, nil
}

// closeKey unloads a TPM key that is no longer used (a file key has nothing to unload).
func closeKey(key crypto.Signer) {
	if c, ok := key.(io.Closer); ok {
		_ = c.Close()
	}
}
