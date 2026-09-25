package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	sitev1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/site/v1"
)

// The site image cache (PLAN.md §11.5): the images the site's pools pre-warm (SiteSpec.cache_images)
// are pulled once, re-verified against their SHA-256 and served to the site's ramdisks at
// /cache/<sha256 hex> by the boot server. A ramdisk's deploy.image tries the cache first and falls
// back to the image's source; the digest is checked either way, so the cache can never substitute
// an image.

var digestPath = regexp.MustCompile(`^[0-9a-f]{64}$`)

// imageCache holds verified images by digest under dir.
type imageCache struct {
	dir     string
	mu      sync.Mutex
	pulling map[string]bool
	failed  map[string]string
}

func newImageCache(dir string) *imageCache {
	return &imageCache{dir: dir, pulling: map[string]bool{}, failed: map[string]string{}}
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
		busy := c.pulling[digest]
		reason, bad := c.failed[digest]
		if !busy {
			c.pulling[digest] = true
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
			c.mu.Unlock()
			if err != nil {
				log("image cache pull failed", "url", url, "error", err.Error())
			} else {
				log("image cached", "url", url, "sha256", digest)
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
	http.ServeFile(w, r, c.path(digest))
}
