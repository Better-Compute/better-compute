// Package tpmsim is a software TPM 2.0 for tests and fakehw machines. It answers the commands
// internal/tpm sends, in the same wire format, from an EK (RSA 2048) and an AK (P-256) it keeps
// in memory or in a state file:
//   - ActivateCredential works as a TPM's does (RSA-OAEP seed, KDFa, AES-CFB, the outer HMAC) and
//     requires a policy session that passed PolicySecret(endorsement);
//   - quotes are real ECDSA signatures over the SHA-256 PCR bank.
//
// MakeCredential is the control plane's half, for tests.
package tpmsim

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"sync"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/tpm"
)

// Response codes the simulator answers with.
const (
	rcSuccess    = 0x000
	rcValue      = 0x084
	rcHandle     = 0x18B
	rcPolicyFail = 0x99D
	rcIntegrity  = 0x09F
	rcCommand    = 0x143
	rcSize       = 0x142
)

// Sim is a software TPM.
type Sim struct {
	// EKCert, when set, is the EK certificate in NV (tpm.EKCertIndex).
	EKCert []byte

	mu       sync.Mutex
	ek       *rsa.PrivateKey
	ak       *ecdsa.PrivateKey
	pcrs     [24][]byte
	counter  uint32
	objects  map[uint32][]byte // transient handle → public area
	sessions map[uint32]bool   // policy session → PolicySecret(endorsement) passed
	next     uint32
}

// New is a simulator with fresh keys and zeroed PCRs.
func New() (*Sim, error) {
	ek, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	ak, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	s := &Sim{ek: ek, ak: ak}
	for i := range s.pcrs {
		s.pcrs[i] = make([]byte, sha256.Size)
	}
	return s, nil
}

type state struct {
	EK   []byte   `json:"ek"`
	AK   []byte   `json:"ak"`
	PCRs []string `json:"pcrs"`
}

// Load is the simulator kept in path (created with fresh keys, and PCRs 0-7 extended with a boot's
// worth of measurements, when missing): the same machine across restarts.
func Load(path string) (*Sim, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		s, err := New()
		if err != nil {
			return nil, err
		}
		for i := 0; i < 8; i++ {
			s.Extend(i, []byte(fmt.Sprintf("fakehw boot measurement %d", i)))
		}
		ek, _ := x509.MarshalPKCS8PrivateKey(s.ek)
		ak, _ := x509.MarshalPKCS8PrivateKey(s.ak)
		st := state{EK: ek, AK: ak}
		for _, p := range s.pcrs {
			st.PCRs = append(st.PCRs, hex.EncodeToString(p))
		}
		out, _ := json.Marshal(st)
		return s, os.WriteFile(path, out, 0o600)
	}
	if err != nil {
		return nil, err
	}
	var st state
	if err := json.Unmarshal(raw, &st); err != nil || len(st.PCRs) != 24 {
		return nil, fmt.Errorf("tpmsim: %s is not a simulator's state", path)
	}
	ek, err := x509.ParsePKCS8PrivateKey(st.EK)
	if err != nil {
		return nil, err
	}
	ak, err := x509.ParsePKCS8PrivateKey(st.AK)
	if err != nil {
		return nil, err
	}
	s := &Sim{ek: ek.(*rsa.PrivateKey), ak: ak.(*ecdsa.PrivateKey)}
	for i, h := range st.PCRs {
		if s.pcrs[i], err = hex.DecodeString(h); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// EKPublicKey is the endorsement key's public key: what a manufacturer's EK certificate certifies.
func (s *Sim) EKPublicKey() *rsa.PublicKey { return &s.ek.PublicKey }

// Extend extends a SHA-256 PCR with data's digest.
func (s *Sim) Extend(pcr int, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := sha256.Sum256(data)
	h := sha256.Sum256(append(append([]byte{}, s.pcrs[pcr]...), d[:]...))
	s.pcrs[pcr] = h[:]
	s.counter++
}

// PCR is a SHA-256 PCR's value.
func (s *Sim) PCR(i int) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.pcrs[i]...)
}

// commandHandles is how many handles each command carries.
var commandHandles = map[uint32]int{
	tpm.CCCreatePrimary: 1, tpm.CCReadPublic: 1, tpm.CCFlushContext: 0, tpm.CCStartAuthSession: 2,
	tpm.CCPolicySecret: 2, tpm.CCActivateCredential: 2, tpm.CCQuote: 1, tpm.CCPCRRead: 0,
	tpm.CCNVReadPublic: 1, tpm.CCNVRead: 2,
}

type reply struct {
	rc      uint32
	handles []uint32
	params  []byte
}

// Send answers one command.
func (s *Sim) Send(cmd []byte) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := &tpm.Reader{B: cmd}
	tag, size, cc := r.U16(), r.U32(), r.U32()
	if r.Err != nil || int(size) != len(cmd) {
		return respond(tpm.TagNoSessions, reply{rc: rcSize}, 0), nil
	}
	n, ok := commandHandles[cc]
	if !ok {
		return respond(tpm.TagNoSessions, reply{rc: rcCommand}, 0), nil
	}
	handles := make([]uint32, n)
	for i := range handles {
		handles[i] = r.U32()
	}
	var auths []uint32 // the authorizing sessions' handles
	if tag == tpm.TagSessions {
		area := &tpm.Reader{B: r.Take(int(r.U32()))}
		for len(area.B) > 0 && area.Err == nil {
			auths = append(auths, area.U32())
			area.B2B()
			area.U8()
			area.B2B()
		}
		if area.Err != nil {
			return respond(tpm.TagNoSessions, reply{rc: rcSize}, 0), nil
		}
	}
	if r.Err != nil {
		return respond(tpm.TagNoSessions, reply{rc: rcSize}, 0), nil
	}
	out := s.run(cc, handles, auths, &tpm.Reader{B: r.B})
	return respond(tag, out, len(auths)), nil
}

func respond(tag uint16, out reply, auths int) []byte {
	w := &tpm.Writer{}
	if out.rc != rcSuccess {
		w.U16(tpm.TagNoSessions)
		w.U32(10)
		w.U32(out.rc)
		return w.B
	}
	w.U16(tag)
	w.U32(0)
	w.U32(rcSuccess)
	for _, h := range out.handles {
		w.U32(h)
	}
	if tag == tpm.TagSessions {
		w.U32(uint32(len(out.params)))
		w.Raw(out.params)
		for i := 0; i < auths; i++ {
			w.B2B(nil) // nonceTPM
			w.U8(0)    // sessionAttributes
			w.B2B(nil) // hmac
		}
	} else {
		w.Raw(out.params)
	}
	binary.BigEndian.PutUint32(w.B[2:], uint32(len(w.B)))
	return w.B
}

func (s *Sim) handle(public []byte) uint32 {
	if s.objects == nil {
		s.objects = map[uint32][]byte{}
	}
	s.next++
	h := 0x80000000 | s.next
	s.objects[h] = public
	return h
}

func (s *Sim) run(cc uint32, handles, auths []uint32, p *tpm.Reader) reply {
	switch cc {
	case tpm.CCCreatePrimary:
		p.B2B() // inSensitive
		template := p.B2B()
		public, err := s.public(template)
		if err != nil || p.Err != nil {
			return reply{rc: rcValue}
		}
		w := &tpm.Writer{}
		w.B2B(public)
		w.B2B(nil) // creationData
		w.B2B(nil) // creationHash
		w.U16(0x8021)
		w.U32(handles[0])
		w.B2B(nil)
		name, _ := tpm.Name(public)
		w.B2B(name)
		return reply{handles: []uint32{s.handle(public)}, params: w.B}
	case tpm.CCReadPublic:
		public, ok := s.objects[handles[0]]
		if !ok {
			return reply{rc: rcHandle}
		}
		name, _ := tpm.Name(public)
		w := &tpm.Writer{}
		w.B2B(public)
		w.B2B(name)
		w.B2B(name)
		return reply{params: w.B}
	case tpm.CCFlushContext:
		h := p.U32()
		if _, ok := s.objects[h]; ok {
			delete(s.objects, h)
		} else if _, ok := s.sessions[h]; ok {
			delete(s.sessions, h)
		} else {
			return reply{rc: rcHandle}
		}
		return reply{}
	case tpm.CCStartAuthSession:
		p.B2B() // nonceCaller
		p.B2B() // encryptedSalt
		if p.U8() != 1 || p.Err != nil {
			return reply{rc: rcValue} // policy sessions only
		}
		if s.sessions == nil {
			s.sessions = map[uint32]bool{}
		}
		s.next++
		h := 0x03000000 | s.next
		s.sessions[h] = false
		nonce := make([]byte, 16)
		_, _ = rand.Read(nonce)
		w := &tpm.Writer{}
		w.B2B(nonce)
		return reply{handles: []uint32{h}, params: w.B}
	case tpm.CCPolicySecret:
		if _, ok := s.sessions[handles[1]]; !ok {
			return reply{rc: rcHandle}
		}
		if handles[0] == tpm.RHEndorsement {
			s.sessions[handles[1]] = true
		}
		w := &tpm.Writer{}
		w.B2B(nil)
		w.U16(0x8025)
		w.U32(handles[0])
		w.B2B(nil)
		return reply{params: w.B}
	case tpm.CCActivateCredential:
		return s.activate(handles, auths, p)
	case tpm.CCQuote:
		return s.quote(handles, p)
	case tpm.CCPCRRead:
		return s.pcrRead(p)
	case tpm.CCNVReadPublic:
		if handles[0] != tpm.EKCertIndex || len(s.EKCert) == 0 {
			return reply{rc: rcHandle}
		}
		pub := &tpm.Writer{}
		pub.U32(tpm.EKCertIndex)
		pub.U16(tpm.AlgSHA256)
		pub.U32(0x62072001) // PPWRITE, PPREAD, OWNERREAD, AUTHREAD, NO_DA, WRITTEN, PLATFORMCREATE
		pub.B2B(nil)
		pub.U16(uint16(len(s.EKCert)))
		w := &tpm.Writer{}
		w.B2B(pub.B)
		w.B2B(append([]byte{0, tpm.AlgSHA256}, make([]byte, 32)...))
		return reply{params: w.B}
	case tpm.CCNVRead:
		size, off := int(p.U16()), int(p.U16())
		if handles[1] != tpm.EKCertIndex || len(s.EKCert) == 0 || size > 1024 || off+size > len(s.EKCert) {
			return reply{rc: rcValue}
		}
		w := &tpm.Writer{}
		w.B2B(s.EKCert[off : off+size])
		return reply{params: w.B}
	}
	return reply{rc: rcCommand}
}

// public is the public area CreatePrimary makes from template: the EK for an RSA template, the AK
// for an ECC one (the template's fields, the key's unique).
func (s *Sim) public(template []byte) ([]byte, error) {
	r := &tpm.Reader{B: template}
	typ := r.U16()
	r.U16() // nameAlg
	r.U32() // attributes
	r.B2B() // authPolicy
	if r.U16() != tpm.AlgNull {
		r.U16()
		r.U16()
	}
	if r.U16() != tpm.AlgNull {
		r.U16()
	}
	w := &tpm.Writer{}
	switch typ {
	case tpm.AlgRSA:
		r.U16()
		r.U32()
		w.Raw(template[:len(template)-len(r.B)])
		w.B2B(s.ek.N.FillBytes(make([]byte, 256)))
	case tpm.AlgECC:
		r.U16()
		if r.U16() != tpm.AlgNull {
			r.U16()
		}
		w.Raw(template[:len(template)-len(r.B)])
		w.B2B(s.ak.X.FillBytes(make([]byte, 32)))
		w.B2B(s.ak.Y.FillBytes(make([]byte, 32)))
	default:
		return nil, errors.New("key type")
	}
	if r.Err != nil {
		return nil, r.Err
	}
	return w.B, nil
}

func (s *Sim) isEK(h uint32) bool {
	pub, ok := s.objects[h]
	return ok && len(pub) >= 2 && binary.BigEndian.Uint16(pub) == tpm.AlgRSA
}

func (s *Sim) isAK(h uint32) bool {
	pub, ok := s.objects[h]
	return ok && len(pub) >= 2 && binary.BigEndian.Uint16(pub) == tpm.AlgECC
}

func (s *Sim) activate(handles, auths []uint32, p *tpm.Reader) reply {
	ak, ek := handles[0], handles[1]
	if !s.isAK(ak) || !s.isEK(ek) {
		return reply{rc: rcHandle}
	}
	// The EK is authorized by its policy: a policy session that passed PolicySecret(endorsement).
	if len(auths) != 2 || !s.sessions[auths[1]] {
		return reply{rc: rcPolicyFail}
	}
	delete(s.sessions, auths[1])
	blob, encSecret := p.B2B(), p.B2B()
	if p.Err != nil {
		return reply{rc: rcSize}
	}
	seed, err := rsa.DecryptOAEP(sha256.New(), nil, s.ek, encSecret, []byte("IDENTITY\x00"))
	if err != nil {
		return reply{rc: rcValue}
	}
	name, _ := tpm.Name(s.objects[ak])
	b := &tpm.Reader{B: blob}
	outer := b.B2B()
	enc := b.B
	if b.Err != nil {
		return reply{rc: rcSize}
	}
	mac := hmac.New(sha256.New, KDFa(seed, "INTEGRITY", nil, nil, 256))
	mac.Write(enc)
	mac.Write(name)
	if !hmac.Equal(mac.Sum(nil), outer) {
		return reply{rc: rcIntegrity}
	}
	plain := cfb(KDFa(seed, "STORAGE", name, nil, 128), enc, false)
	inner := &tpm.Reader{B: plain}
	cred := inner.B2B()
	if inner.Err != nil || len(inner.B) != 0 {
		return reply{rc: rcIntegrity}
	}
	w := &tpm.Writer{}
	w.B2B(cred)
	return reply{params: w.B}
}

func (s *Sim) quote(handles []uint32, p *tpm.Reader) reply {
	if !s.isAK(handles[0]) {
		return reply{rc: rcHandle}
	}
	nonce := p.B2B()
	if scheme := p.U16(); scheme != tpm.AlgNull {
		p.U16()
	}
	sels := tpm.ReadSelections(p)
	if p.Err != nil {
		return reply{rc: rcSize}
	}
	h := sha256.New()
	for _, sel := range sels {
		if sel.Hash != tpm.AlgSHA256 {
			return reply{rc: rcValue}
		}
		for _, i := range sel.PCRs {
			if i >= 24 {
				return reply{rc: rcValue}
			}
			h.Write(s.pcrs[i])
		}
	}
	name, _ := tpm.Name(s.objects[handles[0]])
	a := &tpm.Writer{}
	a.U32(0xff544347) // TPM_GENERATED_VALUE
	a.U16(0x8018)     // TPM_ST_ATTEST_QUOTE
	a.B2B(name)
	a.B2B(nonce)
	a.U64(uint64(time.Now().UnixMilli()))
	a.U32(0) // resetCount
	a.U32(0) // restartCount
	a.U8(1)  // safe
	a.U64(1) // firmwareVersion
	if err := tpm.WriteSelections(a, sels); err != nil {
		return reply{rc: rcValue}
	}
	a.B2B(h.Sum(nil))
	digest := sha256.Sum256(a.B)
	r, sv, err := ecdsa.Sign(rand.Reader, s.ak, digest[:])
	if err != nil {
		return reply{rc: rcValue}
	}
	w := &tpm.Writer{}
	w.B2B(a.B)
	w.U16(tpm.AlgECDSA)
	w.U16(tpm.AlgSHA256)
	w.B2B(r.FillBytes(make([]byte, 32)))
	w.B2B(sv.FillBytes(make([]byte, 32)))
	return reply{params: w.B}
}

// pcrRead answers at most eight PCRs a call, as TPMs do.
func (s *Sim) pcrRead(p *tpm.Reader) reply {
	sels := tpm.ReadSelections(p)
	if p.Err != nil {
		return reply{rc: rcSize}
	}
	var got []tpm.Selection
	var values [][]byte
	for _, sel := range sels {
		if sel.Hash != tpm.AlgSHA256 {
			continue // an unallocated bank: nothing read
		}
		out := tpm.Selection{Hash: sel.Hash}
		for _, i := range sel.PCRs {
			if i < 24 && len(values) < 8 {
				out.PCRs = append(out.PCRs, i)
				values = append(values, s.pcrs[i])
			}
		}
		if len(out.PCRs) > 0 {
			got = append(got, out)
		}
	}
	w := &tpm.Writer{}
	w.U32(s.counter)
	_ = tpm.WriteSelections(w, got)
	w.U32(uint32(len(values)))
	for _, v := range values {
		w.B2B(v)
	}
	return reply{params: w.B}
}

// KDFa is the TPM's key derivation (Part 1 §11.4.10.2) with SHA-256: counter-mode HMAC over the
// NUL-terminated label and the two contexts.
func KDFa(key []byte, label string, contextU, contextV []byte, bits int) []byte {
	n := (bits + 7) / 8
	var out []byte
	for counter := uint32(1); len(out) < n; counter++ {
		m := hmac.New(sha256.New, key)
		_ = binary.Write(m, binary.BigEndian, counter)
		m.Write([]byte(label))
		m.Write([]byte{0})
		m.Write(contextU)
		m.Write(contextV)
		_ = binary.Write(m, binary.BigEndian, uint32(bits))
		out = append(out, m.Sum(nil)...)
	}
	return out[:n]
}

// cfb is AES-CFB with a zero IV, the TPM's credential protection.
func cfb(key, in []byte, encrypt bool) []byte {
	block, _ := aes.NewCipher(key)
	out := make([]byte, len(in))
	iv := make([]byte, aes.BlockSize)
	if encrypt {
		cipher.NewCFBEncrypter(block, iv).XORKeyStream(out, in) //nolint:staticcheck // the TPM's own mode
	} else {
		cipher.NewCFBDecrypter(block, iv).XORKeyStream(out, in) //nolint:staticcheck // the TPM's own mode
	}
	return out
}

// MakeCredential is the control plane's half of credential activation for an RSA EK (the default
// template): the credential blob and the encrypted seed only the TPM holding the EK, with the object
// named akName loaded, can open.
func MakeCredential(ekPublic, akName, credential []byte) (blob, encryptedSecret []byte, err error) {
	r := &tpm.Reader{B: ekPublic}
	if r.U16() != tpm.AlgRSA {
		return nil, nil, errors.New("tpmsim: not an RSA EK")
	}
	r.U16()
	r.U32()
	r.B2B()
	r.Take(6) // AES-128-CFB
	r.U16()   // scheme
	r.U16()   // keyBits
	r.U32()   // exponent
	modulus := r.B2B()
	if r.Err != nil {
		return nil, nil, r.Err
	}
	pub := &rsa.PublicKey{N: new(big.Int).SetBytes(modulus), E: 65537}
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		return nil, nil, err
	}
	encryptedSecret, err = rsa.EncryptOAEP(sha256.New(), rand.Reader, pub, seed, []byte("IDENTITY\x00"))
	if err != nil {
		return nil, nil, err
	}
	inner := &tpm.Writer{}
	inner.B2B(credential)
	enc := cfb(KDFa(seed, "STORAGE", akName, nil, 128), inner.B, true)
	mac := hmac.New(sha256.New, KDFa(seed, "INTEGRITY", nil, nil, 256))
	mac.Write(enc)
	mac.Write(akName)
	w := &tpm.Writer{}
	w.B2B(mac.Sum(nil))
	w.Raw(enc)
	return w.B, encryptedSecret, nil
}
