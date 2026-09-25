package pki

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// GenerateKey returns a fresh P-256 key, the only key type better-compute's PKI issues for.
func GenerateKey() (*ecdsa.PrivateKey, error) {
	return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
}

// SPKISHA256 returns the SHA-256 of the key's DER SubjectPublicKeyInfo.
func SPKISHA256(pub *ecdsa.PublicKey) ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(der)
	return sum[:], nil
}

// MatchesPin reports whether pub's SPKI SHA-256 equals pin (compared in constant time).
func MatchesPin(pub *ecdsa.PublicKey, pin []byte) bool {
	actual, err := SPKISHA256(pub)
	if err != nil || len(pin) != len(actual) {
		return false
	}
	return subtle.ConstantTimeCompare(actual, pin) == 1
}

// KeyID is a node key's Signature.kid: base64url (no padding) of its SPKI SHA-256.
func KeyID(pub *ecdsa.PublicKey) (string, error) {
	sum, err := SPKISHA256(pub)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(sum), nil
}

// Point returns pub as an uncompressed SEC1 point (65 bytes), as SecretRequest.epk carries it.
func Point(pub *ecdsa.PublicKey) ([]byte, error) {
	return pub.Bytes()
}

// JWK is a public P-256 key as a JSON Web Key.
type JWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
	Kid string `json:"kid,omitempty"`
}

// PublicJWK returns pub as a JWK.
func PublicJWK(pub *ecdsa.PublicKey) (JWK, error) {
	point, err := Point(pub)
	if err != nil {
		return JWK{}, err
	}
	return JWK{
		Kty: "EC",
		Crv: "P-256",
		X:   base64.RawURLEncoding.EncodeToString(point[1:33]),
		Y:   base64.RawURLEncoding.EncodeToString(point[33:65]),
	}, nil
}

// PublicKey decodes the JWK into a P-256 public key, validating that the point is on the curve.
func (j JWK) PublicKey() (*ecdsa.PublicKey, error) {
	if j.Kty != "EC" || j.Crv != "P-256" {
		return nil, errors.New("pki: a JWK must be an EC P-256 key")
	}
	x, err := base64.RawURLEncoding.DecodeString(j.X)
	if err != nil || len(x) != 32 {
		return nil, errors.New("pki: bad JWK x")
	}
	y, err := base64.RawURLEncoding.DecodeString(j.Y)
	if err != nil || len(y) != 32 {
		return nil, errors.New("pki: bad JWK y")
	}
	point := append(append([]byte{4}, x...), y...)
	return PublicKeyFromPoint(point)
}

// ParseJWK parses a JWK document (the install script's /etc/bcd/join-encryption.jwk).
func ParseJWK(data []byte) (*ecdsa.PublicKey, error) {
	var j JWK
	if err := json.Unmarshal(data, &j); err != nil {
		return nil, fmt.Errorf("pki: JWK: %w", err)
	}
	return j.PublicKey()
}

// PublicKeyFromPoint decodes an uncompressed SEC1 P-256 point, rejecting points off the curve.
func PublicKeyFromPoint(point []byte) (*ecdsa.PublicKey, error) {
	if len(point) != 65 || point[0] != 4 {
		return nil, errors.New("pki: expected an uncompressed P-256 point (65 bytes)")
	}
	pub, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), point)
	if err != nil {
		return nil, fmt.Errorf("pki: %w", err)
	}
	return pub, nil
}

// SavePrivateKey writes key as PKCS#8 PEM with mode 0600, atomically (write, fsync, rename).
func SavePrivateKey(path string, key *ecdsa.PrivateKey) error {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600)
}

// LoadPrivateKey reads a PKCS#8 PEM P-256 key.
func LoadPrivateKey(path string) (*ecdsa.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("pki: %s holds no PKCS#8 private key", path)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("pki: %s: %w", path, err)
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok || key.Curve != elliptic.P256() {
		return nil, fmt.Errorf("pki: %s is not a P-256 key", path)
	}
	return key, nil
}

// writeFileAtomic writes data to path through a temporary file in the same directory, fsyncs it and
// renames it into place, so a crash leaves either the old or the new file.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(mode); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// WriteFileAtomic is writeFileAtomic for other packages (certificates, state files).
func WriteFileAtomic(path string, data []byte, mode os.FileMode) error {
	return writeFileAtomic(path, data, mode)
}
