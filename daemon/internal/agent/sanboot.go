package agent

import (
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Sanboot (ProxyDhcpEntry.sanboot_sha256): a machine whose BMC has no virtual media (ipmi) boots the
// profile's ISO over the network instead. iPXE's `sanboot` reads it with HTTP range requests from
// this agent's image cache, which serves only verified blobs. No discovery token or bc.* parameter
// goes in: it is the vendor or OS ISO as it is. A digest the site spec does not name as an iso cache
// image, or that is not cached yet, is never booted (and never falls back to the ramdisk).

// sanbootable reports whether digest (hex) is an iso cache image of the site spec, cached.
func (a *Agent) sanbootable(digest string) bool {
	a.mu.Lock()
	iso := a.sanbootISOs[digest]
	a.mu.Unlock()
	return iso && a.cache.has(digest)
}

func (a *Agent) serveSanboot(w http.ResponseWriter, mac string, digest []byte, cfg BootConfig) {
	hexDigest := hex.EncodeToString(digest)
	if len(digest) != 32 || !a.sanbootable(hexDigest) {
		a.log.Warn("sanboot image not available", "mac", mac, "sha256", hexDigest)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = fmt.Fprint(w, "#!ipxe\necho The installer image is not on this boot server yet.\nsleep 30\nchain ${self}\n")
		return
	}
	a.log.Info("sanboot script served", "mac", mac, "sha256", hexDigest)
	_, _ = fmt.Fprintf(w, "#!ipxe\nsanboot --no-describe %s/cache/%s\n", strings.TrimRight(cfg.URL, "/"), hexDigest)
}

// sanbootProblems are the live boot entries whose sanboot image the site spec does not name as a
// cached iso (the site section fails with them, rather than a machine waiting on a script forever).
func (a *Agent) sanbootProblems(now time.Time) []string {
	var out []string
	for mac, digest := range a.boot.Sanboots(now) {
		hexDigest := hex.EncodeToString(digest)
		a.mu.Lock()
		iso := a.sanbootISOs[hexDigest]
		a.mu.Unlock()
		if !iso {
			out = append(out, fmt.Sprintf("sanboot image %s of %s is not an iso cache image of the site", hexDigest, mac))
		}
	}
	sort.Strings(out)
	return out
}
