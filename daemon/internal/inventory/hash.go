// Package inventory holds NodeInventory v1 and the encoding of its sections (PLAN.md §10.1,
// proto/bettercompute/agent/v1/inventory.proto).
//
// Inventory travels as sections. A section's content is the protobuf binary encoding of its
// canonicalized message (repeated fields sorted by their stable key), and its hash is the SHA-256
// of that content. Hello and every 10th heartbeat carry the hashes; the control plane pulls the
// sections whose hash changed, verifies each content against its hash and never re-encodes to
// compare, so only this daemon's own encoding has to be stable.
//
// types.go and encode.go are generated from inventory.proto by mirror.mjs until daemon/gen exists.
package inventory

import (
	"cmp"
	"crypto/sha256"
	"errors"
	"sort"
)

// SectionNames returns the inventory sections in a fixed order.
func SectionNames() []string {
	return []string{"system", "cpu", "memory", "disks", "nics", "gpus", "bmc", "os"}
}

// Section is one encoded section, as InventorySection carries it.
type Section struct {
	Name    string
	Content []byte
	Sha256  []byte
}

// EncodeSections canonicalizes inv in place and returns every section it has, in SectionNames
// order. A section that is nil in inv is absent and has no hash.
func EncodeSections(inv *NodeInventory) ([]Section, error) {
	if inv == nil {
		return nil, errors.New("inventory: nil inventory")
	}
	Canonicalize(inv)
	encoders := []struct {
		name    string
		present bool
		encode  func(*protoWriter)
	}{
		{"system", inv.System != nil, inv.System.encode},
		{"cpu", inv.Cpu != nil, inv.Cpu.encode},
		{"memory", inv.Memory != nil, inv.Memory.encode},
		{"disks", inv.Disks != nil, inv.Disks.encode},
		{"nics", inv.Nics != nil, inv.Nics.encode},
		{"gpus", inv.Gpus != nil, inv.Gpus.encode},
		{"bmc", inv.Bmc != nil, inv.Bmc.encode},
		{"os", inv.Os != nil, inv.Os.encode},
	}
	var sections []Section
	for _, e := range encoders {
		if !e.present {
			continue
		}
		var w protoWriter
		e.encode(&w)
		sum := sha256.Sum256(w.buf)
		sections = append(sections, Section{Name: e.name, Content: w.buf, Sha256: sum[:]})
	}
	return sections, nil
}

// SectionHashes canonicalizes inv in place and returns section name → SHA-256, the map Hello and
// Heartbeat carry as inventory_hashes.
func SectionHashes(inv *NodeInventory) (map[string][]byte, error) {
	sections, err := EncodeSections(inv)
	if err != nil {
		return nil, err
	}
	hashes := make(map[string][]byte, len(sections))
	for _, s := range sections {
		hashes[s.Name] = s.Sha256
	}
	return hashes, nil
}

// Canonicalize sorts every repeated field of inv by its stable key, as inventory.proto requires
// before encoding: CPU flags and OS runtimes by value; NUMA nodes by id; hugepage pools (the host's
// and each NUMA node's) by page size; DIMMs by slot; disks by name; NICs by MAC; GPUs by index; MIG profiles by id and instances
// by (gi_id, ci_id); NVLinks by link number; topology by peer UUID. Keys are expected to be unique;
// ties keep their order, and nil elements sort first.
func Canonicalize(inv *NodeInventory) {
	if inv == nil {
		return
	}
	if c := inv.Cpu; c != nil {
		sort.Strings(c.Flags)
		sortBy(c.NumaNodes, func(n *NumaNode) uint32 { return n.Id })
		for _, n := range c.NumaNodes {
			if n != nil {
				sortBy(n.Hugepages, func(p *HugepagePool) uint64 { return p.PageSizeBytes })
			}
		}
	}
	if m := inv.Memory; m != nil {
		sortBy(m.Hugepages, func(p *HugepagePool) uint64 { return p.PageSizeBytes })
		sortBy(m.Dimms, func(d *Dimm) string { return d.Slot })
	}
	if d := inv.Disks; d != nil {
		sortBy(d.Disks, func(d *Disk) string { return d.Name })
	}
	if n := inv.Nics; n != nil {
		sortBy(n.Nics, func(n *Nic) string { return n.Mac })
	}
	if g := inv.Gpus; g != nil {
		sortBy(g.Gpus, func(g *Gpu) uint32 { return g.Index })
		for _, gpu := range g.Gpus {
			if gpu == nil {
				continue
			}
			if mig := gpu.Mig; mig != nil {
				sortBy(mig.Profiles, func(p *MigProfile) uint32 { return p.Id })
				sortBy(mig.Instances, func(i *MigInstance) uint64 { return uint64(i.GiId)<<32 | uint64(i.CiId) })
			}
			sortBy(gpu.Nvlinks, func(l *NvlinkLink) uint32 { return l.Link })
			sortBy(gpu.Topology, func(p *GpuPeerLink) string { return p.PeerUuid })
		}
	}
	if o := inv.Os; o != nil {
		sort.Strings(o.Runtimes)
	}
}

func sortBy[T any, K cmp.Ordered](s []*T, key func(*T) K) {
	sort.SliceStable(s, func(i, j int) bool {
		a, b := s[i], s[j]
		if a == nil || b == nil {
			return a == nil && b != nil
		}
		return key(a) < key(b)
	})
}
