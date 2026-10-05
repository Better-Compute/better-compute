package runtime

import (
	"context"
	"encoding/xml"
	"fmt"
	"os/exec"
	"strings"
)

// GPU persistence mode around passthrough. nvidia-persistenced (kept running by the nvidia-driver
// host unit) holds every GPU open in persistence mode, and the nvidia driver's unbind waits until the
// GPU is closed: a passthrough start (SysfsVFIO.Bind, or libvirt's managed hostdevs, which unbind on
// their own) then hangs or fails. Persistence goes off for exactly the GPUs a VM takes before it
// starts, and on again once they are back on nvidia. Best effort both ways; root's work.

// NvidiaPersistence sets one GPU's persistence mode (nvidia-smi -i <pci address> -pm 0|1).
func NvidiaPersistence(addr string, on bool) error {
	mode := "0"
	if on {
		mode = "1"
	}
	out, err := exec.Command("nvidia-smi", "-i", addr, "-pm", mode).CombinedOutput()
	if err != nil {
		return fmt.Errorf("nvidia-smi -i %s -pm %s: %v: %s", addr, mode, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// DomainGPUs lists a libvirt domain's PCI passthrough addresses ("0000:3b:00.0") from its XML.
func DomainGPUs(raw []byte) []string {
	var d domainXML
	if xml.Unmarshal(raw, &d) != nil {
		return nil
	}
	var out []string
	for _, h := range d.Devices.Hostdevs {
		if h.Type != "pci" {
			continue
		}
		a := h.Source.Address
		hex := func(v string, width int) string {
			v = strings.TrimPrefix(strings.ToLower(v), "0x")
			for len(v) < width {
				v = "0" + v
			}
			return v
		}
		addr := hex(a.Domain, 4) + ":" + hex(a.Bus, 2) + ":" + hex(a.Slot, 2) + "." + strings.TrimPrefix(strings.ToLower(a.Function), "0x")
		if pciAddress.MatchString(addr) {
			out = append(out, addr)
		}
	}
	return out
}

// domainGPUPersistence sets the persistence of every GPU a domain passes through, when this process
// runs libvirt itself (as root); under a Hypervisor (bcd helper) the helper does it.
func (l *Libvirt) domainGPUPersistence(ctx context.Context, id string, on bool) {
	set := l.GPUPersistence
	if set == nil && l.Exec == nil {
		set = NvidiaPersistence // the real virsh: the real GPUs
	}
	if l.Hypervisor != nil || set == nil {
		return
	}
	raw, err := l.virsh(ctx, "dumpxml", id)
	if err != nil {
		return
	}
	for _, addr := range DomainGPUs(raw) {
		_ = set(addr, on)
	}
}
