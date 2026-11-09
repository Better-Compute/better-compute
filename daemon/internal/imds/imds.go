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
//
// A guest controls how often it asks, so every instance has its own token buckets: one for all its
// requests (counted before anything is looked up for it), one for the identity tokens it has minted.
// Past them the answer is 429; a control plane that cannot be asked now is 503. Neither costs the
// host more than the refusal.
package imds

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
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

// ErrUnavailable is Mint's error when the control plane cannot be asked now (no session, too many
// requests already waiting, no answer in time): the request is answered 503 and may be tried again.
var ErrUnavailable = errors.New("the control plane cannot be reached now")

// Limit is a token bucket: Burst requests at once, refilled at PerSecond.
type Limit struct {
	PerSecond float64
	Burst     int
}

// The default limits of one instance: every request, and the identity tokens it has minted.
var (
	DefaultRequests = Limit{PerSecond: 20, Burst: 100}
	DefaultMints    = Limit{PerSecond: 2, Burst: 10}
)

// Service answers instances' metadata requests.
type Service struct {
	// InstanceOf names the instance a request came from (its own interface and address), or false.
	InstanceOf func(r *http.Request) (string, bool)
	// Claim, when set, names without asking any runtime the instance a request's source address is
	// bound to, or false (nobody's: 404). The request limit is counted against it before InstanceOf
	// confirms it; without Claim the limit is per source address.
	Claim func(r *http.Request) (string, bool)
	// Mint asks the control plane for the instance's workload token; a Refusal is passed through,
	// ErrUnavailable is a 503.
	Mint func(ctx context.Context, instanceID, audience string) (string, error)
	Now  func() time.Time
	// Requests and Mints are each instance's limits (default DefaultRequests, DefaultMints).
	Requests, Mints Limit
	key             []byte

	mu      sync.Mutex
	buckets map[string]*bucket
}

// bucket is one token bucket's state.
type bucket struct {
	tokens float64
	at     time.Time
}

// maxBuckets bounds the limiter's memory: past it, buckets that have refilled (they say nothing any
// more) are dropped.
const maxBuckets = 4096

// allow takes one token from the bucket named kind and who; false when it is empty.
func (s *Service) allow(kind, who string, limit, fallback Limit) bool {
	if limit.Burst <= 0 || limit.PerSecond <= 0 {
		limit = fallback
	}
	now := s.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.buckets == nil {
		s.buckets = map[string]*bucket{}
	}
	key := kind + "\x00" + who
	b := s.buckets[key]
	if b == nil {
		if len(s.buckets) >= maxBuckets {
			for k, old := range s.buckets {
				if now.Sub(old.at).Seconds()*limit.PerSecond >= float64(limit.Burst) {
					delete(s.buckets, k)
				}
			}
			if len(s.buckets) >= maxBuckets {
				return false // every bucket is in use: refuse rather than grow
			}
		}
		b = &bucket{tokens: float64(limit.Burst), at: now}
		s.buckets[key] = b
	}
	if elapsed := now.Sub(b.at).Seconds(); elapsed > 0 {
		b.tokens = min(float64(limit.Burst), b.tokens+elapsed*limit.PerSecond)
		b.at = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// tooMany answers a request past its instance's limit.
func tooMany(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	text(w, http.StatusTooManyRequests, "Too many requests from this instance")
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
	// Who the limit is counted against is settled cheaply, before any runtime is asked anything.
	who := r.RemoteAddr
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		who = host
	}
	if s.Claim != nil {
		claimed, ok := s.Claim(r)
		if !ok {
			text(w, http.StatusNotFound, "No such instance on this host")
			return
		}
		who = claimed
	}
	if !s.allow("request", who, s.Requests, DefaultRequests) {
		tooMany(w)
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
		// Each mint is a signed request to the control plane over the host's own session.
		if !s.allow("mint", instance, s.Mints, DefaultMints) {
			tooMany(w)
			return
		}
		token, err := s.Mint(r.Context(), instance, r.URL.Query().Get("audience"))
		if errors.Is(err, ErrUnavailable) {
			w.Header().Set("Retry-After", "1")
			text(w, http.StatusServiceUnavailable, "The control plane cannot be reached now; try again")
			return
		}
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
