package pki

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

// packages/protocol/golden/signing.json pins the signing input of every purpose; the Go framing must
// produce the same bytes as @better-compute/protocol's signingInput.
func TestSigningInputGoldens(t *testing.T) {
	data, err := os.ReadFile("../../../packages/protocol/golden/signing.json")
	if err != nil {
		t.Skipf("goldens not available: %v", err)
	}
	var vectors []struct {
		Name    string   `json:"name"`
		Purpose string   `json:"purpose"`
		Parts   []string `json:"parts"`
		Input   string   `json:"input"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) == 0 {
		t.Fatal("no vectors")
	}
	for _, v := range vectors {
		parts := make([][]byte, len(v.Parts))
		for i, p := range v.Parts {
			parts[i], err = hex.DecodeString(p)
			if err != nil {
				t.Fatal(err)
			}
		}
		if got := hex.EncodeToString(SigningInput(v.Purpose, parts...)); got != v.Input {
			t.Errorf("%s: signing input differs\n got %s\nwant %s", v.Name, got, v.Input)
		}
	}
}

func TestSignAndVerifyP1363(t *testing.T) {
	key, _ := GenerateKey()
	input := SigningInput(PurposeCommandUpdate, []byte("cmd_1"))
	sig, err := SignP1363(key, input)
	if err != nil || len(sig) != 64 {
		t.Fatalf("sig %x %v", sig, err)
	}
	if !VerifyP1363(&key.PublicKey, input, sig) {
		t.Fatal("does not verify")
	}
	sig[10] ^= 1
	if VerifyP1363(&key.PublicKey, input, sig) {
		t.Fatal("verified a tampered signature")
	}
	if VerifyP1363(&key.PublicKey, input, sig[:63]) {
		t.Fatal("verified a short signature")
	}
}
