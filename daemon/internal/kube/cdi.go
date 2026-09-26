package kube

import (
	"encoding/json"
	"errors"
	"io/fs"
	"regexp"
	"sort"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
)

// Where the devices converger keeps holds (agent/devices.go): one CDI spec per allocation,
// /etc/cdi/bcd-<allocation>.json, kind bcd.dev/gpu, a device per atom.
const (
	CDIDir = "/etc/cdi"
	// cdiRunDir is where nvidia-ctk may write generated specs.
	cdiRunDir = "/var/run/cdi"

	annotationAllocation = "bcd.dev/allocation-id"
	// AnnotationBinding marks a hold's binding in its CDI spec; the plugin advertises only the
	// devices of holds whose binding is BindingKubernetes.
	AnnotationBinding = "bcd.dev/binding"
	BindingKubernetes = "kubernetes"

	// The kubelet resources bcd advertises, by device class.
	ResourceGPU     = "bcd.dev/gpu"
	ResourceGPUMig  = "bcd.dev/gpu.mig"
	ResourceGPUSlot = "bcd.dev/gpu.slot"

	// cdiKind is the kind of bcd's hold specs.
	cdiKind = "bcd.dev/gpu"
	// nvidiaKind is the kind nvidia-ctk cdi generate writes.
	nvidiaKind = "nvidia.com/gpu"
)

// Resources lists the kubelet resources in a stable order.
var Resources = []string{ResourceGPU, ResourceGPUMig, ResourceGPUSlot}

// Hold is a hold bound to Kubernetes: its allocation and its devices (CDI device names, which are
// the atom ids).
type Hold struct {
	AllocationID string
	Devices      []string
}

type holdSpec struct {
	Kind        string            `json:"kind"`
	Annotations map[string]string `json:"annotations"`
	Devices     []struct {
		Name string `json:"name"`
	} `json:"devices"`
}

// ReadHolds reads the Kubernetes-bound holds from the CDI directory, by allocation id.
func ReadHolds(sys hostconfig.System) ([]Hold, error) {
	names, err := sys.ReadDir(CDIDir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Hold
	for _, name := range names {
		if !strings.HasPrefix(name, "bcd-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		b, err := sys.ReadFile(CDIDir + "/" + name)
		if err != nil {
			return nil, err
		}
		var spec holdSpec
		if json.Unmarshal(b, &spec) != nil || spec.Kind != cdiKind || spec.Annotations[AnnotationBinding] != BindingKubernetes {
			continue
		}
		h := Hold{AllocationID: spec.Annotations[annotationAllocation]}
		if h.AllocationID == "" {
			continue
		}
		for _, d := range spec.Devices {
			if d.Name != "" {
				h.Devices = append(h.Devices, d.Name)
			}
		}
		sort.Strings(h.Devices)
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AllocationID < out[j].AllocationID })
	return out, nil
}

var (
	migAtom  = regexp.MustCompile(`[/_]gi\d+[/_]ci\d+$`)
	slotAtom = regexp.MustCompile(`[/_]s\d+$`)
)

// ResourceOf maps an atom id to its kubelet resource: "<gpu>/gi<g>/ci<c>" is MIG, "<gpu>/s<k>" a
// time-sliced slot, anything else a whole GPU.
func ResourceOf(atom string) string {
	switch {
	case migAtom.MatchString(atom):
		return ResourceGPUMig
	case slotAtom.MatchString(atom):
		return ResourceGPUSlot
	}
	return ResourceGPU
}

// GPUOf returns the GPU UUID an atom is part of.
func GPUOf(atom string) string {
	if i := strings.IndexAny(atom, "/_"); i > 0 {
		return atom[:i]
	}
	return atom
}

var yamlName = regexp.MustCompile(`^\s*-?\s*name:\s*["']?([^"'\s#]+)`)

// nvidiaDevices lists the device names of the NVIDIA CDI specs (nvidia-ctk cdi generate, JSON or
// YAML): with the uuid naming strategy these are GPU UUIDs and MIG-… UUIDs. Allocate names them
// next to bcd's own, so containerd injects the device nodes and driver libraries.
func nvidiaDevices(sys hostconfig.System) map[string]bool {
	out := map[string]bool{}
	for _, dir := range []string{CDIDir, cdiRunDir} {
		names, err := sys.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, name := range names {
			if strings.HasPrefix(name, "bcd-") {
				continue
			}
			b, err := sys.ReadFile(dir + "/" + name)
			if err != nil {
				continue
			}
			switch {
			case strings.HasSuffix(name, ".json"):
				var spec holdSpec
				if json.Unmarshal(b, &spec) == nil && spec.Kind == nvidiaKind {
					for _, d := range spec.Devices {
						out[d.Name] = true
					}
				}
			case strings.HasSuffix(name, ".yaml"), strings.HasSuffix(name, ".yml"):
				// The generated YAML: a top-level "kind:" and a "devices:" list of "- name: …"
				// entries (containerEdits carry no names). No YAML parser: bcd only needs the names.
				text := string(b)
				if !strings.Contains(text, "kind: "+nvidiaKind) {
					continue
				}
				inDevices, item := false, -1
				for _, line := range strings.Split(text, "\n") {
					if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "-") {
						inDevices, item = strings.HasPrefix(line, "devices:"), -1
						continue
					}
					if !inDevices {
						continue
					}
					trimmed := strings.TrimLeft(line, " ")
					// A device is a list item of devices: (the first item fixes their indent); its
					// name is on the dash line or a key two columns in, never a nested name.
					if strings.HasPrefix(trimmed, "- ") && (item < 0 || indent(line) == item) {
						item = indent(line)
					}
					dashName := indent(line) == item && strings.HasPrefix(trimmed, "- name:")
					keyName := indent(line) == item+2 && strings.HasPrefix(trimmed, "name:")
					if m := yamlName.FindStringSubmatch(line); m != nil && item >= 0 && (dashName || keyName) {
						out[m[1]] = true
					}
				}
			}
		}
	}
	return out
}

func indent(line string) int { return len(line) - len(strings.TrimLeft(line, " ")) }
