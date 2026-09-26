package helper

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/hostconfig"
)

// anyGPU in the busy set makes every GPU busy.
const anyGPU = "*"

// rootBusyGPUs is which GPUs hold work, as root sees it, never as the node says (mig-layout leaves
// them alone): GPUs with compute processes (nvidia-smi), and the GPUs the live holds' CDI specs
// name (/etc/cdi/bcd-*.json, root's files). A device id names its GPU first ("<uuid>/gi1/ci0").
// A source that cannot be read adds nothing; the other still counts.
func rootBusyGPUs(ctx context.Context, sys hostconfig.System) map[string]bool {
	busy := map[string]bool{}
	if out, err := sys.Run(ctx, hostconfig.Cmd{Name: "nvidia-smi", Args: []string{"--query-compute-apps=gpu_uuid", "--format=csv,noheader"}}); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			switch uuid := strings.TrimSpace(line); {
			case strings.HasPrefix(uuid, "GPU-"):
				busy[uuid] = true
			case strings.HasPrefix(uuid, "MIG-"):
				// A MIG device's UUID does not name its GPU: every GPU counts as busy.
				busy[anyGPU] = true
			}
		}
	}
	names, err := sys.ReadDir("/etc/cdi")
	if err != nil {
		return busy
	}
	for _, name := range names {
		if !strings.HasPrefix(name, "bcd-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		raw, err := sys.ReadFile("/etc/cdi/" + name)
		if err != nil {
			continue
		}
		var spec struct {
			Devices []struct {
				Name string `json:"name"`
			} `json:"devices"`
		}
		if json.Unmarshal(raw, &spec) != nil {
			continue
		}
		for _, d := range spec.Devices {
			if gpu, _, _ := strings.Cut(d.Name, "/"); gpu != "" {
				busy[gpu] = true
			}
		}
	}
	return busy
}
