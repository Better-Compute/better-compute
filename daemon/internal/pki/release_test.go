package pki

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

type releaseFixture struct {
	Signed    string            `json:"signed"`
	Pins      []string          `json:"pins"`
	OtherPin  string            `json:"otherPin"`
	ExpiresAt int64             `json:"expiresAt"`
	Binaries  map[string]string `json:"binaries"`
}

func loadReleaseFixture(t *testing.T) (releaseFixture, [][]byte, []byte) {
	t.Helper()
	raw, err := os.ReadFile("testdata/release.json")
	if err != nil {
		t.Fatal(err)
	}
	var f releaseFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	pin := func(s string) []byte {
		b, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(s, "sha256/"))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	return f, [][]byte{pin(f.Pins[0]), pin(f.Pins[1])}, pin(f.OtherPin)
}

// A manifest signed by @better-compute/pki (scripts/daemon-release-fixture.mjs) verifies here.
func TestVerifyReleaseManifestInterop(t *testing.T) {
	f, pins, other := loadReleaseFixture(t)
	m, err := VerifyReleaseManifest([]byte(f.Signed), pins, 2)
	if err != nil {
		t.Fatal(err)
	}
	if m.Product != "bcd" || m.Version != "0.4.0" || m.Sequence != 7 || m.ExpiresAt != f.ExpiresAt {
		t.Fatalf("manifest = %+v", m)
	}
	bin, _ := base64.StdEncoding.DecodeString(f.Binaries["linux-amd64"])
	sum := sha256.Sum256(bin)
	a, ok := m.Artifact("linux-amd64", sum[:])
	if !ok || a.Name != "bcd_0.4.0_linux_amd64" || a.Size != int64(len(bin)) {
		t.Fatalf("artifact = %+v %v", a, ok)
	}
	if _, ok := m.Artifact("linux-arm64", sum[:]); ok {
		t.Fatal("an amd64 digest matched the arm64 artifact")
	}
	// One pinned signer is enough for threshold 1, with an unrelated pin beside it.
	if _, err := VerifyReleaseManifest([]byte(f.Signed), [][]byte{other, pins[1]}, 1); err != nil {
		t.Fatal(err)
	}
	// The same pin twice is still one key.
	if _, err := VerifyReleaseManifest([]byte(f.Signed), [][]byte{pins[0], pins[0]}, 2); err == nil || !strings.Contains(err.Error(), "1 distinct pins") {
		t.Fatalf("a pin counted twice: %v", err)
	}
	if _, err := VerifyReleaseManifest([]byte(f.Signed), [][]byte{other}, 1); err == nil || !strings.Contains(err.Error(), "threshold") {
		t.Fatalf("unpinned signers: %v", err)
	}
}

func TestVerifyReleaseManifestRefusesTampering(t *testing.T) {
	f, pins, _ := loadReleaseFixture(t)
	var s map[string]any
	_ = json.Unmarshal([]byte(f.Signed), &s)
	body, _ := base64.StdEncoding.DecodeString(s["manifest"].(string))
	resign := func(mutate func(string) string) []byte {
		out := map[string]any{"manifest": base64.StdEncoding.EncodeToString([]byte(mutate(string(body)))), "signatures": s["signatures"]}
		b, _ := json.Marshal(out)
		return b
	}
	cases := map[string]func(string) string{
		// Any change breaks the signatures.
		"version": func(b string) string { return strings.Replace(b, `"version":"0.4.0"`, `"version":"0.4.1"`, 1) },
		"digest":  func(b string) string { return strings.Replace(b, `"sha256":"a`, `"sha256":"b`, 1) },
		"spacing": func(b string) string { return strings.Replace(b, `,"spec"`, `, "spec"`, 1) },
	}
	for name, mutate := range cases {
		if _, err := VerifyReleaseManifest(resign(mutate), pins, 1); !errors.Is(err, ErrRelease) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := VerifyReleaseManifest([]byte(`{"manifest":"!!","signatures":[]}`), pins, 1); !errors.Is(err, ErrRelease) {
		t.Errorf("bad base64: %v", err)
	}
	if _, err := VerifyReleaseManifest([]byte(f.Signed), pins, 3); err == nil {
		t.Error("a threshold above the pins")
	}
}

// Field names are exact: encoding/json would read "Version" into Version.
func TestReleaseKeysExact(t *testing.T) {
	f, _, _ := loadReleaseFixture(t)
	var signed struct{ Manifest string }
	_ = json.Unmarshal([]byte(f.Signed), &signed)
	body, _ := base64.StdEncoding.DecodeString(signed.Manifest)
	if !releaseKeysExact(body) {
		t.Fatal("the fixture's body")
	}
	shadow := strings.Replace(string(body), `"type"`, `"Version":"9.9.9","type"`, 1)
	if releaseKeysExact([]byte(shadow)) {
		t.Fatal(`"Version" beside "version" was accepted`)
	}
}

func TestCanonicalJSON(t *testing.T) {
	for in, want := range map[string]string{
		`{"b":1,"a":[true,null,"x"]}`: `{"a":[true,null,"x"],"b":1}`,
		`{"s":"tab\tq\"\u0001é"}`:     `{"s":"tab\tq\"\u0001é"}`,
		`{"￿":1,"😀":2}`:               `{"😀":2,"` + "￿" + `":1}`,
		` { "k" : "v" } `:             `{"k":"v"}`,
		`{"e":"<>& "}`:                "{\"e\":\"<>& \"}",
	} {
		got, err := canonicalJSON([]byte(in))
		if err != nil || string(got) != want {
			t.Errorf("canonicalJSON(%s) = %s, %v; want %s", in, got, err, want)
		}
	}
	for _, in := range []string{`{"n":1.5}`, `{"n":1e3}`, `{"a":1} {}`} {
		if _, err := canonicalJSON([]byte(in)); err == nil {
			t.Errorf("canonicalJSON(%s) accepted", in)
		}
	}
}
