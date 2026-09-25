package pki

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strings"
)

// Compact JWE with alg ECDH-ES+A256KW and enc A256GCM (RFC 7516, RFC 7518 §4.6, §5.3) to a P-256
// key, as @better-compute/pki's jwe.ts: sealed join tokens (to the JoinService encryption key) and
// SecretResponse / WorkloadTokenResponse JWEs (to a one-time key). Only this pair is produced or
// accepted.
const (
	JWEAlgorithm  = "ECDH-ES+A256KW"
	JWEEncryption = "A256GCM"
	maxJWELength  = 256 * 1024
)

var errJWE = errors.New("pki: cannot open JWE")

var reservedJWEMembers = map[string]bool{"alg": true, "enc": true, "epk": true, "zip": true, "crit": true, "apu": true, "apv": true}

// concatKDF is the Concat KDF of RFC 7518 §4.6.2 for 256 bits with empty apu/apv (one SHA-256 round).
func concatKDF(shared []byte) []byte {
	h := sha256.New()
	var buf [4]byte
	binary.BigEndian.PutUint32(buf[:], 1)
	h.Write(buf[:])
	h.Write(shared)
	lp := func(b []byte) {
		binary.BigEndian.PutUint32(buf[:], uint32(len(b)))
		h.Write(buf[:])
		h.Write(b)
	}
	lp([]byte(JWEAlgorithm))
	lp(nil)
	lp(nil)
	binary.BigEndian.PutUint32(buf[:], 256)
	h.Write(buf[:])
	return h.Sum(nil)
}

var keyWrapIV = [8]byte{0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6}

// keyWrap is AES key wrap (RFC 3394) of a key a multiple of 8 bytes long.
func keyWrap(kek, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(kek)
	if err != nil {
		return nil, err
	}
	n := len(key) / 8
	if len(key)%8 != 0 || n < 2 {
		return nil, errors.New("pki: key wrap needs a multiple of 8 bytes")
	}
	a := keyWrapIV
	r := make([]byte, len(key))
	copy(r, key)
	var b [16]byte
	for j := 0; j < 6; j++ {
		for i := 0; i < n; i++ {
			copy(b[:8], a[:])
			copy(b[8:], r[i*8:(i+1)*8])
			block.Encrypt(b[:], b[:])
			t := uint64(n*j + i + 1)
			binary.BigEndian.PutUint64(a[:], binary.BigEndian.Uint64(b[:8])^t)
			copy(r[i*8:(i+1)*8], b[8:])
		}
	}
	return append(a[:], r...), nil
}

// keyUnwrap reverses keyWrap and checks the integrity value.
func keyUnwrap(kek, wrapped []byte) ([]byte, error) {
	block, err := aes.NewCipher(kek)
	if err != nil {
		return nil, err
	}
	if len(wrapped)%8 != 0 || len(wrapped) < 24 {
		return nil, errJWE
	}
	n := len(wrapped)/8 - 1
	var a [8]byte
	copy(a[:], wrapped[:8])
	r := make([]byte, n*8)
	copy(r, wrapped[8:])
	var b [16]byte
	for j := 5; j >= 0; j-- {
		for i := n - 1; i >= 0; i-- {
			t := uint64(n*j + i + 1)
			binary.BigEndian.PutUint64(b[:8], binary.BigEndian.Uint64(a[:])^t)
			copy(b[8:], r[i*8:(i+1)*8])
			block.Decrypt(b[:], b[:])
			copy(a[:], b[:8])
			copy(r[i*8:(i+1)*8], b[8:])
		}
	}
	if subtle.ConstantTimeCompare(a[:], keyWrapIV[:]) != 1 {
		return nil, errJWE
	}
	return r, nil
}

// SealJWE encrypts plaintext to recipient as a compact JWE; header adds protected members (typ, kid,
// and purpose-specific bindings) that must not collide with alg, enc or epk.
func SealJWE(plaintext []byte, recipient *ecdsa.PublicKey, header map[string]any) (string, error) {
	for k := range header {
		if reservedJWEMembers[k] {
			return "", errors.New("pki: JWE header member " + k + " is reserved")
		}
	}
	peer, err := recipient.ECDH()
	if err != nil {
		return "", err
	}
	eph, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	shared, err := eph.ECDH(peer)
	if err != nil {
		return "", err
	}
	kek := concatKDF(shared)
	cek := make([]byte, 32)
	if _, err := rand.Read(cek); err != nil {
		return "", err
	}
	wrapped, err := keyWrap(kek, cek)
	if err != nil {
		return "", err
	}
	point := eph.PublicKey().Bytes()
	protected := make(map[string]any, len(header)+3)
	for k, v := range header {
		protected[k] = v
	}
	protected["alg"] = JWEAlgorithm
	protected["enc"] = JWEEncryption
	protected["epk"] = JWK{
		Kty: "EC",
		Crv: "P-256",
		X:   base64.RawURLEncoding.EncodeToString(point[1:33]),
		Y:   base64.RawURLEncoding.EncodeToString(point[33:65]),
	}
	headerJSON, err := json.Marshal(protected)
	if err != nil {
		return "", err
	}
	encodedHeader := base64.RawURLEncoding.EncodeToString(headerJSON)
	block, err := aes.NewCipher(cek)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, 12)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, plaintext, []byte(encodedHeader))
	ciphertext, tag := sealed[:len(sealed)-16], sealed[len(sealed)-16:]
	enc := base64.RawURLEncoding.EncodeToString
	return strings.Join([]string{encodedHeader, enc(wrapped), enc(iv), enc(ciphertext), enc(tag)}, "."), nil
}

// OpenedJWE is a decrypted JWE and its protected header.
type OpenedJWE struct {
	Header    map[string]any
	Plaintext []byte
}

// OpenJWE decrypts a compact JWE with the recipient's key. With typ, the header's typ must equal it,
// so a JWE sealed for one purpose never opens as another. Every failure is the same error.
func OpenJWE(jwe string, key *ecdsa.PrivateKey, typ string) (OpenedJWE, error) {
	if len(jwe) > maxJWELength {
		return OpenedJWE{}, errJWE
	}
	parts := strings.Split(jwe, ".")
	if len(parts) != 5 {
		return OpenedJWE{}, errJWE
	}
	dec := base64.RawURLEncoding.DecodeString
	headerJSON, err := dec(parts[0])
	if err != nil {
		return OpenedJWE{}, errJWE
	}
	var header map[string]any
	if err := json.Unmarshal(headerJSON, &header); err != nil {
		return OpenedJWE{}, errJWE
	}
	if header["alg"] != JWEAlgorithm || header["enc"] != JWEEncryption {
		return OpenedJWE{}, errJWE
	}
	if _, zip := header["zip"]; zip {
		return OpenedJWE{}, errJWE
	}
	if _, crit := header["crit"]; crit {
		return OpenedJWE{}, errJWE
	}
	if typ != "" && header["typ"] != typ {
		return OpenedJWE{}, errJWE
	}
	epkRaw, ok := header["epk"].(map[string]any)
	if !ok {
		return OpenedJWE{}, errJWE
	}
	if _, private := epkRaw["d"]; private {
		return OpenedJWE{}, errJWE
	}
	x, _ := epkRaw["x"].(string)
	y, _ := epkRaw["y"].(string)
	kty, _ := epkRaw["kty"].(string)
	crv, _ := epkRaw["crv"].(string)
	epk, err := JWK{Kty: kty, Crv: crv, X: x, Y: y}.PublicKey()
	if err != nil {
		return OpenedJWE{}, errJWE
	}
	peer, err := epk.ECDH()
	if err != nil {
		return OpenedJWE{}, errJWE
	}
	own, err := key.ECDH()
	if err != nil {
		return OpenedJWE{}, errJWE
	}
	shared, err := own.ECDH(peer)
	if err != nil {
		return OpenedJWE{}, errJWE
	}
	wrapped, err := dec(parts[1])
	if err != nil {
		return OpenedJWE{}, errJWE
	}
	cek, err := keyUnwrap(concatKDF(shared), wrapped)
	if err != nil || len(cek) != 32 {
		return OpenedJWE{}, errJWE
	}
	iv, err1 := dec(parts[2])
	ciphertext, err2 := dec(parts[3])
	tag, err3 := dec(parts[4])
	if err1 != nil || err2 != nil || err3 != nil || len(iv) != 12 || len(tag) != 16 {
		return OpenedJWE{}, errJWE
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		return OpenedJWE{}, errJWE
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return OpenedJWE{}, errJWE
	}
	plaintext, err := gcm.Open(nil, iv, append(ciphertext, tag...), []byte(parts[0]))
	if err != nil {
		return OpenedJWE{}, errJWE
	}
	return OpenedJWE{Header: header, Plaintext: plaintext}, nil
}
