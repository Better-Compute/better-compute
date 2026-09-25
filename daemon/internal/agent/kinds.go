package agent

import (
	"context"
	"crypto/sha256"
	"fmt"
	"sort"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/dispatch"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
	"github.com/better-compute/better-compute/daemon/internal/journal"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// builtinKinds is the v0.1 kind table; lanes, roles and flags agree with @better-compute/protocol
// commandKinds.
func builtinKinds(a *Agent) []*Kind {
	return append(siteKinds(a), []*Kind{
		{
			Name:  "inventory.refresh",
			Lane:  dispatch.LaneControl,
			Roles: []dispatch.Role{dispatch.RoleNode, dispatch.RoleSite, dispatch.RoleRamdisk},
			Exec:  a.runInventoryRefresh,
		},
		{
			Name:  "diag.nvml",
			Lane:  dispatch.LaneControl,
			Roles: []dispatch.Role{dispatch.RoleNode, dispatch.RoleRamdisk},
			Exec:  a.runDiagNvml,
		},
		{
			Name:  "logs.collect",
			Lane:  dispatch.LaneBulk,
			Roles: []dispatch.Role{dispatch.RoleNode, dispatch.RoleSite, dispatch.RoleRamdisk},
			Exec:  a.runLogsCollect,
		},
		{
			Name:        "gpu.reset",
			Lane:        dispatch.LaneControl,
			Roles:       []dispatch.Role{dispatch.RoleNode},
			Destructive: true,
			Exec:        a.runGpuReset,
		},
		{
			Name:        "disk.wipe",
			Lane:        dispatch.LaneProvision,
			Roles:       []dispatch.Role{dispatch.RoleRamdisk},
			Destructive: true,
			Exec:        a.runDiskWipe,
		},
		{
			Name:        "deploy.image",
			Lane:        dispatch.LaneProvision,
			Roles:       []dispatch.Role{dispatch.RoleRamdisk},
			Destructive: true,
			Exec:        a.runDeployImage,
		},
		{
			Name:            "boot.kexec",
			Lane:            dispatch.LaneControl,
			Roles:           []dispatch.Role{dispatch.RoleRamdisk},
			SelfTerminating: true,
			Exec:            a.runKexec,
		},
		{
			Name:  "diag.dcgm",
			Lane:  dispatch.LaneProvision,
			Roles: []dispatch.Role{dispatch.RoleRamdisk, dispatch.RoleNode},
			Exec:  a.runDiagDcgm,
		},
		{
			Name:  "instance.snapshot",
			Lane:  dispatch.LaneBulk,
			Roles: []dispatch.Role{dispatch.RoleNode},
			Exec:  a.runInstanceSnapshot,
		},
		{
			Name:        "driver.invoke",
			Lane:        dispatch.LaneProvision,
			Roles:       []dispatch.Role{dispatch.RoleNode, dispatch.RoleSite, dispatch.RoleRamdisk},
			Destructive: true,
			Exec:        a.runDriverInvoke,
		},
		{
			Name:            "node.reboot",
			Lane:            dispatch.LaneControl,
			Roles:           []dispatch.Role{dispatch.RoleNode, dispatch.RoleSite},
			Destructive:     true,
			SelfTerminating: true,
			Exec:            a.runNodeReboot,
		},
	}...)
}

// payloadOf unpacks a command's request message.
func payloadOf(cmd dispatch.Command, into proto.Message) error {
	if cmd.Body == nil || cmd.Body.GetPayload() == nil {
		return nil // an absent payload is the empty request
	}
	if err := cmd.Body.GetPayload().UnmarshalTo(into); err != nil {
		return invalidPayload(err)
	}
	return nil
}

func succeeded(result proto.Message) (journal.Result, error) {
	b, err := marshal(result)
	if err != nil {
		return journal.Result{}, err
	}
	return journal.Result{Outcome: journal.OutcomeSucceeded, Payload: b}, nil
}

// runInventoryRefresh (re)sends the requested sections as InventorySection frames, then succeeds
// with their hashes.
func (a *Agent) runInventoryRefresh(_ context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &agentv1.InventoryRefreshRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	known := map[string]bool{"images": true}
	for _, n := range inventory.SectionNames() {
		known[n] = true
	}
	var unknown []string
	for _, n := range req.GetSections() {
		if !known[n] {
			unknown = append(unknown, n)
		}
	}
	if len(unknown) > 0 {
		return journal.Result{}, invalidPayload(fmt.Errorf("unknown inventory sections %v", unknown))
	}
	sections, err := a.collect(req.GetRescan())
	if err != nil {
		return journal.Result{}, &KindError{Code: "inventory-failed", Message: err.Error()}
	}
	names := map[string]bool{}
	for _, n := range req.GetSections() {
		names[n] = true
	}
	result := &agentv1.InventoryRefreshResult{SectionHashes: map[string][]byte{}}
	var send []int
	for i, s := range sections {
		if len(names) == 0 || names[s.Name] {
			send = append(send, i)
			result.SectionHashes[s.Name] = s.Sha256
		}
	}
	a.sendSections(sections, send)
	return succeeded(result)
}

// runDiagNvml checks every (or the listed) GPU; the result says whether all checks passed. It reads
// the collected GPU inventory (NVML on a real host, fakehw in tests).
func (a *Agent) runDiagNvml(_ context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &agentv1.DiagNvmlRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	if _, err := a.collect(true); err != nil {
		return journal.Result{}, &KindError{Code: "inventory-failed", Message: err.Error()}
	}
	a.invMu.Lock()
	var section *inventory.GpusSection
	if a.inv != nil {
		section = a.inv.Gpus
	}
	a.invMu.Unlock()
	nvml := section != nil
	checks := []*agentv1.DiagnosticCheck{{Name: "nvml.init", Passed: nvml}}
	if !nvml {
		checks[0].Message = "NVML is not available on this node"
		return succeeded(&agentv1.DiagNvmlResult{Passed: false, Checks: checks})
	}
	visible := section.Gpus
	if want := req.GetExpectedGpuCount(); want > 0 {
		checks = append(checks, &agentv1.DiagnosticCheck{
			Name:    "gpu.count",
			Passed:  uint32(len(visible)) >= want,
			Message: fmt.Sprintf("%d of %d GPUs visible", len(visible), want),
		})
	}
	byUUID := map[string]*inventory.Gpu{}
	for _, g := range visible {
		byUUID[g.Uuid] = g
	}
	var wanted []string
	if len(req.GetGpuUuids()) > 0 {
		seen := map[string]bool{}
		for _, u := range req.GetGpuUuids() {
			if !seen[u] {
				seen[u] = true
				wanted = append(wanted, u)
			}
		}
	} else {
		for u := range byUUID {
			wanted = append(wanted, u)
		}
	}
	sort.Strings(wanted)
	passed := true
	for _, c := range checks {
		passed = passed && c.GetPassed()
	}
	result := &agentv1.DiagNvmlResult{GpuCount: uint32(len(visible)), DriverVersion: section.DriverVersion, Checks: checks}
	for _, u := range wanted {
		g := byUUID[u]
		if g == nil {
			result.Gpus = append(result.Gpus, &agentv1.GpuDiagnostic{Uuid: u, Checks: []*agentv1.DiagnosticCheck{
				{Name: "gpu.present", Message: "not visible to NVML"},
			}})
			passed = false
			continue
		}
		failing := map[string]bool{}
		if g.Ecc != nil && g.Ecc.VolatileCounts != nil && g.Ecc.VolatileCounts.Uncorrectable > 0 {
			failing["ecc.uncorrectable"] = true
		}
		if g.RowRemap != nil {
			failing["row-remap.pending"] = g.RowRemap.Pending
			failing["row-remap.failure"] = g.RowRemap.Failure
		}
		gd := &agentv1.GpuDiagnostic{Uuid: u, Passed: true}
		for _, name := range []string{"ecc.uncorrectable", "row-remap.pending", "row-remap.failure", "pcie.link", "xid.recent"} {
			c := &agentv1.DiagnosticCheck{Name: name, Passed: !failing[name]}
			if failing[name] {
				c.Message = name + " failed"
				gd.Passed = false
			}
			gd.Checks = append(gd.Checks, c)
		}
		passed = passed && gd.Passed
		result.Gpus = append(result.Gpus, gd)
	}
	result.Passed = passed
	return succeeded(result)
}

// runNodeReboot waits delay_ms (so RUNNING can reach the gateway), journals running{boot_id} and
// reboots. It completes as SUCCEEDED{rebooted} after the restart, with the boot it ran in.
func (a *Agent) runNodeReboot(ctx context.Context, cmd dispatch.Command) (journal.Result, error) {
	req := &agentv1.NodeRebootRequest{}
	if err := payloadOf(cmd, req); err != nil {
		return journal.Result{}, err
	}
	if d := time.Duration(req.GetDelayMs()) * time.Millisecond; d > 0 {
		if err := sleepCtx(ctx, d); err != nil {
			return journal.Result{}, err
		}
	}
	if err := a.markRunning(cmd.ID); err != nil {
		return journal.Result{}, err
	}
	a.flush(2 * time.Second)
	reason := req.GetReason()
	if reason == "" {
		reason = "node.reboot " + cmd.ID
	}
	a.log.Warn("rebooting", "command", cmd.ID, "reason", reason)
	if err := a.host.Reboot(reason); err != nil {
		return journal.Result{}, &KindError{Code: "reboot-failed", Message: err.Error()}
	}
	// A reboot in progress: the process ends before this returns; if it does not, wait for it.
	<-ctx.Done()
	return journal.Result{}, ctx.Err()
}

// flush waits until the session's outbox is empty (at most d), so frames reach the gateway before
// the process ends.
func (a *Agent) flush(d time.Duration) {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		s := a.sess
		a.mu.Unlock()
		if s == nil || len(s.out) == 0 {
			time.Sleep(100 * time.Millisecond) // the writer may still be sending the last frame
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// ---- inventory ---------------------------------------------------------------------------------

// collect returns the encoded inventory sections, re-collecting from the host when rescan is set or
// nothing was collected yet.
func (a *Agent) collect(rescan bool) ([]inventory.Section, error) {
	a.invMu.Lock()
	defer a.invMu.Unlock()
	if !rescan && a.collected != nil {
		return a.collected, nil
	}
	inv, err := a.host.Inventory()
	if err != nil {
		return nil, err
	}
	sections, err := inventory.EncodeSections(inv)
	if err != nil {
		return nil, err
	}
	// The "images" section (not in the P0 inventory mirror): the site image cache, when it holds
	// anything, encoded with the generated message (deterministic, no maps).
	if images := a.cache.section(); len(images.GetImages()) > 0 {
		content, err := marshal(images)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(content)
		sections = append(sections, inventory.Section{Name: "images", Content: content, Sha256: sum[:]})
	}
	a.inv = inv
	a.collected = sections
	a.collectedAt = time.Now()
	return sections, nil
}

// refreshSections re-collects the inventory and sends the sections whose hash changed.
func (a *Agent) refreshSections() {
	a.invMu.Lock()
	before := map[string]string{}
	for _, s := range a.collected {
		before[s.Name] = string(s.Sha256)
	}
	a.invMu.Unlock()
	sections, err := a.collect(true)
	if err != nil {
		return
	}
	var changed []int
	for i, s := range sections {
		if before[s.Name] != string(s.Sha256) {
			changed = append(changed, i)
		}
	}
	if len(changed) > 0 {
		a.sendSections(sections, changed)
	}
}

// inventoryHashes maps section names to the SHA-256 of their content (Hello, heartbeats).
func (a *Agent) inventoryHashes() map[string][]byte {
	a.invMu.Lock()
	defer a.invMu.Unlock()
	out := make(map[string][]byte, len(a.collected))
	for _, s := range a.collected {
		out[s.Name] = s.Sha256
	}
	return out
}

// sendSections sends the sections at the given indexes as InventorySection frames.
func (a *Agent) sendSections(sections []inventory.Section, indexes []int) {
	a.invMu.Lock()
	at := a.collectedAt
	a.invMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	collected := timestamppb.New(at.Add(a.offset))
	for _, i := range indexes {
		s := sections[i]
		a.sendLocked(&agentv1.AgentFrame{Msg: &agentv1.AgentFrame_Inventory{Inventory: &agentv1.InventorySection{
			Section:       s.Name,
			Sha256:        s.Sha256,
			Content:       s.Content,
			CollectedAt:   collected,
			SchemaVersion: 1,
		}}})
	}
}
