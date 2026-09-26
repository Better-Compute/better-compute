package agent

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	sitev1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/site/v1"
	"google.golang.org/protobuf/proto"
)

func TestSiteCacheWarmsAndServes(t *testing.T) {
	image := make([]byte, 1<<20)
	_, _ = rand.Read(image)
	good := sha256.Sum256(image)
	bad := sha256.Sum256([]byte("something else"))
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(image) }))
	defer upstream.Close()
	h := newHarness(t, func(o *Options) {
		o.State.Role = "site"
		o.ConvergeRetry = 100 * time.Millisecond
	})
	s, _ := h.open()
	spec := &agentv1.NodeSpec{Site: &sitev1.SiteSpec{
		Boot:        &sitev1.BootLeaseState{Active: true, Epoch: 1, TtlMs: 15_000},
		CacheImages: []*sitev1.CacheImage{{Url: upstream.URL + "/ubuntu.raw", Sha256: good[:], Format: "raw"}},
	}}
	s.push(desired(1, spec))
	siteState := func(st *agentv1.StatusReport) agentv1.SectionState {
		for _, sec := range st.GetSections() {
			if sec.GetSection() == "site" {
				return sec.GetState()
			}
		}
		return agentv1.SectionState_SECTION_STATE_UNSPECIFIED
	}
	// The pull completes (the "images" section goes out), then the retried pass converges the site.
	var images *agentv1.InventorySection
	converged := false
	for images == nil || !converged {
		f := s.next(t, "images section and converged site", func(f *agentv1.AgentFrame) bool {
			return f.GetStatus() != nil || f.GetInventory().GetSection() == "images"
		})
		if st := f.GetStatus(); st != nil && siteState(st) == agentv1.SectionState_SECTION_STATE_CONVERGED {
			converged = true
		}
		if inv := f.GetInventory(); inv != nil {
			sec := &agentv1.ImagesSection{}
			_ = proto.Unmarshal(inv.GetContent(), sec)
			if len(sec.GetImages()) == 1 && sec.GetImages()[0].GetState() == agentv1.CachedImageState_CACHED_IMAGE_STATE_READY {
				images = inv
			}
		}
	}
	sec := &agentv1.ImagesSection{}
	_ = proto.Unmarshal(images.GetContent(), sec)
	if img := sec.GetImages()[0]; !bytes.Equal(img.GetSha256(), good[:]) || img.GetRef() != upstream.URL+"/ubuntu.raw" ||
		img.GetSizeBytes() != uint64(len(image)) || sec.GetUsedBytes() != uint64(len(image)) || img.GetLastUsed().AsTime().Minute() != 0 {
		t.Fatalf("images section = %v", sec)
	}
	if sum := sha256.Sum256(images.GetContent()); !bytes.Equal(sum[:], images.GetSha256()) {
		t.Fatal("the images section hash does not cover its content")
	}
	srv := httptest.NewServer(h.agent.BootHandler(BootConfig{}))
	defer srv.Close()
	// Never without a grant; a grant of one image serves only it.
	for _, path := range []string{"/cache/" + hex.EncodeToString(good[:]), "/cache/t/00000000000000000000000000000000/" + hex.EncodeToString(good[:])} {
		if resp, err := http.Get(srv.URL + path); err != nil || resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s served without a grant: %v", path, resp.Status)
		}
	}
	other := strings.Replace(h.agent.cacheURL(srv.URL, time.Now().Add(time.Hour), hex.EncodeToString(bad[:]), false), hex.EncodeToString(bad[:]), hex.EncodeToString(good[:]), 1)
	if resp, err := http.Get(other); err != nil || resp.StatusCode != http.StatusNotFound {
		t.Fatal("a grant of another image served this one")
	}
	resp, err := http.Get(h.agent.cacheURL(srv.URL, time.Now().Add(time.Hour), hex.EncodeToString(good[:]), false))
	if err != nil {
		t.Fatal(err)
	}
	served, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !bytes.Equal(served, image) {
		t.Fatalf("cache served %d, %d bytes", resp.StatusCode, len(served))
	}
	if resp, _ := http.Get(srv.URL + "/cache/../journal.db"); resp != nil && resp.StatusCode == http.StatusOK {
		t.Fatal("the cache served a path outside it")
	}
	// An image whose bytes are not its digest is never cached: the section fails.
	spec2 := proto.Clone(spec).(*agentv1.NodeSpec)
	spec2.Site.CacheImages = append(spec2.Site.CacheImages, &sitev1.CacheImage{Url: upstream.URL + "/evil.raw", Sha256: bad[:]})
	s.push(desired(2, spec2))
	s.next(t, "site failed", func(f *agentv1.AgentFrame) bool {
		return f.GetStatus() != nil && siteState(f.GetStatus()) == agentv1.SectionState_SECTION_STATE_FAILED
	})
	if h.agent.cache.has(hex.EncodeToString(bad[:])) {
		t.Fatal("a mismatching image was cached")
	}
}

func TestDeployImageFromTheSiteCache(t *testing.T) {
	image := make([]byte, 1<<20)
	_, _ = rand.Read(image)
	sum := sha256.Sum256(image)
	cache := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cache/"+hex.EncodeToString(sum[:]) {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(image)
	}))
	defer cache.Close()
	h, disks := ramdiskHarness(t, func(o *Options) { o.ImageCache = cache.URL + "/cache" })
	s, _ := h.open()
	d := body("d1", "deploy.image", &agentv1.DeployImageRequest{
		// The source is unreachable: only the cache can serve it.
		Url: "http://127.0.0.1:1/ubuntu.raw", Sha256: sum[:], RootDisk: &agentv1.RootDiskHint{Serial: disks[0].Serial},
	})
	s.push(command(d))
	s.update(t, "d1", commonv1.CommandState_COMMAND_STATE_SUCCEEDED)
	got := make([]byte, len(image))
	f, _ := os.Open(h.host.Path("/dev/" + disks[0].Name))
	_, _ = f.ReadAt(got, 0)
	f.Close()
	if !bytes.Equal(got, image) {
		t.Fatal("the disk does not hold the cached image")
	}
}

func TestCacheEvictsLeastRecentlyUsedOutsideTheKeepSet(t *testing.T) {
	c := newImageCache(t.TempDir())
	c.maxBytes = 250
	_ = os.MkdirAll(c.dir, 0o755)
	put := func(name string, size int, used time.Time) string {
		digest := hex.EncodeToString(bytes.Repeat([]byte(name), 32))[:64]
		_ = os.WriteFile(c.path(digest), make([]byte, size), 0o644)
		c.saveMeta(digest, cacheMeta{Ref: "https://img/" + name, LastUsed: used})
		return digest
	}
	now := time.Now()
	oldest := put("a", 100, now.Add(-3*time.Hour))
	pinned := put("b", 100, now.Add(-2*time.Hour))
	newest := put("c", 100, now.Add(-time.Hour))
	changed := 0
	c.changed = func() { changed++ }
	if n := c.evict(map[string]bool{pinned: true}); n != 1 || changed != 1 {
		t.Fatalf("evicted %d (changed %d)", n, changed)
	}
	if c.has(oldest) || !c.has(pinned) || !c.has(newest) {
		t.Fatal("the wrong image went")
	}
	// Under budget: nothing more goes; the pinned image stays even when it is the oldest.
	if n := c.evict(map[string]bool{pinned: true}); n != 0 {
		t.Fatalf("evicted %d under budget", n)
	}
	if sec := c.section(); sec.GetCapacityBytes() != 250 || sec.GetUsedBytes() != 200 {
		t.Fatalf("section = %v", sec)
	}
}
