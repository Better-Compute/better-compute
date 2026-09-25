package pki

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"google.golang.org/protobuf/proto"
)

type secretFixtures struct {
	Now                    int64  `json:"now"`
	NodeKeyPKCS8           string `json:"nodeKeyPkcs8"`
	SecretRequest          string `json:"secretRequest"`
	SecretEphemeralPKCS8   string `json:"secretEphemeralPkcs8"`
	SecretResponse         string `json:"secretResponse"`
	WorkloadRequest        string `json:"workloadRequest"`
	WorkloadEphemeralPKCS8 string `json:"workloadEphemeralPkcs8"`
	WorkloadResponse       string `json:"workloadResponse"`
}

func TestSecretAndWorkloadAnswersFromTypeScript(t *testing.T) {
	data, err := os.ReadFile("testdata/interop.json")
	if err != nil {
		t.Fatal(err)
	}
	var f secretFixtures
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	node := pkcs8(t, f.NodeKeyPKCS8)
	now := time.UnixMilli(f.Now)

	req := &agentv1.SecretRequest{}
	if err := proto.Unmarshal(unhex(t, f.SecretRequest), req); err != nil {
		t.Fatal(err)
	}
	// Go frames the request exactly as TS signed it.
	if !VerifyP1363(&node.PublicKey, SecretRequestSigningInput(req), req.GetNodeSig().GetSig()) {
		t.Fatal("the TS node signature does not verify over Go's secret-request input")
	}
	resp := &agentv1.SecretResponse{}
	_ = proto.Unmarshal(unhex(t, f.SecretResponse), resp)
	value, err := OpenSecretResponse(resp, pkcs8(t, f.SecretEphemeralPKCS8), req, now)
	if err != nil || string(value) != "hello secret" {
		t.Fatalf("secret = %q, %v", value, err)
	}
	if _, err := OpenSecretResponse(resp, pkcs8(t, f.SecretEphemeralPKCS8), req, now.Add(2*time.Minute)); err == nil {
		t.Fatal("an expired answer opened")
	}
	other := proto.Clone(req).(*agentv1.SecretRequest)
	other.Ref = "secret://other"
	if _, err := OpenSecretResponse(resp, pkcs8(t, f.SecretEphemeralPKCS8), other, now); err == nil {
		t.Fatal("an answer for another ref opened")
	}
	if _, err := OpenSecretResponse(&agentv1.SecretResponse{Error: "not-bound"}, nil, req, now); err == nil {
		t.Fatal("a refusal opened")
	}

	wreq := &agentv1.WorkloadTokenRequest{}
	_ = proto.Unmarshal(unhex(t, f.WorkloadRequest), wreq)
	if !VerifyP1363(&node.PublicKey, WorkloadTokenRequestSigningInput(wreq), wreq.GetNodeSig().GetSig()) {
		t.Fatal("the TS node signature does not verify over Go's workload-token input")
	}
	wresp := &agentv1.WorkloadTokenResponse{}
	_ = proto.Unmarshal(unhex(t, f.WorkloadResponse), wresp)
	token, err := OpenWorkloadTokenResponse(wresp, pkcs8(t, f.WorkloadEphemeralPKCS8), wreq, now)
	if err != nil || token != "eyJ.workload.jwt" {
		t.Fatalf("token = %q, %v", token, err)
	}

	// Go's own requests verify the same way (the control plane checks them with pki).
	mine, eph, err := NewSecretRequest(node, "secret://x", SecretBinding{AllocationID: "a1"})
	if err != nil || eph == nil || !VerifyP1363(&node.PublicKey, SecretRequestSigningInput(mine), mine.GetNodeSig().GetSig()) {
		t.Fatalf("own request: %v", err)
	}
	kid, _ := KeyID(&node.PublicKey)
	if mine.GetNodeSig().GetKid() != kid || len(mine.GetEpk()) != 65 {
		t.Fatalf("own request = %v", mine)
	}
}
