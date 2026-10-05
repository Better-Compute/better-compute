package hostconfig

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// TestRealGPUUnitsPlan plans the GPU units against this host's real driver and GPUs, through the real
// OSSystem, and applies nothing (Plan must not change the host). It runs only with BCD_REAL_GPU=1 on
// a host with an NVIDIA GPU, e.g. `BCD_REAL_GPU=1 node scripts/daemon-test.mjs --run TestRealGPUUnitsPlan
// ./internal/hostconfig/`. It pins what a converged GPU host must plan: nothing for its own driver
// branch and its current power limit; and what it must refuse rather than attempt.
func TestRealGPUUnitsPlan(t *testing.T) {
	if os.Getenv("BCD_REAL_GPU") != "1" {
		t.Skip("set BCD_REAL_GPU=1 on a host with NVIDIA GPUs")
	}
	ctx := context.Background()
	sys := &OSSystem{}
	out, err := sys.Run(ctx, Cmd{Name: "nvidia-smi", Args: []string{"--query-gpu=driver_version,power.limit", "--format=csv,noheader,nounits"}})
	if err != nil {
		t.Fatalf("nvidia-smi: %v", err)
	}
	first, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	version, limit, _ := strings.Cut(first, ",")
	version, limit = strings.TrimSpace(version), strings.TrimSpace(limit)
	branch := branchOf(version)
	t.Logf("driver %s (branch %s), power limit %s W, paravirtual %v", version, branch, limit, paravirtualGPU(sys))

	plan := func(u Unit, settings string) ([]converge.Action, error) {
		actions, err := u.Plan(ctx, sys, json.RawMessage(settings))
		var names []string
		for _, a := range actions {
			names = append(names, a.Description)
		}
		t.Logf("%s %s: %d action(s) %v, err %v", u.Name(), settings, len(actions), names, err)
		return actions, err
	}

	// The host's own branch: converged (persistence aside, which a bare-metal host may still need).
	actions, err := plan(NvidiaDriver{}, `{"branch":"`+branch+`"}`)
	if err != nil {
		t.Fatalf("own branch: %v", err)
	}
	for _, a := range actions {
		if !strings.Contains(a.Description, "persistenced") {
			t.Fatalf("own branch plans %q", a.Description)
		}
	}
	// Another branch on WSL is refused, never installed.
	if paravirtualGPU(sys) {
		if _, err := plan(NvidiaDriver{}, `{"branch":"470"}`); !errors.Is(err, converge.ErrTerminal) {
			t.Fatalf("other branch on WSL: %v", err)
		}
	}
	// The current power limit: nothing to do.
	if limit != "" && !strings.HasPrefix(limit, "[") {
		if actions, err := plan(GPUSettings{}, `{"powerLimitWatts":`+limit+`}`); err != nil || len(actions) != 0 {
			t.Fatalf("current power limit: %d %v", len(actions), err)
		}
	}
	// Informational: what the rest plan here.
	_, _ = plan(MigLayout{}, `{"layout":"all-disabled"}`)
	_, _ = plan(FabricManager{}, `{}`)
	_, _ = plan(ContainerToolkit{}, `{"cdi":true}`)
}
