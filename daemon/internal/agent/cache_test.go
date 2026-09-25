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
	s.next(t, "site converged", func(f *agentv1.AgentFrame) bool {
		return f.GetStatus() != nil && siteState(f.GetStatus()) == agentv1.SectionState_SECTION_STATE_CONVERGED
	})
	srv := httptest.NewServer(h.agent.BootHandler(BootConfig{}))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/cache/" + hex.EncodeToString(good[:]))
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
