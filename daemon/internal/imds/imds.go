// Package imds is the metadata service a VPS host serves its instances (PLAN.md §12.2, §13; v0.5),
// IMDSv2-style, as FakeDaemon's FakeImds does:
//
//	PUT /latest/api/token      (x-bc-metadata-token-ttl-seconds: 1..21600) → a session token bound
//	                           to the instance the request came from by an HMAC;
//	GET /latest/identity-token?audience=…  (x-bc-metadata-token) → a workload-identity token,
//	                           minted by the control plane for THAT instance only.
//
// The instance is known from where the request arrived, never from a request field; forwarded
// requests are refused, which blocks the usual SSRF relays. The host holds no signing key: Mint
// asks the control plane, which checks that the instance is placed on this node.
package imds

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Header names (@better-compute/pki workload.ts).
const (
	SessionHeader    = "x-bc-metadata-token"
	SessionTTLHeader = "x-bc-metadata-token-ttl-seconds"
)

// Refusal is a control-plane refusal code ("not-bound", "disabled", "audience", …).
type Refusal string

func (r Refusal) Error() string { return "refused: " + string(r) }

// Service answers instances' metadata requests.
type Service struct {
	// InstanceOf names the instance a request came from (its own interface and address), or false.
	InstanceOf func(r *http.Request) (string, bool)
	// Mint asks the control plane for the instance's workload token; a Refusal is passed through.
	Mint func(ctx context.Context, instanceID, audience string) (string, error)
	Now  func() time.Time
	key  []byte
}

// New builds a service with a fresh HMAC key: session tokens die with the host process.
func New(instanceOf func(*http.Request) (string, bool), mint func(context.Context, string, string) (string, error)) *Service {
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	return &Service{InstanceOf: instanceOf, Mint: mint, Now: time.Now, key: key}
}

func (s *Service) mac(instanceID string, expires int64) []byte {
	m := hmac.New(sha256.New, s.key)
	fmt.Fprintf(m, "bc-imds/v1\x00%s\x00%d", instanceID, expires)
	return m.Sum(nil)
}

func text(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(status)
	_, _ = fmt.Fprint(w, body)
}

// ServeHTTP answers one request.
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("Forwarded") != "" {
		text(w, http.StatusForbidden, "Forwarded requests are refused")
		return
	}
	instance, ok := s.InstanceOf(r)
	if !ok {
		text(w, http.StatusNotFound, "No such instance on this host")
		return
	}
	switch r.URL.Path {
	case "/latest/api/token":
		if r.Method != http.MethodPut {
			text(w, http.StatusMethodNotAllowed, "Use PUT")
			return
		}
		ttl, err := strconv.Atoi(r.Header.Get(SessionTTLHeader))
		if err != nil || ttl < 1 || ttl > 21_600 {
			text(w, http.StatusBadRequest, SessionTTLHeader+" must be 1 to 21600")
			return
		}
		expires := s.Now().Unix() + int64(ttl)
		text(w, http.StatusOK, fmt.Sprintf("%d.%s", expires, base64.RawURLEncoding.EncodeToString(s.mac(instance, expires))))
	case "/latest/identity-token":
		if r.Method != http.MethodGet {
			text(w, http.StatusMethodNotAllowed, "Use GET")
			return
		}
		expiresText, tag, _ := strings.Cut(r.Header.Get(SessionHeader), ".")
		expires, err := strconv.ParseInt(expiresText, 10, 64)
		given, err2 := base64.RawURLEncoding.DecodeString(tag)
		if err != nil || err2 != nil || expires <= s.Now().Unix() || !hmac.Equal(given, s.mac(instance, expires)) {
			text(w, http.StatusUnauthorized, "A valid metadata session token is required")
			return
		}
		token, err := s.Mint(r.Context(), instance, r.URL.Query().Get("audience"))
		if err != nil {
			code := http.StatusForbidden
			if ref, ok := err.(Refusal); ok && ref == "audience" {
				code = http.StatusBadRequest
			}
			text(w, code, "Refused: "+err.Error())
			return
		}
		text(w, http.StatusOK, token)
	default:
		text(w, http.StatusNotFound, "Not found")
	}
}
