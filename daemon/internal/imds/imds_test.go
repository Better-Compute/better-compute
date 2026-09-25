package imds

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSessionsAreBoundToTheInstance(t *testing.T) {
	from := "inst_a"
	var minted []string
	svc := New(func(*http.Request) (string, bool) { return from, from != "" }, func(_ context.Context, id, aud string) (string, error) {
		minted = append(minted, id+"|"+aud)
		if aud == "bad" {
			return "", Refusal("audience")
		}
		return "jwt-for-" + id, nil
	})
	srv := httptest.NewServer(svc)
	defer srv.Close()
	do := func(method, path string, headers map[string]string) (int, string) {
		req, _ := http.NewRequest(method, srv.URL+path, nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	code, session := do(http.MethodPut, "/latest/api/token", map[string]string{SessionTTLHeader: "300"})
	if code != 200 || !strings.Contains(session, ".") {
		t.Fatalf("session = %d %q", code, session)
	}
	if code, token := do(http.MethodGet, "/latest/identity-token?audience=sts", map[string]string{SessionHeader: session}); code != 200 || token != "jwt-for-inst_a" {
		t.Fatalf("token = %d %q", code, token)
	}
	// Another instance cannot use inst_a's session: the token is minted for the caller only.
	from = "inst_b"
	if code, _ := do(http.MethodGet, "/latest/identity-token", map[string]string{SessionHeader: session}); code != http.StatusUnauthorized {
		t.Fatalf("cross-instance = %d", code)
	}
	from = "inst_a"
	if code, _ := do(http.MethodGet, "/latest/identity-token?audience=bad", map[string]string{SessionHeader: session}); code != http.StatusBadRequest {
		t.Fatalf("refused audience = %d", code)
	}
	if code, _ := do(http.MethodGet, "/latest/identity-token", map[string]string{SessionHeader: session, "X-Forwarded-For": "1.2.3.4"}); code != http.StatusForbidden {
		t.Fatalf("forwarded = %d", code)
	}
	if code, _ := do(http.MethodPut, "/latest/api/token", map[string]string{SessionTTLHeader: "999999"}); code != http.StatusBadRequest {
		t.Fatalf("ttl = %d", code)
	}
	from = ""
	if code, _ := do(http.MethodPut, "/latest/api/token", map[string]string{SessionTTLHeader: "60"}); code != http.StatusNotFound {
		t.Fatalf("stranger = %d", code)
	}
	if len(minted) != 2 {
		t.Fatalf("minted = %v", minted)
	}
}
