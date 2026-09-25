package pki

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Signed bcd releases (@better-compute/pki release.ts, PLAN.md §13 "Supply chain"): a TUF-lite
// manifest of one release's artifacts, signed under purpose release-manifest by offline keys that
// daemons know only by pin. Self-update verifies in release.ts's order: signatures from a threshold
// of distinct pinned keys, then the body's canonical form, then (the caller) product, sequence
// (no rollback), expiry and each artifact's size and SHA-256.

// PurposeReleaseManifest signs a release manifest; parts [canonical manifest body].
const PurposeReleaseManifest = "release-manifest"

// ReleaseManifestType is the manifest's type field.
const ReleaseManifestType = "bettercompute.release"

// MaxSignedReleaseBytes bounds a signed manifest (a release lists a few dozen artifacts).
const MaxSignedReleaseBytes = 1 << 20

// ReleaseManifest is a verified manifest body. IssuedAt and ExpiresAt are epoch milliseconds.
type ReleaseManifest struct {
	Type      string            `json:"type"`
	Spec      int               `json:"spec"`
	Product   string            `json:"product"`
	Version   string            `json:"version"`
	Sequence  int64             `json:"sequence"`
	IssuedAt  int64             `json:"issuedAt"`
	ExpiresAt int64             `json:"expiresAt"`
	Keys      []ReleaseKey      `json:"keys"`
	Artifacts []ReleaseArtifact `json:"artifacts"`
}

// ReleaseKey is a signing key a manifest lists; trusted only if its SPKI matches a configured pin.
type ReleaseKey struct {
	Kid  string `json:"kid"`
	Alg  string `json:"alg"`
	Spki string `json:"spki"`
}

// ReleaseArtifact is one released file. Sha256 is lowercase hex.
type ReleaseArtifact struct {
	Name     string `json:"name"`
	Platform string `json:"platform,omitempty"`
	Sha256   string `json:"sha256"`
	Size     int64  `json:"size"`
}

// Expires is when the manifest stops being accepted.
func (m *ReleaseManifest) Expires() time.Time { return time.UnixMilli(m.ExpiresAt) }

// Artifact returns the artifact of platform (os-arch) with the given SHA-256, if the manifest lists it.
func (m *ReleaseManifest) Artifact(platform string, sha256 []byte) (ReleaseArtifact, bool) {
	want := hex.EncodeToString(sha256)
	for _, a := range m.Artifacts {
		if a.Platform == platform && a.Sha256 == want {
			return a, true
		}
	}
	return ReleaseArtifact{}, false
}

// signedRelease is the published form (manifest.json): the canonical body, base64, and its signatures.
type signedRelease struct {
	Manifest   string `json:"manifest"`
	Signatures []struct {
		Kid string `json:"kid"`
		Sig string `json:"sig"`
	} `json:"signatures"`
}

var (
	releaseName     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$`)
	releasePlatform = regexp.MustCompile(`^[a-z0-9]+-[a-z0-9_]+$`)
	releaseProduct  = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
	releaseVersion  = regexp.MustCompile(`^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,64})?$`)
	releaseHex      = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// ErrRelease is wrapped by every VerifyReleaseManifest refusal.
var ErrRelease = errors.New("pki: release manifest rejected")

func releaseError(reason, format string, args ...any) error {
	return fmt.Errorf("%w (%s): %s", ErrRelease, reason, fmt.Sprintf(format, args...))
}

// VerifyReleaseManifest checks a signed manifest (manifest.json's bytes): at least threshold
// distinct pinned keys signed it, and the body is canonical and well-formed. It returns the body;
// product, version, sequence, expiry and the artifacts are the caller's to check.
func VerifyReleaseManifest(signed []byte, pins [][]byte, threshold int) (*ReleaseManifest, error) {
	if threshold < 1 || threshold > len(pins) {
		return nil, fmt.Errorf("pki: release threshold %d with %d pins", threshold, len(pins))
	}
	if len(signed) > MaxSignedReleaseBytes {
		return nil, releaseError("malformed", "larger than %d bytes", MaxSignedReleaseBytes)
	}
	var s signedRelease
	if err := json.Unmarshal(signed, &s); err != nil || s.Manifest == "" {
		return nil, releaseError("malformed", "not a signed manifest")
	}
	body, err := base64.StdEncoding.DecodeString(s.Manifest)
	if err != nil {
		return nil, releaseError("malformed", "the manifest is not base64")
	}
	var m ReleaseManifest
	if err := json.Unmarshal(body, &m); err != nil || !releaseKeysExact(body) {
		return nil, releaseError("malformed", "the manifest is not a release manifest")
	}
	if err := checkReleaseManifest(&m); err != nil {
		return nil, releaseError("malformed", "%v", err)
	}
	input := SigningInput(PurposeReleaseManifest, body)
	trusted := map[int]bool{}
	for i, entry := range s.Signatures {
		if i >= 16 {
			break
		}
		var key *ReleaseKey
		for k := range m.Keys {
			if m.Keys[k].Kid == entry.Kid {
				key = &m.Keys[k]
				break
			}
		}
		if key == nil {
			continue
		}
		pub, err := releasePublicKey(key.Spki)
		if err != nil {
			continue
		}
		sig, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(entry.Sig, "="))
		if err != nil {
			continue
		}
		for p, pin := range pins {
			if !trusted[p] && MatchesPin(pub, pin) && VerifyP1363(pub, input, sig) {
				trusted[p] = true
				break
			}
		}
	}
	if len(trusted) < threshold {
		return nil, releaseError("threshold", "%d of %d required release keys signed it", len(trusted), threshold)
	}
	canonical, err := canonicalJSON(body)
	if err != nil || !bytes.Equal(canonical, body) {
		return nil, releaseError("not-canonical", "the body is not canonical")
	}
	return &m, nil
}

// releaseKeysExact reports whether every object in the body has only the fields a manifest has,
// spelled exactly: encoding/json matches field names case-insensitively, and "Version" beside
// "version" must not read differently here than in JavaScript.
func releaseKeysExact(body []byte) bool {
	exact := func(raw json.RawMessage, allowed ...string) bool {
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil {
			return false
		}
		for k := range fields {
			found := false
			for _, a := range allowed {
				found = found || k == a
			}
			if !found {
				return false
			}
		}
		return true
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(body, &top) != nil ||
		!exact(body, "type", "spec", "product", "version", "sequence", "issuedAt", "expiresAt", "keys", "artifacts") {
		return false
	}
	var keys, artifacts []json.RawMessage
	if json.Unmarshal(top["keys"], &keys) != nil || json.Unmarshal(top["artifacts"], &artifacts) != nil {
		return false
	}
	for _, k := range keys {
		if !exact(k, "kid", "alg", "spki") {
			return false
		}
	}
	for _, a := range artifacts {
		if !exact(a, "name", "platform", "sha256", "size") {
			return false
		}
	}
	return true
}

func releasePublicKey(spki string) (*ecdsa.PublicKey, error) {
	der, err := base64.StdEncoding.DecodeString(spki)
	if err != nil {
		return nil, err
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	pub, ok := parsed.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		return nil, errors.New("not a P-256 key")
	}
	return pub, nil
}

// checkReleaseManifest is release.ts checkManifest.
func checkReleaseManifest(m *ReleaseManifest) error {
	const maxSafe = 1<<53 - 1
	switch {
	case m.Type != ReleaseManifestType || m.Spec != 1:
		return errors.New("not a spec 1 release manifest")
	case !releaseProduct.MatchString(m.Product):
		return errors.New("product is invalid")
	case !releaseVersion.MatchString(m.Version):
		return errors.New("version must be semver")
	case m.Sequence < 1 || m.Sequence > maxSafe:
		return errors.New("sequence must be a positive integer")
	case m.IssuedAt < 0 || m.IssuedAt > maxSafe || m.ExpiresAt > maxSafe || m.ExpiresAt <= m.IssuedAt:
		return errors.New("expiresAt must follow issuedAt")
	case len(m.Keys) == 0 || len(m.Keys) > 16:
		return errors.New("a release lists 1 to 16 signing keys")
	case len(m.Artifacts) == 0:
		return errors.New("a release lists at least one artifact")
	}
	kids := map[string]bool{}
	for _, k := range m.Keys {
		if k.Alg != "ES256" || k.Kid == "" || k.Spki == "" || kids[k.Kid] {
			return errors.New("keys must be distinct { kid, alg: ES256, spki }")
		}
		kids[k.Kid] = true
	}
	names := map[string]bool{}
	for _, a := range m.Artifacts {
		switch {
		case !releaseName.MatchString(a.Name) || names[a.Name]:
			return fmt.Errorf("%q is not a plain, distinct file name", a.Name)
		case a.Platform != "" && !releasePlatform.MatchString(a.Platform):
			return fmt.Errorf("%s: platform must be os-arch", a.Name)
		case !releaseHex.MatchString(a.Sha256):
			return fmt.Errorf("%s: sha256 must be hex", a.Name)
		case a.Size < 0 || a.Size > maxSafe:
			return fmt.Errorf("%s: size is invalid", a.Name)
		}
		names[a.Name] = true
	}
	return nil
}

// canonicalJSON re-encodes a JSON document the way @better-compute/pki canonicalJson does: object
// keys sorted by UTF-16 code units, no whitespace, strings escaped as JSON.stringify escapes them.
// Numbers must be plain integers (a manifest has no others).
func canonicalJSON(doc []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(doc))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, errors.New("trailing data")
	}
	var out bytes.Buffer
	if err := writeCanonical(&out, v); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

var plainInteger = regexp.MustCompile(`^-?(0|[1-9][0-9]{0,15})$`)

func writeCanonical(out *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		out.WriteString(strconv.FormatBool(x))
	case json.Number:
		if !plainInteger.MatchString(string(x)) {
			return fmt.Errorf("number %s is not a plain integer", x)
		}
		out.WriteString(string(x))
	case string:
		writeJSString(out, x)
	case []any:
		out.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				out.WriteByte(',')
			}
			if err := writeCanonical(out, e); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return utf16Less(keys[i], keys[j]) })
		out.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				out.WriteByte(',')
			}
			writeJSString(out, k)
			out.WriteByte(':')
			if err := writeCanonical(out, x[k]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	default:
		return fmt.Errorf("unexpected JSON value %T", v)
	}
	return nil
}

// writeJSString writes s as JSON.stringify does: ", \ and control characters escaped (\b \t \n \f
// \r by name, the rest \u00xx), everything else as UTF-8.
func writeJSString(out *bytes.Buffer, s string) {
	out.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			out.WriteString(`\"`)
		case r == '\\':
			out.WriteString(`\\`)
		case r == '\b':
			out.WriteString(`\b`)
		case r == '\t':
			out.WriteString(`\t`)
		case r == '\n':
			out.WriteString(`\n`)
		case r == '\f':
			out.WriteString(`\f`)
		case r == '\r':
			out.WriteString(`\r`)
		case r < 0x20:
			fmt.Fprintf(out, `\u%04x`, r)
		case r == utf8.RuneError:
			out.WriteString(`�`) // never canonical: the body held invalid UTF-8
		default:
			out.WriteRune(r)
		}
	}
	out.WriteByte('"')
}

// utf16Less orders strings as JavaScript's default sort does (by UTF-16 code units).
func utf16Less(a, b string) bool {
	ra, rb := []rune(a), []rune(b)
	for i := 0; i < len(ra) && i < len(rb); i++ {
		if ra[i] == rb[i] {
			continue
		}
		if ua, ub := utf16Unit(ra[i]), utf16Unit(rb[i]); ua != ub {
			return ua < ub
		}
		return ra[i] < rb[i]
	}
	return len(ra) < len(rb)
}

// utf16Unit is the first UTF-16 code unit of r (a high surrogate above the BMP).
func utf16Unit(r rune) rune {
	if r >= 0x10000 {
		return 0xD800 + ((r - 0x10000) >> 10)
	}
	return r
}
