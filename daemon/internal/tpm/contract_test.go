package tpm_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/tpm"
	"github.com/better-compute/better-compute/daemon/internal/tpm/tpmsim"
)

// The tpm attestor's wire contract between bcd and packages/pki (testdata/, see
// scripts/daemon-tpm-fixture.mjs): one software TPM (sim.json), its round-1 evidence
// (evidence.json), the challenge packages/pki's tpmAttestor made for it (challenge.json), and bcd's
// answer (answer.json), which tests/pki-attestors-tpm-bcd.test.ts verifies with tpmAttestor.
//
// Here: the evidence is still exactly what bcd sends, the TS attestor's challenge still activates
// and quotes through this client (TS -> Go), and the answer keeps the shape and values the TS side
// verifies (Go -> TS). A missing file is written (a new fixture), then committed.
func TestTSContract(t *testing.T) {
	dir := "testdata"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	sim, err := tpmsim.Load(filepath.Join(dir, "sim.json"))
	if err != nil {
		t.Fatal(err)
	}
	a, err := tpm.NewAttestor(sim)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	evidence, err := a.Evidence()
	if err != nil {
		t.Fatal(err)
	}
	if !fixture(t, filepath.Join(dir, "evidence.json"), evidence, func(want []byte) bool { return bytes.Equal(want, evidence) }) {
		t.Fatal("bcd's round-1 evidence changed: regenerate the tpm fixtures (scripts/daemon-tpm-fixture.mjs)")
	}
	raw, err := os.ReadFile(filepath.Join(dir, "challenge.json"))
	if errors.Is(err, os.ErrNotExist) {
		t.Skip("no challenge.json yet: node --import ./tests/fixtures/bcx-loader.mjs scripts/daemon-tpm-fixture.mjs")
	}
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		CSRSha256 string `json:"csrSha256"`
		Payload   string `json:"payload"`
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	csr, err1 := base64.RawURLEncoding.DecodeString(c.CSRSha256)
	payload, err2 := base64.RawURLEncoding.DecodeString(c.Payload)
	if err1 != nil || err2 != nil {
		t.Fatal("challenge.json is malformed")
	}
	answer, err := a.Answer(payload, csr)
	if err != nil {
		t.Fatalf("packages/pki's challenge does not activate through bcd's TPM client: %v", err)
	}
	// A quote's clock and signature differ on every run; its fields, the activated secret, the state
	// and the PCR values do not.
	stable := func(raw []byte) map[string]any {
		var e map[string]any
		if err := json.Unmarshal(raw, &e); err != nil {
			t.Fatal(err)
		}
		ans, _ := e["answer"].(map[string]any)
		keys := []string{}
		for k := range ans {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		out := map[string]any{"keys": keys}
		for _, k := range []string{"v", "ek", "ekCert", "ak"} {
			out[k] = e[k]
		}
		for _, k := range []string{"state", "secret", "pcrs"} {
			out["answer."+k] = ans[k]
		}
		return out
	}
	if !fixture(t, filepath.Join(dir, "answer.json"), answer, func(want []byte) bool { return reflect.DeepEqual(stable(want), stable(answer)) }) {
		t.Fatalf("bcd's answer changed: regenerate the tpm fixtures (scripts/daemon-tpm-fixture.mjs)\nwas %v\nnow %v",
			stable(mustRead(t, filepath.Join(dir, "answer.json"))), stable(answer))
	}
}

// fixture writes got to file when it is missing; otherwise it reports whether same accepts the file.
func fixture(t *testing.T, file string, got []byte, same func(want []byte) bool) bool {
	t.Helper()
	want, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(file, got, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", file)
		return true
	}
	if err != nil {
		t.Fatal(err)
	}
	return same(want)
}

func mustRead(t *testing.T, file string) []byte {
	t.Helper()
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
