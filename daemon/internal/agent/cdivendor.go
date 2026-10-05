package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// NVIDIA's CDI spec (nvidia-ctk cdi generate, which the container-toolkit host unit writes as JSON
// with UUID names to /etc/cdi/nvidia.json) holds what a container needs to use a GPU: its device
// nodes, the driver's libraries and the hooks that make them usable. bcd's hold spec copies the
// edits of exactly the held devices from it, so `bcd.dev/gpu=<id>` alone gives a container its GPUs
// and nothing else: with the toolkit in CDI mode NVIDIA_VISIBLE_DEVICES grants nothing, and the
// vendor's nvidia.com/gpu names are not tied to a hold.

// vendorCDIDirs are where vendor specs live (static, then generated at runtime).
var vendorCDIDirs = []string{cdiDir, "/var/run/cdi"}

const vendorCDIKind = "nvidia.com/gpu"

type vendorSpec struct {
	CdiVersion     string   `json:"cdiVersion"`
	Kind           string   `json:"kind"`
	ContainerEdits cdiEdits `json:"containerEdits"`
	Devices        []struct {
		Name           string   `json:"name"`
		ContainerEdits cdiEdits `json:"containerEdits"`
	} `json:"devices"`
}

// vendorCDI is the union of the host's NVIDIA JSON specs.
type vendorCDI struct {
	version string
	common  cdiEdits
	devices map[string]cdiEdits
}

// loadVendorCDI reads the NVIDIA JSON specs under root (the host's / in production). A YAML spec
// (the GPU operator's, or bcd's before the JSON format) is not read: holds then carry only
// NVIDIA_VISIBLE_DEVICES, as before. Nil when there is none.
func loadVendorCDI(root string) *vendorCDI {
	var v *vendorCDI
	for _, dir := range vendorCDIDirs {
		entries, err := os.ReadDir(filepath.Join(root, dir))
		if err != nil {
			continue
		}
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") && !strings.HasPrefix(e.Name(), "bcd-") {
				names = append(names, e.Name())
			}
		}
		sort.Strings(names)
		for _, name := range names {
			raw, err := os.ReadFile(filepath.Join(root, dir, name))
			if err != nil {
				continue
			}
			var spec vendorSpec
			if json.Unmarshal(raw, &spec) != nil || spec.Kind != vendorCDIKind {
				continue
			}
			if v == nil {
				v = &vendorCDI{devices: map[string]cdiEdits{}}
			}
			v.version = laterCDIVersion(v.version, spec.CdiVersion)
			v.common = mergeEdits(v.common, spec.ContainerEdits)
			for _, d := range spec.Devices {
				if _, dup := v.devices[d.Name]; !dup && d.Name != "" {
					v.devices[d.Name] = d.ContainerEdits
				}
			}
		}
	}
	return v
}

// edits returns the vendor edits of the device NVIDIA_VISIBLE_DEVICES would name (a GPU's or a MIG
// device's UUID). WSL 2's spec has one device, "all" (/dev/dxg, shared by every GPU), which stands
// for each of them.
func (v *vendorCDI) edits(visible string) (cdiEdits, bool) {
	if e, ok := v.devices[visible]; ok {
		return e, true
	}
	if e, ok := v.devices["all"]; ok && len(v.devices) == 1 {
		return e, true
	}
	return cdiEdits{}, false
}

// missing lists the atoms the vendor spec does not name (a stale spec: the toolkit unit regenerates
// it when the driver or the GPUs change).
func (v *vendorCDI) missing(atoms []atom) []string {
	var out []string
	for _, a := range atoms {
		if _, ok := v.edits(a.visible); !ok {
			out = append(out, a.id)
		}
	}
	return out
}

// mergeEdits appends b's edits to a's, skipping exact repeats (two slots of one GPU, the common
// edits of two spec files) and the vendor's own NVIDIA_VISIBLE_DEVICES (the hold sets its own).
func mergeEdits(a, b cdiEdits) cdiEdits {
	for _, e := range b.Env {
		if !strings.HasPrefix(e, "NVIDIA_VISIBLE_DEVICES=") && !contains(a.Env, e) {
			a.Env = append(a.Env, e)
		}
	}
	a.DeviceNodes = appendRaw(a.DeviceNodes, b.DeviceNodes)
	a.Mounts = appendRaw(a.Mounts, b.Mounts)
	a.Hooks = appendRaw(a.Hooks, b.Hooks)
	for _, g := range b.AdditionalGIDs {
		if !containsGID(a.AdditionalGIDs, g) {
			a.AdditionalGIDs = append(a.AdditionalGIDs, g)
		}
	}
	return a
}

func appendRaw(a, b []json.RawMessage) []json.RawMessage {
	for _, item := range b {
		dup := false
		for _, have := range a {
			if string(have) == string(item) {
				dup = true
				break
			}
		}
		if !dup {
			a = append(a, item)
		}
	}
	return a
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func containsGID(list []uint32, g uint32) bool {
	for _, x := range list {
		if x == g {
			return true
		}
	}
	return false
}

// laterCDIVersion returns the later of two CDI versions ("0.6.0" < "0.7.0"); a hold spec carrying
// the vendor's edits declares at least the vendor's version (additionalGids need 0.7).
func laterCDIVersion(a, b string) string {
	parse := func(v string) [3]int {
		var out [3]int
		for i, part := range strings.SplitN(v, ".", 3) {
			out[i], _ = strconv.Atoi(part)
		}
		return out
	}
	pa, pb := parse(a), parse(b)
	for i := range pa {
		if pa[i] != pb[i] {
			if pa[i] > pb[i] {
				return a
			}
			return b
		}
	}
	return a
}
