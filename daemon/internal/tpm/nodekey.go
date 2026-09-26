package tpm

import (
	"crypto"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/asn1"
	"errors"
	"fmt"
	"io"
	"math/big"
	"sync"
)

// NodeKeyAttributes are a node key's attributes: it never leaves the TPM (fixedTPM, fixedParent,
// sensitiveDataOrigin), signs with an empty password (userWithAuth, noDA), and is unrestricted (it
// signs the digests TLS, CSRs and node statements need), for signing only. tpmAttestor checks them
// in the public area the AK certifies.
const NodeKeyAttributes = attrFixedTPM | attrFixedParent | attrSensitiveDataOrigin | attrUserWithAuth | attrNoDA | attrSign

// NodeKeyTemplate is bcd node's own signing key: P-256, the scheme left open (ECDSA with the
// digest's hash at each Sign), a primary key of the owner hierarchy. The same unique (a random
// per-key value bcd keeps in its data directory) derives the same key again, so nothing is stored in,
// or evicted to, the TPM. Anyone with the owner hierarchy's authorization on this TPM (root on the
// node) can derive and use it as well: the key cannot be copied off the machine, not kept from its
// root.
func NodeKeyTemplate(unique []byte) []byte {
	w := &Writer{}
	w.U16(AlgECC)
	w.U16(AlgSHA256)
	w.U32(NodeKeyAttributes)
	w.B2B(nil)     // authPolicy
	w.U16(AlgNull) // symmetric
	w.U16(AlgNull) // scheme: chosen at each Sign
	w.U16(CurveP256)
	w.U16(AlgNull) // kdf
	w.B2B(unique)  // unique.x: tells this key from the node's others
	w.B2B(nil)     // unique.y
	return w.B
}

// NodeKeyUniqueSize is the size of a node key's unique value.
const NodeKeyUniqueSize = 32

// NodeKey is a node key loaded in a TPM: a crypto.Signer whose private half stays in the TPM.
type NodeKey struct {
	tpm    *TPM
	handle uint32
	public []byte
	pub    *ecdsa.PublicKey
}

// LoadNodeKey derives the node key of unique in the TPM behind t.
func LoadNodeKey(t Transport, unique []byte) (*NodeKey, error) { return loadNodeKey(New(t), unique) }

// NodeKey derives the node key of unique in the attestor's TPM, where its AK can certify it.
func (a *Attestor) NodeKey(unique []byte) (*NodeKey, error) { return loadNodeKey(a.tpm, unique) }

func loadNodeKey(t *TPM, unique []byte) (*NodeKey, error) {
	if len(unique) != NodeKeyUniqueSize {
		return nil, fmt.Errorf("tpm: a node key's unique is %d bytes", NodeKeyUniqueSize)
	}
	h, public, err := t.CreatePrimary(RHOwner, NodeKeyTemplate(unique))
	if err != nil {
		return nil, fmt.Errorf("tpm: the node key: %w", err)
	}
	pub, attrs, err := ECCPublic(public)
	if err != nil || attrs != NodeKeyAttributes {
		_ = t.Flush(h)
		return nil, fmt.Errorf("tpm: the node key's public area: attributes %#x, %v", attrs, err)
	}
	return &NodeKey{tpm: t, handle: h, public: public, pub: pub}, nil
}

// Public is the key's public half.
func (k *NodeKey) Public() crypto.PublicKey { return k.pub }

// PublicArea is the key's TPMT_PUBLIC (its name is what the AK certifies).
func (k *NodeKey) PublicArea() []byte { return k.public }

// Sign signs a digest (SHA-256, -384 or -512) in the TPM; the signature is ASN.1 DER, as an ECDSA
// crypto.Signer's.
func (k *NodeKey) Sign(_ io.Reader, digest []byte, _ crypto.SignerOpts) ([]byte, error) {
	if k.handle == 0 {
		return nil, errors.New("tpm: the node key is closed")
	}
	r, s, err := k.tpm.Sign(k.handle, digest)
	if err != nil {
		return nil, err
	}
	return asn1.Marshal(struct{ R, S *big.Int }{new(big.Int).SetBytes(r), new(big.Int).SetBytes(s)})
}

// Close unloads the key (it is derived again at the next load).
func (k *NodeKey) Close() error {
	if k.handle == 0 {
		return nil
	}
	err := k.tpm.Flush(k.handle)
	k.handle = 0
	return err
}

// CertifyNodeKey has the AK certify that k is loaded in this TPM, over qualifying (the join binds it
// to its CSR): the TPMS_ATTEST and its TPMT_SIGNATURE.
func (a *Attestor) CertifyNodeKey(k *NodeKey, qualifying []byte) (attest, signature []byte, err error) {
	if k.tpm != a.tpm {
		return nil, nil, errors.New("tpm: the node key is loaded in another TPM connection")
	}
	return a.tpm.Certify(k.handle, a.ak, qualifying)
}

// Key is a node key in a TPM, whoever holds the TPM connection: this process (*NodeKey) or bcd helper
// for an unprivileged bcd node, which never opens the TPM itself.
type Key interface {
	crypto.Signer
	// PublicArea is the key's TPMT_PUBLIC (its name is what an AK certifies).
	PublicArea() []byte
	Close() error
}

// KeyCertifier is the AK certifying node keys: at each renewal of a certificate that names it
// (urn:bc:tpm-ak:), the next key.
type KeyCertifier interface {
	AKPublic() []byte
	// CertifyNodeKey has the AK certify k over qualifying (sha256 of the renewal's CSR): the
	// TPMS_ATTEST and its TPMT_SIGNATURE.
	CertifyNodeKey(k Key, qualifying []byte) (attest, signature []byte, err error)
	Close()
}

// Keys derives node keys and certifies them, on one TPM connection.
type Keys interface {
	NodeKey(unique []byte) (Key, error)
	Certifier() (KeyCertifier, error)
}

// DeviceKeys is Keys over a TPM this process opened: one connection keeps the keys' handles valid
// together, and its commands are serialized for the TLS handshakes and statements that sign at once.
func DeviceKeys(t Transport) Keys { return &deviceKeys{tpm: New(&lockedTransport{t: t})} }

type deviceKeys struct{ tpm *TPM }

func (d *deviceKeys) NodeKey(unique []byte) (Key, error) {
	k, err := loadNodeKey(d.tpm, unique)
	if err != nil {
		return nil, err
	}
	return k, nil
}

func (d *deviceKeys) Certifier() (KeyCertifier, error) {
	c, err := newCertifier(d.tpm)
	if err != nil {
		return nil, err
	}
	return c, nil
}

type lockedTransport struct {
	mu sync.Mutex
	t  Transport
}

func (l *lockedTransport) Send(command []byte) ([]byte, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.t.Send(command)
}

// Certifier is the AK alone, without the EK (KeyCertifier over a TPM connection).
type Certifier struct {
	tpm   *TPM
	ak    uint32
	akPub []byte
}

// NewCertifier loads the AK (the same primary the join's Attestor certified the node key with).
func NewCertifier(t Transport) (*Certifier, error) { return newCertifier(New(t)) }

func newCertifier(t *TPM) (*Certifier, error) {
	c := &Certifier{tpm: t}
	h, pub, err := c.tpm.CreatePrimary(RHEndorsement, AKTemplate())
	if err != nil {
		return nil, fmt.Errorf("tpm: the attestation key: %w", err)
	}
	c.ak, c.akPub = h, pub
	return c, nil
}

// AKPublic is the AK's TPMT_PUBLIC; its Name is what the certificate names.
func (c *Certifier) AKPublic() []byte { return c.akPub }

// NodeKey derives the node key of unique where this AK can certify it.
func (c *Certifier) NodeKey(unique []byte) (*NodeKey, error) { return loadNodeKey(c.tpm, unique) }

// CertifyNodeKey has the AK certify k over qualifying (sha256 of the renewal's CSR).
func (c *Certifier) CertifyNodeKey(k Key, qualifying []byte) (attest, signature []byte, err error) {
	nk, ok := k.(*NodeKey)
	if !ok || nk.tpm != c.tpm {
		return nil, nil, errors.New("tpm: the node key is loaded in another TPM connection")
	}
	if nk.handle == 0 || c.ak == 0 {
		return nil, nil, errors.New("tpm: the node key or the AK is closed")
	}
	return c.tpm.Certify(nk.handle, c.ak, qualifying)
}

// Close unloads the AK.
func (c *Certifier) Close() {
	if c.ak != 0 {
		_ = c.tpm.Flush(c.ak)
		c.ak = 0
	}
}

// ParseCertify reads a TPMS_ATTEST of TPM2_Certify: its extraData (the qualifying data) and the
// certified object's name.
func ParseCertify(attest []byte) (extraData, name []byte, err error) {
	r := &Reader{B: attest}
	if r.U32() != 0xff544347 || r.U16() != 0x8017 {
		return nil, nil, errors.New("tpm: not a certification")
	}
	r.B2B() // qualifiedSigner
	extraData = r.B2B()
	r.Take(17) // clockInfo
	r.U64()    // firmwareVersion
	name = r.B2B()
	r.B2B() // qualifiedName
	return extraData, name, r.Err
}

// ECCPublic reads a P-256 TPMT_PUBLIC: its public key and its attributes.
func ECCPublic(public []byte) (*ecdsa.PublicKey, uint32, error) {
	r := &Reader{B: public}
	if r.U16() != AlgECC {
		return nil, 0, errors.New("tpm: not an ECC key")
	}
	r.U16() // nameAlg
	attrs := r.U32()
	r.B2B() // authPolicy
	if r.U16() != AlgNull {
		r.U16()
		r.U16()
	}
	if r.U16() != AlgNull {
		r.U16()
	}
	if r.U16() != CurveP256 {
		return nil, 0, errors.New("tpm: not a P-256 key")
	}
	if r.U16() != AlgNull {
		r.U16()
	}
	x, y := r.B2B(), r.B2B()
	if r.Err != nil {
		return nil, 0, r.Err
	}
	if len(x) > 32 || len(y) > 32 {
		return nil, 0, errors.New("tpm: the key is not on P-256")
	}
	point := append([]byte{4}, make([]byte, 64)...)
	copy(point[33-len(x):33], x)
	copy(point[65-len(y):], y)
	if _, err := ecdh.P256().NewPublicKey(point); err != nil {
		return nil, 0, errors.New("tpm: the key is not on P-256")
	}
	return &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}, attrs, nil
}
