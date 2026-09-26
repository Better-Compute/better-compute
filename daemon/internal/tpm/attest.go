package tpm

import (
	"bytes"
	"crypto"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"sort"
	"strconv"

	_ "crypto/sha1"
	_ "crypto/sha512"
)

// TPMA_OBJECT bits (Part 2 §8.3).
const (
	attrFixedTPM            = 1 << 1
	attrFixedParent         = 1 << 4
	attrSensitiveDataOrigin = 1 << 5
	attrUserWithAuth        = 1 << 6
	attrAdminWithPolicy     = 1 << 7
	attrNoDA                = 1 << 10
	attrRestricted          = 1 << 16
	attrDecrypt             = 1 << 17
	attrSign                = 1 << 18
)

// ekPolicy is PolicySecret(TPM_RH_ENDORSEMENT): the default EK's authPolicy.
var ekPolicy, _ = hex.DecodeString("837197674484b3f81a90cc8d46a5d724fd52d76e06520b64f2a1da1b331469aa")

// ekTemplatePrefix is the default RSA 2048 EK template (TCG EK Credential Profile, template L-1)
// up to its unique field.
func ekTemplatePrefix() []byte {
	w := &Writer{}
	w.U16(AlgRSA)
	w.U16(AlgSHA256)
	w.U32(attrFixedTPM | attrFixedParent | attrSensitiveDataOrigin | attrAdminWithPolicy | attrRestricted | attrDecrypt)
	w.B2B(ekPolicy)
	w.U16(AlgAES)
	w.U16(128)
	w.U16(AlgCFB)
	w.U16(AlgNull) // scheme
	w.U16(2048)
	w.U32(0) // exponent: 65537
	return w.B
}

// EKTemplate is the default RSA 2048 EK template: every TPM derives the same EK from it.
func EKTemplate() []byte {
	w := &Writer{B: ekTemplatePrefix()}
	w.B2B(make([]byte, 256))
	return w.B
}

// AKTemplate is a restricted ECDSA P-256 signing key (go-attestation's AK attributes), created as a
// primary key: the same template gives the same AK on every enrollment.
func AKTemplate() []byte {
	w := &Writer{}
	w.U16(AlgECC)
	w.U16(AlgSHA256)
	w.U32(attrFixedTPM | attrFixedParent | attrSensitiveDataOrigin | attrUserWithAuth | attrNoDA | attrRestricted | attrSign)
	w.B2B(nil)     // authPolicy
	w.U16(AlgNull) // symmetric
	w.U16(AlgECDSA)
	w.U16(AlgSHA256)
	w.U16(CurveP256)
	w.U16(AlgNull) // kdf
	w.B2B(nil)     // unique x
	w.B2B(nil)     // unique y
	return w.B
}

// Name is an object's TPM2B_NAME body: nameAlg ‖ H(TPMT_PUBLIC).
func Name(public []byte) ([]byte, error) {
	if len(public) < 4 {
		return nil, errShort
	}
	alg := binary.BigEndian.Uint16(public[2:4])
	h, err := hasher(alg)
	if err != nil {
		return nil, err
	}
	h.Write(public)
	return append(binary.BigEndian.AppendUint16(nil, alg), h.Sum(nil)...), nil
}

func hasher(alg uint16) (hash.Hash, error) {
	switch alg {
	case AlgSHA1:
		return crypto.SHA1.New(), nil
	case AlgSHA256:
		return crypto.SHA256.New(), nil
	case AlgSHA384:
		return crypto.SHA384.New(), nil
	case AlgSHA512:
		return crypto.SHA512.New(), nil
	}
	return nil, fmt.Errorf("tpm: hash algorithm 0x%x", alg)
}

// Attestor is the agent half of the `tpm` attestor (packages/pki tpmAttestor, go-attestation's
// enrollment). Round 1 sends the EK's public area and certificate and the AK's public area. Round 2
// activates the credential the control plane made for that pair, which only the TPM holding both
// keys can do, then quotes the PCRs asked for, over sha256(secret ‖ sha256(CSR)).
type Attestor struct {
	tpm         *TPM
	ek, ak      uint32
	ekTransient bool
	ekPub       []byte
	akPub       []byte
	ekCert      []byte
}

// NewAttestor loads the EK (the persisted one when it is the default template's, else a fresh
// primary) and the AK, and reads the EK certificate when the TPM has one.
func NewAttestor(t Transport) (*Attestor, error) {
	a := &Attestor{tpm: New(t)}
	if pub, err := a.tpm.ReadPublic(EKHandle); err == nil && bytes.HasPrefix(pub, ekTemplatePrefix()) {
		a.ek, a.ekPub = EKHandle, pub
	} else {
		h, pub, err := a.tpm.CreatePrimary(RHEndorsement, EKTemplate())
		if err != nil {
			return nil, fmt.Errorf("tpm: the endorsement key: %w", err)
		}
		a.ek, a.ekPub, a.ekTransient = h, pub, true
	}
	h, pub, err := a.tpm.CreatePrimary(RHEndorsement, AKTemplate())
	if err != nil {
		a.Close()
		return nil, fmt.Errorf("tpm: the attestation key: %w", err)
	}
	a.ak, a.akPub = h, pub
	if size, err := a.tpm.NVSize(EKCertIndex); err == nil && size > 0 && size <= 4096 {
		if cert, err := a.tpm.NVRead(EKCertIndex, size); err == nil {
			a.ekCert = trimDER(cert)
		}
	}
	return a, nil
}

// Close unloads the keys this attestor created.
func (a *Attestor) Close() {
	if a.ak != 0 {
		_ = a.tpm.Flush(a.ak)
		a.ak = 0
	}
	if a.ekTransient && a.ek != 0 {
		_ = a.tpm.Flush(a.ek)
		a.ek = 0
	}
}

// EKPublic is the EK's TPMT_PUBLIC (sha256 of it is the machine's identity to the control plane).
func (a *Attestor) EKPublic() []byte { return a.ekPub }

// AKPublic is the AK's TPMT_PUBLIC (its key verifies quotes and certifications).
func (a *Attestor) AKPublic() []byte { return a.akPub }

// trimDER cuts an NV area to the DER certificate at its start (NV areas are often padded).
func trimDER(b []byte) []byte {
	if len(b) < 2 || b[0] != 0x30 {
		return b
	}
	n, hdr := int(b[1]), 2
	if b[1]&0x80 != 0 {
		octets := int(b[1] & 0x7f)
		if octets == 0 || octets > 3 || len(b) < 2+octets {
			return b
		}
		n = 0
		for _, o := range b[2 : 2+octets] {
			n = n<<8 | int(o)
		}
		hdr = 2 + octets
	}
	if hdr+n > len(b) {
		return b
	}
	return b[:hdr+n]
}

var b64 = base64.RawURLEncoding

// evidence is tpmAttestor's evidence JSON (both rounds).
type evidence struct {
	V      int     `json:"v"`
	EK     string  `json:"ek"`
	EKCert string  `json:"ekCert,omitempty"`
	AK     string  `json:"ak"`
	Answer *answer `json:"answer,omitempty"`
}

type answer struct {
	State     string                       `json:"state"`
	Secret    string                       `json:"secret"`
	Quote     string                       `json:"quote"`
	Signature string                       `json:"signature"`
	PCRs      map[string]map[string]string `json:"pcrs"`
}

func (a *Attestor) base() evidence {
	e := evidence{V: 1, EK: b64.EncodeToString(a.ekPub), AK: b64.EncodeToString(a.akPub)}
	if len(a.ekCert) > 0 {
		e.EKCert = b64.EncodeToString(a.ekCert)
	}
	return e
}

// Evidence is round 1's attestation.
func (a *Attestor) Evidence() ([]byte, error) { return json.Marshal(a.base()) }

// challenge is tpmAttestor's JoinChallenge payload.
type challenge struct {
	CredentialBlob  string      `json:"credentialBlob"`
	EncryptedSecret string      `json:"encryptedSecret"`
	State           string      `json:"state"`
	PCRSelection    []Selection `json:"pcrSelection"`
}

// Answer is round 2's attestation: the challenge answered for the CSR whose sha256 is csrSha256.
func (a *Attestor) Answer(payload, csrSha256 []byte) ([]byte, error) {
	var c challenge
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, fmt.Errorf("tpm: the challenge: %w", err)
	}
	blob, err1 := b64.DecodeString(c.CredentialBlob)
	secretIn, err2 := b64.DecodeString(c.EncryptedSecret)
	if err1 != nil || err2 != nil || c.State == "" {
		return nil, errors.New("tpm: the challenge is malformed")
	}
	if len(c.PCRSelection) == 0 || len(c.PCRSelection) > 4 {
		return nil, errors.New("tpm: the challenge selects no PCRs, or too many banks")
	}
	for _, s := range c.PCRSelection {
		if _, err := hasher(s.Hash); err != nil {
			return nil, err
		}
		sort.Ints(s.PCRs)
	}
	session, err := a.tpm.StartPolicySession()
	if err != nil {
		return nil, fmt.Errorf("tpm: a policy session: %w", err)
	}
	if err := a.tpm.PolicySecret(session); err != nil {
		_ = a.tpm.Flush(session)
		return nil, fmt.Errorf("tpm: the EK's policy: %w", err)
	}
	// The session is flushed by ActivateCredential when it succeeds (continueSession clear).
	secret, err := a.tpm.ActivateCredential(a.ak, a.ek, session, blob, secretIn)
	if err != nil {
		_ = a.tpm.Flush(session)
		return nil, fmt.Errorf("tpm: activate the credential: %w", err)
	}
	nonce := sha256.Sum256(append(append([]byte{}, secret...), csrSha256...))
	// The PCRs are read after the quote; one that changed in between is quoted again.
	for attempt := 0; attempt < 3; attempt++ {
		attest, sig, err := a.tpm.Quote(a.ak, nonce[:], c.PCRSelection)
		if err != nil {
			return nil, fmt.Errorf("tpm: quote: %w", err)
		}
		values, err := a.tpm.PCRRead(c.PCRSelection)
		if err != nil {
			return nil, fmt.Errorf("tpm: read the PCRs: %w", err)
		}
		quoted, err := QuoteDigest(attest)
		if err != nil {
			return nil, err
		}
		if len(sig) < 4 {
			return nil, errShort
		}
		digest, err := PCRDigest(c.PCRSelection, values, binary.BigEndian.Uint16(sig[2:4]))
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(digest, quoted) {
			continue
		}
		pcrs := map[string]map[string]string{}
		for _, s := range c.PCRSelection {
			bank := map[string]string{}
			for _, p := range s.PCRs {
				bank[strconv.Itoa(p)] = hex.EncodeToString(values[s.Hash][p])
			}
			pcrs[strconv.Itoa(int(s.Hash))] = bank
		}
		e := a.base()
		e.Answer = &answer{
			State: c.State, Secret: b64.EncodeToString(secret), Quote: b64.EncodeToString(attest),
			Signature: b64.EncodeToString(sig), PCRs: pcrs,
		}
		return json.Marshal(e)
	}
	return nil, errors.New("tpm: the PCRs kept changing while they were quoted")
}

// PCRDigest is a quote's pcrDigest for values: H(each selected PCR, banks in order, PCRs ascending).
func PCRDigest(sels []Selection, values map[uint16]map[int][]byte, alg uint16) ([]byte, error) {
	h, err := hasher(alg)
	if err != nil {
		return nil, err
	}
	for _, s := range sels {
		pcrs := append([]int(nil), s.PCRs...)
		sort.Ints(pcrs)
		for _, p := range pcrs {
			v, ok := values[s.Hash][p]
			if !ok {
				return nil, fmt.Errorf("tpm: no value for PCR %d", p)
			}
			h.Write(v)
		}
	}
	return h.Sum(nil), nil
}

// QuoteDigest is the pcrDigest a quote's TPMS_ATTEST carries.
func QuoteDigest(attest []byte) ([]byte, error) {
	r := &Reader{B: attest}
	if r.U32() != 0xff544347 || r.U16() != 0x8018 {
		return nil, errors.New("tpm: not a quote")
	}
	r.B2B()    // qualifiedSigner
	r.B2B()    // extraData
	r.Take(17) // clockInfo: clock, resetCount, restartCount, safe
	r.U64()    // firmwareVersion
	ReadSelections(r)
	digest := r.B2B()
	if r.Err != nil {
		return nil, r.Err
	}
	return digest, nil
}
