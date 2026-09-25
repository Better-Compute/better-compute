package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	sitev1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/site/v1"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// The site image cache (PLAN.md §11.5): the images the site's pools pre-warm (SiteSpec.cache_images)
// are pulled once, re-verified against their SHA-256 and served to the site's ramdisks at
// /cache/<sha256 hex> by the boot server. A ramdisk's deploy.image tries the cache first and falls
// back to the image's source; the digest is checked either way, so the cache can never substitute
// an image.

var digestPath = regexp.MustCompile(`^[0-9a-f]{64}$`)

// imageCache holds verified images by digest under dir, each with a <digest>.json sidecar (the ref it
// was pulled by, its last use).
type imageCache struct {
	dir     string
	mu      sync.Mutex
	pulling map[string]string // digest → ref
	failed  map[string]string
	// changed is called when an image becomes ready (the inventory's images section changes).
	changed func()
}

type cacheMeta struct {
	Ref      string    `json:"ref"`
	LastUsed time.Time `json:"lastUsed"`
}

func newImageCache(dir string) *imageCache {
	return &imageCache{dir: dir, pulling: map[string]string{}, failed: map[string]string{}}
}

func (c *imageCache) meta(digest string) cacheMeta {
	var m cacheMeta
	if raw, err := os.ReadFile(c.path(digest) + ".json"); err == nil {
		_ = json.Unmarshal(raw, &m)
	}
	return m
}

func (c *imageCache) saveMeta(digest string, m cacheMeta) {
	if raw, err := json.Marshal(m); err == nil {
		_ = os.WriteFile(c.path(digest)+".json", raw, 0o644)
	}
}

// section is the inventory "images" section: the ready images and the ones pulling, sorted by
// digest, at most 1,000 (the most recently used), last use truncated to the hour.
func (c *imageCache) section() *agentv1.ImagesSection {
	s := &agentv1.ImagesSection{}
	entries, _ := os.ReadDir(c.dir)
	for _, e := range entries {
		digest := e.Name()
		if !digestPath.MatchString(digest) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		raw, _ := hex.DecodeString(digest)
		m := c.meta(digest)
		img := &agentv1.CachedImage{Ref: m.Ref, Sha256: raw, SizeBytes: uint64(info.Size()), State: agentv1.CachedImageState_CACHED_IMAGE_STATE_READY}
		if !m.LastUsed.IsZero() {
			img.LastUsed = timestamppb.New(m.LastUsed.Truncate(time.Hour))
		}
		s.Images = append(s.Images, img)
		s.UsedBytes += img.SizeBytes
	}
	c.mu.Lock()
	for digest, ref := range c.pulling {
		raw, _ := hex.DecodeString(digest)
		s.Images = append(s.Images, &agentv1.CachedImage{Ref: ref, Sha256: raw, State: agentv1.CachedImageState_CACHED_IMAGE_STATE_PULLING})
	}
	c.mu.Unlock()
	if len(s.Images) > 1000 {
		sort.Slice(s.Images, func(i, j int) bool { return lastUsed(s.Images[i]).After(lastUsed(s.Images[j])) })
		s.Images = s.Images[:1000]
	}
	sort.Slice(s.Images, func(i, j int) bool { return bytes.Compare(s.Images[i].Sha256, s.Images[j].Sha256) < 0 })
	return s
}

func lastUsed(i *agentv1.CachedImage) time.Time {
	if i.GetLastUsed() == nil {
		return time.Time{}
	}
	return i.GetLastUsed().AsTime()
}

func (c *imageCache) path(digest string) string { return filepath.Join(c.dir, digest) }

// has reports whether a verified copy is cached.
func (c *imageCache) has(digest string) bool {
	_, err := os.Stat(c.path(digest))
	return err == nil
}

// warm starts pulling every image not cached yet and reports how many are still missing.
func (c *imageCache) warm(ctx context.Context, images []*sitev1.CacheImage, client *http.Client, log func(string, ...any)) (missing int, failures []string) {
	for _, img := range images {
		if len(img.GetSha256()) != sha256.Size {
			failures = append(failures, img.GetUrl()+": no sha256")
			continue
		}
		digest := hex.EncodeToString(img.GetSha256())
		if c.has(digest) {
			continue
		}
		c.mu.Lock()
		_, busy := c.pulling[digest]
		reason, bad := c.failed[digest]
		if !busy {
			c.pulling[digest] = img.GetUrl()
			delete(c.failed, digest)
		}
		c.mu.Unlock()
		if bad {
			failures = append(failures, img.GetUrl()+": "+reason)
		}
		missing++
		if busy {
			continue
		}
		go func(url, digest string) {
			err := c.pull(ctx, client, url, digest)
			c.mu.Lock()
			delete(c.pulling, digest)
			if err != nil {
				c.failed[digest] = err.Error()
			}
			changed := c.changed
			c.mu.Unlock()
			if err != nil {
				log("image cache pull failed", "url", url, "error", err.Error())
			} else {
				c.saveMeta(digest, cacheMeta{Ref: url, LastUsed: time.Now()})
				log("image cached", "url", url, "sha256", digest)
			}
			if changed != nil {
				changed()
			}
		}(img.GetUrl(), digest)
	}
	return missing, failures
}

// pull downloads url, verifying its digest before the copy becomes visible.
func (c *imageCache) pull(ctx context.Context, client *http.Client, url, digest string) error {
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
		return errors.New("not an http(s) URL")
	}
	if err := os.MkdirAll(c.dir, 0o755); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET returned %s", resp.Status)
	}
	tmp, err := os.CreateTemp(c.dir, ".pull-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), resp.Body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	tmp.Close()
	if got := hex.EncodeToString(h.Sum(nil)); got != digest {
		return fmt.Errorf("sha256 %s is not the pinned %s", got, digest)
	}
	return os.Rename(tmp.Name(), c.path(digest))
}

// serve answers GET /cache/<sha256 hex>.
func (c *imageCache) serve(w http.ResponseWriter, r *http.Request) {
	digest := strings.TrimPrefix(r.URL.Path, "/cache/")
	if !digestPath.MatchString(digest) || !c.has(digest) {
		http.NotFound(w, r)
		return
	}
	m := c.meta(digest)
	if time.Since(m.LastUsed) > time.Hour {
		m.LastUsed = time.Now()
		c.saveMeta(digest, m)
	}
	http.ServeFile(w, r, c.path(digest))
}
