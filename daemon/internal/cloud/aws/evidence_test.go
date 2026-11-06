package aws

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// The cross-language contract: testdata/iid-document.json and iid-signature.b64 are an AWS-shaped
// identity document (AWS's own " : " pretty-printing) signed by a throwaway test key whose public
// half is iid-public.pem. Evidence() over them must be exactly testdata/iid-evidence.json, and
// tests/aws-host-iid-evidence.test.ts verifies that file with packages/pki awsInstanceIdentity.
// BCD_UPDATE_GOLDEN=1 rewrites the golden file.
func TestEvidenceGolden(t *testing.T) {
	document, err := os.ReadFile(filepath.Join("testdata", "iid-document.json"))
	if err != nil {
		t.Fatal(err)
	}
	signature, err := os.ReadFile(filepath.Join("testdata", "iid-signature.b64"))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/latest/api/token":
			_, _ = w.Write([]byte("tok"))
		case r.Header.Get(tokenHeader) != "tok":
			w.WriteHeader(http.StatusUnauthorized)
		case r.URL.Path == documentPath:
			_, _ = w.Write(document)
		case r.URL.Path == signaturePath:
			_, _ = w.Write(signature) // wrapped at 64 columns, as served
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := &Client{Root: dmiRoot(t, EC2SysVendor), Endpoint: srv.URL}
	got, err := c.Evidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	golden := filepath.Join("testdata", "iid-evidence.json")
	if os.Getenv("BCD_UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(golden, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("evidence changed:\n got %s\nwant %s", got, want)
	}
}
