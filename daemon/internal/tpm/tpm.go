// Package tpm is the TPM 2.0 client of the `tpm` join attestor (PLAN.md §13, v0.5): the agent half
// of packages/pki's tpmAttestor. It speaks the TPM's own command format (TCG TPM 2.0 Library,
// Part 2 "Structures" and Part 3 "Commands"; all integers big-endian) over the kernel's resource
// manager, /dev/tpmrm0, with no library in between. It sends only the commands enrollment needs:
//   - CreatePrimary and ReadPublic, for the endorsement key (EK) and an attestation key (AK);
//   - NV_ReadPublic and NV_Read, for the EK certificate;
//   - StartAuthSession, PolicySecret and ActivateCredential, to prove the AK sits beside the EK;
//   - Quote and PCR_Read, for the PCR values;
//   - FlushContext.
package tpm

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Transport sends one command and returns the TPM's response: a TPM device, or a simulator.
type Transport interface {
	Send(command []byte) ([]byte, error)
}

// Algorithm ids (Part 2 §6.3).
const (
	AlgRSA    = 0x0001
	AlgSHA1   = 0x0004
	AlgAES    = 0x0006
	AlgSHA256 = 0x000B
	AlgSHA384 = 0x000C
	AlgSHA512 = 0x000D
	AlgNull   = 0x0010
	AlgECDSA  = 0x0018
	AlgECC    = 0x0023
	AlgCFB    = 0x0043

	CurveP256 = 0x0003
)

// Structure tags, command codes and handles.
const (
	TagNoSessions = 0x8001
	TagSessions   = 0x8002

	CCNVRead             = 0x0000014E
	CCCreatePrimary      = 0x00000131
	CCActivateCredential = 0x00000147
	CCPolicySecret       = 0x00000151
	CCQuote              = 0x00000158
	CCFlushContext       = 0x00000165
	CCNVReadPublic       = 0x00000169
	CCReadPublic         = 0x00000173
	CCStartAuthSession   = 0x00000176
	CCPCRRead            = 0x0000017E

	RHOwner       = 0x40000001
	RHNull        = 0x40000007
	RSPassword    = 0x40000009
	RHEndorsement = 0x4000000B

	// EKCertIndex is the NV index of the RSA 2048 EK certificate (TCG EK Credential Profile).
	EKCertIndex = 0x01C00002
	// EKHandle is where an EK is conventionally persisted.
	EKHandle = 0x81010001
)

// Response codes a caller retries.
const (
	rcRetry   = 0x922
	rcYielded = 0x908
	rcTesting = 0x90A
)

// Error is a TPM's response code for a command.
type Error struct {
	Command, Code uint32
}

func (e *Error) Error() string {
	return fmt.Sprintf("tpm: command 0x%x: response code 0x%x", e.Command, e.Code)
}

var errShort = errors.New("tpm: truncated structure")

// Writer marshals TPM structures.
type Writer struct{ B []byte }

func (w *Writer) U8(v uint8)   { w.B = append(w.B, v) }
func (w *Writer) U16(v uint16) { w.B = binary.BigEndian.AppendUint16(w.B, v) }
func (w *Writer) U32(v uint32) { w.B = binary.BigEndian.AppendUint32(w.B, v) }
func (w *Writer) U64(v uint64) { w.B = binary.BigEndian.AppendUint64(w.B, v) }
func (w *Writer) Raw(b []byte) { w.B = append(w.B, b...) }

// B2B writes a TPM2B: a u16 size, then the bytes.
func (w *Writer) B2B(b []byte) {
	w.U16(uint16(len(b)))
	w.Raw(b)
}

// Reader unmarshals TPM structures; the first overrun sets Err and every later read returns zero.
type Reader struct {
	B   []byte
	Err error
}

func (r *Reader) Take(n int) []byte {
	if r.Err != nil || n < 0 || n > len(r.B) {
		r.Err = errShort
		return nil
	}
	out := r.B[:n:n]
	r.B = r.B[n:]
	return out
}

func (r *Reader) U8() uint8 {
	if b := r.Take(1); b != nil {
		return b[0]
	}
	return 0
}

func (r *Reader) U16() uint16 {
	if b := r.Take(2); b != nil {
		return binary.BigEndian.Uint16(b)
	}
	return 0
}

func (r *Reader) U32() uint32 {
	if b := r.Take(4); b != nil {
		return binary.BigEndian.Uint32(b)
	}
	return 0
}

func (r *Reader) U64() uint64 {
	if b := r.Take(8); b != nil {
		return binary.BigEndian.Uint64(b)
	}
	return 0
}

// B2B reads a TPM2B's bytes (a copy).
func (r *Reader) B2B() []byte {
	return append([]byte(nil), r.Take(int(r.U16()))...)
}

// Selection is the PCRs of one bank (the JSON shape tpmAttestor's challenge uses).
type Selection struct {
	Hash uint16 `json:"hash"`
	PCRs []int  `json:"pcrs"`
}

// WriteSelections marshals a TPML_PCR_SELECTION (sizeofSelect 3: PCRs 0-23).
func WriteSelections(w *Writer, sels []Selection) error {
	w.U32(uint32(len(sels)))
	for _, s := range sels {
		var bits [3]byte
		for _, p := range s.PCRs {
			if p < 0 || p > 23 {
				return fmt.Errorf("tpm: PCR %d is out of range", p)
			}
			bits[p/8] |= 1 << (p % 8)
		}
		w.U16(s.Hash)
		w.U8(3)
		w.Raw(bits[:])
	}
	return nil
}

// ReadSelections unmarshals a TPML_PCR_SELECTION; PCRs come out ascending.
func ReadSelections(r *Reader) []Selection {
	n := r.U32()
	if n > 16 {
		r.Err = errors.New("tpm: too many PCR banks")
		return nil
	}
	var out []Selection
	for i := uint32(0); i < n && r.Err == nil; i++ {
		s := Selection{Hash: r.U16()}
		size := int(r.U8())
		if size > 8 {
			r.Err = errors.New("tpm: PCR select too large")
			return nil
		}
		bits := r.Take(size)
		for byteIdx, b := range bits {
			for bit := 0; bit < 8; bit++ {
				if b&(1<<bit) != 0 {
					s.PCRs = append(s.PCRs, byteIdx*8+bit)
				}
			}
		}
		out = append(out, s)
	}
	return out
}

// PasswordAuth is an empty password authorization (TPM_RS_PW).
func PasswordAuth() []byte { return sessionAuth(RSPassword) }

// sessionAuth is an authorization by a session that needs no HMAC (a policy session, or the
// password session with an empty password); continueSession clear, so a policy session is flushed
// by the command it authorizes.
func sessionAuth(handle uint32) []byte {
	w := &Writer{}
	w.U32(handle)
	w.B2B(nil) // nonceCaller
	w.U8(0)    // sessionAttributes
	w.B2B(nil) // hmac
	return w.B
}

// TPM issues commands over a Transport, one at a time.
type TPM struct {
	t  Transport
	mu sync.Mutex
}

// New is a TPM over t.
func New(t Transport) *TPM { return &TPM{t: t} }

// Run sends a command: its handles, authorizations (with them the command carries sessions) and
// parameters. It returns the response's outHandles handles and its parameters.
func (t *TPM) Run(cc uint32, handles []uint32, auths [][]byte, params []byte, outHandles int) ([]uint32, []byte, error) {
	tag := uint16(TagNoSessions)
	if len(auths) > 0 {
		tag = TagSessions
	}
	w := &Writer{}
	w.U16(tag)
	w.U32(0) // size, below
	w.U32(cc)
	for _, h := range handles {
		w.U32(h)
	}
	if len(auths) > 0 {
		var area []byte
		for _, a := range auths {
			area = append(area, a...)
		}
		w.U32(uint32(len(area)))
		w.Raw(area)
	}
	w.Raw(params)
	binary.BigEndian.PutUint32(w.B[2:], uint32(len(w.B)))
	var resp []byte
	for attempt := 0; ; attempt++ {
		var err error
		t.mu.Lock()
		resp, err = t.t.Send(w.B)
		t.mu.Unlock()
		if err != nil {
			return nil, nil, fmt.Errorf("tpm: %w", err)
		}
		if len(resp) < 10 || int(binary.BigEndian.Uint32(resp[2:6])) != len(resp) {
			return nil, nil, errors.New("tpm: malformed response")
		}
		rc := binary.BigEndian.Uint32(resp[6:10])
		if (rc == rcRetry || rc == rcYielded || rc == rcTesting) && attempt < 20 {
			time.Sleep(50 * time.Millisecond)
			continue
		}
		if rc != 0 {
			return nil, nil, &Error{Command: cc, Code: rc}
		}
		break
	}
	r := &Reader{B: resp[10:]}
	hs := make([]uint32, outHandles)
	for i := range hs {
		hs[i] = r.U32()
	}
	var out []byte
	if binary.BigEndian.Uint16(resp[0:2]) == TagSessions {
		out = r.Take(int(r.U32()))
	} else {
		out, r.B = r.B, nil
	}
	if r.Err != nil {
		return nil, nil, r.Err
	}
	return hs, out, nil
}

// CreatePrimary creates a primary key from template in a hierarchy; it returns its transient
// handle and its public area (TPMT_PUBLIC).
func (t *TPM) CreatePrimary(hierarchy uint32, template []byte) (uint32, []byte, error) {
	w := &Writer{}
	w.U16(4) // TPM2B_SENSITIVE_CREATE: an empty userAuth and data
	w.U16(0)
	w.U16(0)
	w.B2B(template)
	w.B2B(nil) // outsideInfo
	w.U32(0)   // creationPCR: none
	hs, params, err := t.Run(CCCreatePrimary, []uint32{hierarchy}, [][]byte{PasswordAuth()}, w.B, 1)
	if err != nil {
		return 0, nil, err
	}
	r := &Reader{B: params}
	pub := r.B2B()
	return hs[0], pub, r.Err
}

// ReadPublic returns a loaded object's public area.
func (t *TPM) ReadPublic(handle uint32) ([]byte, error) {
	_, params, err := t.Run(CCReadPublic, []uint32{handle}, nil, nil, 0)
	if err != nil {
		return nil, err
	}
	r := &Reader{B: params}
	pub := r.B2B()
	return pub, r.Err
}

// Flush unloads a transient object or a session.
func (t *TPM) Flush(handle uint32) error {
	w := &Writer{}
	w.U32(handle)
	_, _, err := t.Run(CCFlushContext, nil, nil, w.B, 0)
	return err
}

// StartPolicySession starts an unbound, unsalted policy session (SHA-256).
func (t *TPM) StartPolicySession() (uint32, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return 0, err
	}
	w := &Writer{}
	w.B2B(nonce)
	w.B2B(nil) // encryptedSalt
	w.U8(1)    // TPM_SE_POLICY
	w.U16(AlgNull)
	w.U16(AlgSHA256)
	hs, _, err := t.Run(CCStartAuthSession, []uint32{RHNull, RHNull}, nil, w.B, 1)
	if err != nil {
		return 0, err
	}
	return hs[0], nil
}

// PolicySecret satisfies the EK's policy in session: the endorsement hierarchy's (empty) auth.
func (t *TPM) PolicySecret(session uint32) error {
	w := &Writer{}
	w.B2B(nil) // nonceTPM
	w.B2B(nil) // cpHashA
	w.B2B(nil) // policyRef
	w.U32(0)   // expiration
	_, _, err := t.Run(CCPolicySecret, []uint32{RHEndorsement, session}, [][]byte{PasswordAuth()}, w.B, 0)
	return err
}

// ActivateCredential recovers the credential MakeCredential sealed to ek for the object ak: the
// TPM holding both keys alone can. session is a policy session that satisfied the EK's policy.
func (t *TPM) ActivateCredential(ak, ek, session uint32, credentialBlob, encryptedSecret []byte) ([]byte, error) {
	w := &Writer{}
	w.B2B(credentialBlob)
	w.B2B(encryptedSecret)
	_, params, err := t.Run(CCActivateCredential, []uint32{ak, ek}, [][]byte{PasswordAuth(), sessionAuth(session)}, w.B, 0)
	if err != nil {
		return nil, err
	}
	r := &Reader{B: params}
	cred := r.B2B()
	return cred, r.Err
}

// Quote signs the PCRs of sels with ak (its own scheme) over nonce; it returns the TPMS_ATTEST and
// the TPMT_SIGNATURE.
func (t *TPM) Quote(ak uint32, nonce []byte, sels []Selection) (attest, signature []byte, err error) {
	w := &Writer{}
	w.B2B(nonce)
	w.U16(AlgNull) // inScheme: the key's
	if err := WriteSelections(w, sels); err != nil {
		return nil, nil, err
	}
	_, params, err := t.Run(CCQuote, []uint32{ak}, [][]byte{PasswordAuth()}, w.B, 0)
	if err != nil {
		return nil, nil, err
	}
	r := &Reader{B: params}
	attest = r.B2B()
	signature = append([]byte(nil), r.B...)
	return attest, signature, r.Err
}

// PCRRead reads the PCRs of sels: values by bank, then index. A TPM returns at most eight a call;
// the rest are asked for again.
func (t *TPM) PCRRead(sels []Selection) (map[uint16]map[int][]byte, error) {
	out := map[uint16]map[int][]byte{}
	for round := 0; round < 32; round++ {
		var remaining []Selection
		for _, s := range sels {
			var left []int
			for _, p := range s.PCRs {
				if _, ok := out[s.Hash][p]; !ok {
					left = append(left, p)
				}
			}
			if len(left) > 0 {
				remaining = append(remaining, Selection{Hash: s.Hash, PCRs: left})
			}
		}
		if len(remaining) == 0 {
			return out, nil
		}
		w := &Writer{}
		if err := WriteSelections(w, remaining); err != nil {
			return nil, err
		}
		_, params, err := t.Run(CCPCRRead, nil, nil, w.B, 0)
		if err != nil {
			return nil, err
		}
		r := &Reader{B: params}
		r.U32() // pcrUpdateCounter
		got := ReadSelections(r)
		n := int(r.U32())
		var digests [][]byte
		for i := 0; i < n && r.Err == nil; i++ {
			digests = append(digests, r.B2B())
		}
		if r.Err != nil {
			return nil, r.Err
		}
		i := 0
		for _, s := range got {
			for _, p := range s.PCRs {
				if i >= len(digests) {
					return nil, errors.New("tpm: PCR_Read returned fewer values than it selected")
				}
				if out[s.Hash] == nil {
					out[s.Hash] = map[int][]byte{}
				}
				out[s.Hash][p] = digests[i]
				i++
			}
		}
		if i == 0 {
			return nil, errors.New("tpm: PCR_Read returned no values (is the bank allocated?)")
		}
	}
	return nil, errors.New("tpm: PCR_Read did not finish")
}

// NVSize is the data size of an NV index.
func (t *TPM) NVSize(index uint32) (int, error) {
	_, params, err := t.Run(CCNVReadPublic, []uint32{index}, nil, nil, 0)
	if err != nil {
		return 0, err
	}
	r := &Reader{B: params}
	pub := &Reader{B: r.Take(int(r.U16()))}
	pub.U32() // nvIndex
	pub.U16() // nameAlg
	pub.U32() // attributes
	pub.B2B() // authPolicy
	size := int(pub.U16())
	if r.Err != nil || pub.Err != nil {
		return 0, errShort
	}
	return size, nil
}

// NVRead reads size bytes of an NV index, authorized by the owner hierarchy (empty auth).
func (t *TPM) NVRead(index uint32, size int) ([]byte, error) {
	var out []byte
	for off := 0; off < size; {
		chunk := min(size-off, 512)
		w := &Writer{}
		w.U16(uint16(chunk))
		w.U16(uint16(off))
		_, params, err := t.Run(CCNVRead, []uint32{RHOwner, index}, [][]byte{PasswordAuth()}, w.B, 0)
		if err != nil {
			return nil, err
		}
		r := &Reader{B: params}
		data := r.B2B()
		if r.Err != nil || len(data) == 0 {
			return nil, errShort
		}
		out = append(out, data...)
		off += len(data)
	}
	return out, nil
}
