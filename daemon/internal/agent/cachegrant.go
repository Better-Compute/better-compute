package agent

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"
)

// Cache grants (review 2 LOW 5): the site cache holds tenants' deploy images, so it serves nothing to
// whoever asks. Every URL it hands out carries an unguessable grant: /cache/t/<grant>/<sha256>.
//   - a prepared machine's boot (bc.cache for its ramdisk's deploy.image, its sanboot ISO): valid
//     until its boot entry lapses and only while this agent holds the boot lease;
//   - a BMC's firmware image (verifiedFirmware): that one digest, for firmwareGrantTTL.
// A grant bound to a digest serves only it; a boot's serves any cached image (the ramdisk deploys
// what its command names, and the digest is re-checked there).

const (
	firmwareGrantTTL = 2 * time.Hour
	bootGrantTTL     = 6 * time.Hour // a boot entry without its own not_after
)

var grantPath = regexp.MustCompile(`^/cache/t/([0-9a-f]{32})/([0-9a-f]{64})$`)

type cacheGrant struct {
	notAfter time.Time
	digest   string // "": any cached image
	boot     bool   // needs the boot lease
}

type cacheGrants struct {
	mu sync.Mutex
	m  map[string]cacheGrant
}

// grantCache mints a grant and returns its token.
func (a *Agent) grantCache(notAfter time.Time, digest string, boot bool) string {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	token := hex.EncodeToString(raw)
	g := &a.cacheGrants
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.m == nil {
		g.m = map[string]cacheGrant{}
	}
	now := time.Now()
	for t, old := range g.m {
		if now.After(old.notAfter) {
			delete(g.m, t)
		}
	}
	g.m[token] = cacheGrant{notAfter: notAfter, digest: digest, boot: boot}
	return token
}

// bootGrantEnd is when a boot's cache grant lapses: with its boot entry.
func bootGrantEnd(e interface{ GetNotAfter() *timestamppb.Timestamp }, now time.Time) time.Time {
	if na := e.GetNotAfter(); na != nil {
		return na.AsTime()
	}
	return now.Add(bootGrantTTL)
}

// cacheURL is base's URL of digest under a new grant.
func (a *Agent) cacheURL(base string, notAfter time.Time, digest string, boot bool) string {
	return strings.TrimRight(base, "/") + "/cache/t/" + a.grantCache(notAfter, digest, boot) + "/" + digest
}

// serveCache answers GET /cache/t/<grant>/<sha256>; anything else is not found.
func (a *Agent) serveCache(w http.ResponseWriter, r *http.Request) {
	m := grantPath.FindStringSubmatch(r.URL.Path)
	if m == nil {
		http.NotFound(w, r)
		return
	}
	token, digest := m[1], m[2]
	g := &a.cacheGrants
	g.mu.Lock()
	grant, ok := g.m[token]
	g.mu.Unlock()
	switch {
	case !ok || time.Now().After(grant.notAfter), grant.digest != "" && grant.digest != digest:
		http.NotFound(w, r)
		return
	case grant.boot:
		if _, active := a.bootActive(); !active {
			http.Error(w, "this boot server does not hold the site boot lease", http.StatusServiceUnavailable)
			return
		}
	}
	r2 := r.Clone(r.Context())
	r2.URL.Path = "/cache/" + digest
	a.cache.serve(w, r2)
}
