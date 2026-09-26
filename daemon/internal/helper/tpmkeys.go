package helper

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/tpm"
)

// Node keys in the TPM for an unprivileged bcd node (security review 3). The kernel's resource
// manager filters no commands: whoever opens /dev/tpmrm0 can change the hierarchies' authorization,
// clear the TPM through the (empty) lockout authorization or trip its dictionary-attack lockout,
// breaking root's TPM-sealed secrets (LUKS keys, measured boot). So bcd node never opens it. Root's
// helper holds the TPM and serves four things only, for node keys named by their unique
// (tpm.NodeKeyTemplate: fixedTPM, fixedParent, sensitiveDataOrigin, noDA):
//
//   - tpm.nodekey: derive a node key, answer its TPMT_PUBLIC;
//   - tpm.sign: sign a SHA-256/384/512 digest with one;
//   - tpm.ak and tpm.certify: the AK's public area, and its TPM2_Certify of a node key over a 32-byte
//     qualifying value (a renewal's sha256(csr));
//   - tpm.release: unload one.
//
// The helper builds every TPM command itself, always with the empty password the templates set; the
// node chooses no template, handle, hierarchy or authorization. At most maxTPMKeys node keys stay
// loaded (least recently used unloaded first); one is derived again whenever it is used.

// TPMRequest is tpm.<verb>'s arguments.
type TPMRequest struct {
	// Unique names the node key (tpm.NodeKeyUniqueSize bytes).
	Unique []byte `json:"unique,omitempty"`
	// Digest is what tpm.sign signs.
	Digest []byte `json:"digest,omitempty"`
	// Qualifying is tpm.certify's extraData (32 bytes).
	Qualifying []byte `json:"qualifying,omitempty"`
}

// TPMResult is tpm.<verb>'s answer.
type TPMResult struct {
	// Public is the node key's TPMT_PUBLIC (tpm.nodekey).
	Public []byte `json:"public,omitempty"`
	// Signature is tpm.sign's ASN.1 ECDSA signature, or tpm.certify's TPMT_SIGNATURE by the AK.
	Signature []byte `json:"signature,omitempty"`
	// Attest is tpm.certify's TPMS_ATTEST.
	Attest []byte `json:"attest,omitempty"`
	// AKPublic is the AK's TPMT_PUBLIC (tpm.ak, tpm.certify).
	AKPublic []byte `json:"akPublic,omitempty"`
}

// maxTPMKeys bounds the node keys the helper keeps loaded (TPM object slots are few).
const maxTPMKeys = 8

// tpmKeys is the helper's TPM state: the keys it loaded, and the AK.
type tpmKeys struct {
	mu     sync.Mutex
	keys   tpm.Keys
	ak     tpm.KeyCertifier
	loaded map[string]*loadedKey
	clock  uint64
}

type loadedKey struct {
	key  tpm.Key
	used uint64
}

// tpmOp serves tpm.<verb>.
func (s *Server) tpmOp(verb string, req *TPMRequest) (any, error) {
	if s.TPM == nil {
		return nil, errors.New("node keys in the TPM are not served by this helper (the host has no TPM)")
	}
	if req == nil {
		return nil, errors.New("tpm: no arguments")
	}
	st := &s.tpm
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.keys == nil {
		keys, err := s.TPM()
		if err != nil {
			return nil, fmt.Errorf("tpm: %w", err)
		}
		st.keys, st.loaded = keys, map[string]*loadedKey{}
	}
	switch verb {
	case "ak":
		ak, err := st.certifier()
		if err != nil {
			return nil, err
		}
		return TPMResult{AKPublic: ak.AKPublic()}, nil
	case "release":
		if len(req.Unique) != tpm.NodeKeyUniqueSize {
			return nil, errors.New("tpm: a node key's unique is 32 bytes")
		}
		if k := st.loaded[hex.EncodeToString(req.Unique)]; k != nil {
			delete(st.loaded, hex.EncodeToString(req.Unique))
			return nil, k.key.Close()
		}
		return nil, nil
	}
	key, err := st.key(req.Unique)
	if err != nil {
		return nil, err
	}
	switch verb {
	case "nodekey":
		return TPMResult{Public: key.PublicArea()}, nil
	case "sign":
		if n := len(req.Digest); n != 32 && n != 48 && n != 64 {
			return nil, errors.New("tpm: a digest is SHA-256, -384 or -512")
		}
		sig, err := key.Sign(nil, req.Digest, nil)
		if err != nil {
			return nil, err
		}
		return TPMResult{Signature: sig}, nil
	case "certify":
		if len(req.Qualifying) != 32 {
			return nil, errors.New("tpm: the qualifying data is 32 bytes (sha256 of the CSR)")
		}
		ak, err := st.certifier()
		if err != nil {
			return nil, err
		}
		attest, sig, err := ak.CertifyNodeKey(key, req.Qualifying)
		if err != nil {
			return nil, err
		}
		return TPMResult{Attest: attest, Signature: sig, AKPublic: ak.AKPublic()}, nil
	}
	return nil, fmt.Errorf("unknown operation %q", "tpm."+verb)
}

// key is the node key of unique, derived when it is not loaded (the least recently used one is
// unloaded to make room).
func (st *tpmKeys) key(unique []byte) (tpm.Key, error) {
	if len(unique) != tpm.NodeKeyUniqueSize {
		return nil, errors.New("tpm: a node key's unique is 32 bytes")
	}
	st.clock++
	id := hex.EncodeToString(unique)
	if k := st.loaded[id]; k != nil {
		k.used = st.clock
		return k.key, nil
	}
	if len(st.loaded) >= maxTPMKeys {
		oldest := ""
		for id, k := range st.loaded {
			if oldest == "" || k.used < st.loaded[oldest].used {
				oldest = id
			}
		}
		_ = st.loaded[oldest].key.Close()
		delete(st.loaded, oldest)
	}
	k, err := st.keys.NodeKey(unique)
	if err != nil {
		return nil, err
	}
	st.loaded[id] = &loadedKey{key: k, used: st.clock}
	return k, nil
}

func (st *tpmKeys) certifier() (tpm.KeyCertifier, error) {
	if st.ak == nil {
		ak, err := st.keys.Certifier()
		if err != nil {
			return nil, err
		}
		st.ak = ak
	}
	return st.ak, nil
}

// TPMKeys is tpm.Keys through the helper: bcd node's TPM node keys, which it never opens itself.
type TPMKeys struct {
	Client Client
}

func (k TPMKeys) call(verb string, req TPMRequest) (TPMResult, error) {
	c := k.Client
	c.Timeout = 30 * time.Second
	raw, err := c.Call(context.Background(), Request{Op: "tpm." + verb, TPM: &req})
	var out TPMResult
	if err == nil && len(raw) > 0 && string(raw) != "null" {
		err = json.Unmarshal(raw, &out)
	}
	return out, err
}

// NodeKey derives the node key of unique in root's TPM.
func (k TPMKeys) NodeKey(unique []byte) (tpm.Key, error) {
	res, err := k.call("nodekey", TPMRequest{Unique: unique})
	if err != nil {
		return nil, err
	}
	pub, attrs, err := tpm.ECCPublic(res.Public)
	if err != nil || attrs != tpm.NodeKeyAttributes {
		return nil, fmt.Errorf("tpm: the helper's node key: attributes %#x, %v", attrs, err)
	}
	return &helperKey{keys: k, unique: bytes.Clone(unique), public: res.Public, pub: pub}, nil
}

// Certifier is the AK in root's TPM.
func (k TPMKeys) Certifier() (tpm.KeyCertifier, error) {
	res, err := k.call("ak", TPMRequest{})
	if err != nil {
		return nil, err
	}
	return &helperCertifier{keys: k, akPub: res.AKPublic}, nil
}

type helperKey struct {
	keys   TPMKeys
	unique []byte
	public []byte
	pub    *ecdsa.PublicKey
}

func (h *helperKey) Public() crypto.PublicKey { return h.pub }
func (h *helperKey) PublicArea() []byte       { return h.public }

// Sign signs in root's TPM; the signature is ASN.1 DER, as an ECDSA crypto.Signer's.
func (h *helperKey) Sign(_ io.Reader, digest []byte, _ crypto.SignerOpts) ([]byte, error) {
	res, err := h.keys.call("sign", TPMRequest{Unique: h.unique, Digest: digest})
	if err != nil {
		return nil, err
	}
	if !ecdsa.VerifyASN1(h.pub, digest, res.Signature) {
		return nil, errors.New("tpm: the helper's signature is not the node key's")
	}
	return res.Signature, nil
}

// Close unloads the key in the helper (it is derived again at the next use).
func (h *helperKey) Close() error {
	_, err := h.keys.call("release", TPMRequest{Unique: h.unique})
	return err
}

type helperCertifier struct {
	keys  TPMKeys
	akPub []byte
}

func (c *helperCertifier) AKPublic() []byte { return c.akPub }

func (c *helperCertifier) CertifyNodeKey(k tpm.Key, qualifying []byte) (attest, signature []byte, err error) {
	hk, ok := k.(*helperKey)
	if !ok {
		return nil, nil, errors.New("tpm: the node key is not in the helper's TPM")
	}
	res, err := c.keys.call("certify", TPMRequest{Unique: hk.unique, Qualifying: qualifying})
	if err != nil {
		return nil, nil, err
	}
	if !bytes.Equal(res.AKPublic, c.akPub) {
		return nil, nil, errors.New("tpm: the helper certified with another AK")
	}
	return res.Attest, res.Signature, nil
}

func (c *helperCertifier) Close() {}
