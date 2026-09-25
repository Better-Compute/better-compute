// Package bcx is the out-of-process driver protocol on the Go side (PLAN.md §5.5; proto
// bettercompute/driver/v1; @better-compute/driver-sdk handshake.ts): bcd hosting driver plugins
// (Start), and Go plugins serving drivers (Serve).
//
// Handshake (go-plugin style): the host execs the plugin with a magic cookie, a socket directory and
// its ephemeral client certificate; the plugin listens on a unix socket and prints one line
// `bcx|1|unix|<socket>|grpc|<base64url DER server certificate>` on stdout; the host dials it with
// mTLS. Both certificates are ephemeral self-signed P-256 and pinned byte for byte by the other side.
// Plugins are sha256-pinned: the host refuses a binary whose digest is not its pin.
package bcx

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"
)

// Protocol constants (handshake.ts).
const (
	MagicCookieKey   = "BCX_MAGIC_COOKIE"
	MagicCookieValue = "3f8e1c5a0b7d4e29a6c1f0d8b2e7a45c9d3b6f1e0a8c7d2b5e4f9a1c6b0d3e7f"
	SocketDirEnv     = "BCX_SOCKET_DIR"
	ClientCertEnv    = "BCX_CLIENT_CERT"
	ProtocolVersion  = 1
)

// Handshake is the plugin's announcement.
type Handshake struct {
	Network     string
	Address     string
	Certificate []byte
}

// Format renders the handshake line.
func (h Handshake) Format() string {
	return strings.Join([]string{"bcx", strconv.Itoa(ProtocolVersion), h.Network, h.Address, "grpc",
		base64.RawURLEncoding.EncodeToString(h.Certificate)}, "|")
}

// ParseHandshake parses a handshake line; the address is everything between the network and
// "grpc", so a socket path may contain '|'.
func ParseHandshake(line string) (Handshake, error) {
	fields := strings.Split(strings.TrimSpace(line), "|")
	if len(fields) < 6 || fields[0] != "bcx" {
		return Handshake{}, errors.New("bcx: expected bcx|1|<network>|…")
	}
	if fields[1] != strconv.Itoa(ProtocolVersion) {
		return Handshake{}, fmt.Errorf("bcx: unsupported protocol version %s", fields[1])
	}
	network := fields[2]
	if network != "unix" && network != "tcp" {
		return Handshake{}, fmt.Errorf("bcx: unknown network %s", network)
	}
	if fields[len(fields)-2] != "grpc" {
		return Handshake{}, errors.New("bcx: only the grpc protocol is supported")
	}
	address := strings.Join(fields[3:len(fields)-2], "|")
	if address == "" {
		return Handshake{}, errors.New("bcx: missing address")
	}
	cert, err := base64.RawURLEncoding.DecodeString(fields[len(fields)-1])
	if err != nil {
		return Handshake{}, errors.New("bcx: the server certificate is not base64url")
	}
	if _, err := x509.ParseCertificate(cert); err != nil {
		return Handshake{}, errors.New("bcx: the server certificate is not DER")
	}
	return Handshake{Network: network, Address: address, Certificate: cert}, nil
}

// identity is one side's ephemeral TLS identity.
type identity struct {
	tls tls.Certificate
	der []byte
}

// newIdentity makes a fresh self-signed P-256 certificate (CA, server and client usage, DNS name
// localhost), as createEphemeralIdentity does.
func newIdentity(commonName string) (identity, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return identity{}, err
	}
	serial := make([]byte, 16)
	_, _ = rand.Read(serial)
	serial[0] = serial[0]&0x7f | 0x01
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          new(big.Int).SetBytes(serial),
		Subject:               pkix.Name{Organization: []string{"bcx"}, CommonName: commonName},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.Add(10 * 365 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		DNSNames:              []string{"localhost"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return identity{}, err
	}
	return identity{tls: tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, der: der}, nil
}

func (i identity) pem() string {
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: i.der}))
}

// pinned verifies that the peer presented exactly the pinned certificate.
func pinned(want []byte) func([][]byte, [][]*x509.Certificate) error {
	return func(raw [][]byte, _ [][]*x509.Certificate) error {
		if len(raw) == 0 || !bytes.Equal(raw[0], want) {
			return errors.New("bcx: the peer is not the pinned certificate")
		}
		return nil
	}
}

func certFromPEM(text string) ([]byte, error) {
	block, rest := pem.Decode([]byte(text))
	if block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) > 0 {
		return nil, errors.New("bcx: expected exactly one PEM certificate")
	}
	return block.Bytes, nil
}
