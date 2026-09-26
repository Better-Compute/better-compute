package helper

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

// DomainPolicy is what a libvirt domain bcd node asks the helper to define may use. Defining a
// domain is root's power (libvirt chowns its disks to qemu, passes its hostdevs through), so the
// helper checks the XML against this, default-deny, instead of putting the node in the libvirt
// group.
type DomainPolicy struct {
	// Dirs are where a domain's disk and cdrom files may be (bcd's instance, image and volume
	// directories). Absolute, clean.
	Dirs []string
	// CheckFile checks a disk file on the host before libvirt chowns it to qemu: a regular file of
	// the node's (not a symlink, one link), so the node cannot point a disk at a root file.
	CheckFile func(path string) error
	// PCI are the devices a domain may take through (this host's GPUs, "0000:3b:00.0").
	PCI map[string]bool
	// Bridges are the bridges an interface may join ([helper] instance_bridges); none refuses every
	// definition with an interface.
	Bridges map[string]bool
	// Images is the base images' directory: an instance disk is an overlay of
	// <Images>/<image>.<format> (runtime.Libvirt's metadata), a restored one flat.
	Images string
	// Overlay and Base check, as root, what the node wrote: an instance disk's qcow2 header and
	// backing file (runtime.CheckOverlay), a cdrom (runtime.CheckBase).
	Overlay func(path, base, baseFormat string) error
	Base    func(path, format string) error
}

// bcdMetadataNS is bcd's metadata namespace (runtime.Libvirt's instance element).
const bcdMetadataNS = "https://better-compute.dev/libvirt/1"

// domainElements are the elements a domain may have, by path; each maps to the attributes it may
// carry (nil: none). Anything else is refused.
var domainElements = map[string][]string{
	"domain":                                {"type"},
	"domain/name":                           nil,
	"domain/metadata":                       nil,
	"domain/memory":                         {"unit"},
	"domain/vcpu":                           {"placement", "cpuset"},
	"domain/cputune":                        nil,
	"domain/cputune/vcpupin":                {"vcpu", "cpuset"},
	"domain/numatune":                       nil,
	"domain/numatune/memory":                {"mode", "nodeset"},
	"domain/memoryBacking":                  nil,
	"domain/memoryBacking/hugepages":        nil,
	"domain/memoryBacking/hugepages/page":   {"size", "unit", "nodeset"},
	"domain/memoryBacking/locked":           nil,
	"domain/os":                             nil,
	"domain/os/type":                        nil,
	"domain/os/boot":                        {"dev"},
	"domain/features":                       nil,
	"domain/features/acpi":                  nil,
	"domain/features/apic":                  nil,
	"domain/cpu":                            {"mode"},
	"domain/devices":                        nil,
	"domain/devices/disk":                   {"type", "device"},
	"domain/devices/disk/driver":            {"name", "type"},
	"domain/devices/disk/source":            {"file"},
	"domain/devices/disk/target":            {"dev", "bus"},
	"domain/devices/disk/readonly":          nil,
	"domain/devices/disk/serial":            nil,
	"domain/devices/interface":              {"type"},
	"domain/devices/interface/mac":          {"address"},
	"domain/devices/interface/source":       {"bridge"},
	"domain/devices/interface/target":       {"dev"},
	"domain/devices/interface/model":        {"type"},
	"domain/devices/hostdev":                {"mode", "type", "managed"},
	"domain/devices/hostdev/source":         nil,
	"domain/devices/hostdev/source/address": {"domain", "bus", "slot", "function"},
	"domain/devices/memballoon":             {"model"},
	"domain/devices/serial":                 {"type"},
	"domain/devices/console":                {"type"},
}

// DomainName is how bcd names its domains: the instance id.
var DomainName = regexp.MustCompile(`^[a-z]{2,8}_[0-9a-z]{10,52}$`)

// ValidateDomainXML refuses a domain definition that reaches beyond what bcd's instances need, and
// returns the domain's name (an instance id, which bcd's metadata in it must repeat).
func ValidateDomainXML(raw []byte, p DomainPolicy) (string, error) {
	if len(raw) > 1<<20 {
		return "", errors.New("domain: larger than 1 MiB")
	}
	d := xml.NewDecoder(bytes.NewReader(raw))
	d.Strict = true
	var stack []string
	var name strings.Builder
	instanceID, instances := "", 0
	inMetadata, elements := 0, 0
	meta := map[string]*strings.Builder{} // bcd's metadata values (image, format, restored)
	metaAt := ""
	type disk struct{ device, format, file string }
	var disks []disk
	var taps []string
	for {
		tok, err := d.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", fmt.Errorf("domain: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if elements++; elements > 4096 {
				return "", errors.New("domain: too many elements")
			}
			if inMetadata > 0 {
				// bcd's own metadata only: plain values, nothing libvirt acts on.
				if t.Name.Space != bcdMetadataNS {
					return "", fmt.Errorf("domain: metadata %s is not bcd's", t.Name.Local)
				}
				if inMetadata == 1 && t.Name.Local == "instance" {
					instances++
					for _, a := range t.Attr {
						if a.Name.Local == "id" {
							instanceID = a.Value
						}
					}
				}
				if inMetadata == 2 {
					metaAt = t.Name.Local
					if meta[metaAt] == nil {
						meta[metaAt] = &strings.Builder{}
					}
				}
				inMetadata++
				continue
			}
			if t.Name.Space != "" {
				return "", fmt.Errorf("domain: element %s:%s is refused", t.Name.Space, t.Name.Local)
			}
			stack = append(stack, t.Name.Local)
			at := strings.Join(stack, "/")
			allowed, ok := domainElements[at]
			if !ok {
				return "", fmt.Errorf("domain: <%s> is refused", at)
			}
			attrs := map[string]string{}
			for _, a := range t.Attr {
				if a.Name.Space == "xmlns" || (a.Name.Space == "" && a.Name.Local == "xmlns") {
					continue // namespace declarations; the elements' own namespaces are checked
				}
				if a.Name.Space != "" || !contains(allowed, a.Name.Local) {
					return "", fmt.Errorf("domain: attribute %s on <%s> is refused", a.Name.Local, at)
				}
				attrs[a.Name.Local] = a.Value
			}
			if err := checkDomainElement(at, attrs, p); err != nil {
				return "", err
			}
			switch at {
			case "domain/metadata":
				inMetadata = 1
			case "domain/devices/disk":
				disks = append(disks, disk{device: attrs["device"]})
			case "domain/devices/disk/driver":
				disks[len(disks)-1].format = attrs["type"]
			case "domain/devices/disk/source":
				disks[len(disks)-1].file = attrs["file"]
			case "domain/devices/interface":
				taps = append(taps, "")
			case "domain/devices/interface/target":
				taps[len(taps)-1] = attrs["dev"]
			}
		case xml.EndElement:
			if inMetadata > 0 {
				if inMetadata == 3 {
					metaAt = ""
				}
				if inMetadata--; inMetadata > 0 {
					continue
				}
			}
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		case xml.CharData:
			if inMetadata == 3 && metaAt != "" {
				meta[metaAt].Write(t)
				continue
			}
			switch strings.Join(stack, "/") {
			case "domain/name":
				name.Write(t)
			case "domain/os/type":
				if strings.TrimSpace(string(t)) != "hvm" {
					return "", errors.New("domain: os type must be hvm")
				}
			}
		case xml.Directive:
			return "", errors.New("domain: directives are refused")
		case xml.ProcInst:
			if t.Target != "xml" {
				return "", errors.New("domain: processing instructions are refused")
			}
		}
	}
	domainName := strings.TrimSpace(name.String())
	if !DomainName.MatchString(domainName) {
		return "", fmt.Errorf("domain: %q is not an instance id", domainName)
	}
	if instances != 1 || instanceID != domainName {
		return "", errors.New("domain: bcd's metadata must name the domain's instance once")
	}
	// Each interface is on the instance's own tap, as bcd's network rules expect.
	for i, tap := range taps {
		if tap != runtime.TapName(domainName, i) {
			return "", fmt.Errorf("domain: interface %d's tap is %q, not %s", i, tap, runtime.TapName(domainName, i))
		}
	}
	// What the node wrote, checked again as root: the instance disk's qcow2 header and backing file
	// (an overlay of its image, or flat when restored), a cdrom's format.
	value := func(k string) string {
		if b := meta[k]; b != nil {
			return strings.TrimSpace(b.String())
		}
		return ""
	}
	if p.Overlay == nil || p.Base == nil {
		return "", errors.New("domain: no disk image checks configured")
	}
	for _, d := range disks {
		switch {
		case d.device == "cdrom":
			if err := p.Base(d.file, "iso"); err != nil {
				return "", fmt.Errorf("domain: cdrom %s: %w", d.file, err)
			}
		case d.format == "qcow2":
			base, format := "", ""
			if value("restored") == "" {
				image, imageFormat := value("image"), value("format")
				if !imageName.MatchString(image) || (imageFormat != "qcow2" && imageFormat != "raw") {
					return "", errors.New("domain: bcd's metadata names no base image")
				}
				base, format = path.Join(p.Images, image+"."+imageFormat), imageFormat
			}
			if err := p.Overlay(d.file, base, format); err != nil {
				return "", fmt.Errorf("domain: disk %s: %w", d.file, err)
			}
			if base != "" {
				// qemu opens the base too: it must be the node's own image file (not a link to another),
				// and a plain one, naming no further backing or data file (review 2 LOW).
				if err := p.checkDiskFile(base); err != nil {
					return "", err
				}
				if err := p.Base(base, format); err != nil {
					return "", fmt.Errorf("domain: base %s: %w", base, err)
				}
			}
		}
	}
	return domainName, nil
}

// imageName is a base image's name in the images directory: bcd names them by their sha256.
var imageName = regexp.MustCompile(`^[0-9a-f]{64}$`)

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// checkDomainElement checks the values that decide what a domain reaches on the host.
func checkDomainElement(at string, a map[string]string, p DomainPolicy) error {
	switch at {
	case "domain":
		if a["type"] != "kvm" {
			return errors.New("domain: type must be kvm")
		}
	case "domain/devices/disk":
		if a["type"] != "file" || (a["device"] != "disk" && a["device"] != "cdrom") {
			return errors.New("domain: a disk must be a file disk or cdrom")
		}
	case "domain/devices/disk/driver":
		if a["name"] != "qemu" || (a["type"] != "qcow2" && a["type"] != "raw") {
			return errors.New("domain: a disk's driver must be qemu, qcow2 or raw")
		}
	case "domain/devices/disk/source":
		return p.checkDiskFile(a["file"])
	case "domain/devices/interface":
		if a["type"] != "bridge" {
			return errors.New("domain: an interface must be on a bridge")
		}
	case "domain/devices/interface/source":
		if !p.Bridges[a["bridge"]] {
			return fmt.Errorf("domain: bridge %q is not an instance network", a["bridge"])
		}
	case "domain/devices/interface/target":
		if a["dev"] == "" {
			return errors.New("domain: an interface names its tap")
		}
	case "domain/devices/hostdev":
		if a["mode"] != "subsystem" || a["type"] != "pci" || a["managed"] != "yes" {
			return errors.New("domain: only managed PCI devices pass through")
		}
	case "domain/devices/hostdev/source/address":
		addr, err := pciAddress(a)
		if err != nil || !p.PCI[addr] {
			return fmt.Errorf("domain: PCI device %s is not one of this host's GPUs", addr)
		}
	case "domain/devices/memballoon":
		if a["model"] != "none" && a["model"] != "virtio" {
			return errors.New("domain: memballoon must be none or virtio")
		}
	case "domain/devices/serial", "domain/devices/console":
		if a["type"] != "pty" {
			return errors.New("domain: a serial console must be a pty")
		}
	}
	return nil
}

// checkDiskFile admits a disk file only under the policy's dirs, and as a file the host says is
// safe to hand to qemu (CheckFile).
func (p DomainPolicy) checkDiskFile(file string) error {
	if !p.inDirs(file) {
		return fmt.Errorf("domain: disk %q is outside bcd's instance directories", file)
	}
	if p.CheckFile == nil {
		return errors.New("domain: no disk file check configured")
	}
	if err := p.CheckFile(file); err != nil {
		return fmt.Errorf("domain: disk %q: %w", file, err)
	}
	return nil
}

// inDirs reports whether an absolute, clean path lies strictly under one of the policy's dirs.
func (p DomainPolicy) inDirs(file string) bool {
	if file == "" || !path.IsAbs(file) || path.Clean(file) != file {
		return false
	}
	for _, dir := range p.Dirs {
		if dir != "" && dir != "/" && strings.HasPrefix(file, strings.TrimSuffix(dir, "/")+"/") {
			return true
		}
	}
	return false
}

// pciAddress renders a libvirt PCI address (0x-prefixed hex attributes) as "0000:3b:00.0".
func pciAddress(a map[string]string) (string, error) {
	parse := func(name string, bits int) (uint64, error) {
		return strconv.ParseUint(strings.TrimPrefix(strings.ToLower(a[name]), "0x"), 16, bits)
	}
	domain, err1 := parse("domain", 16)
	bus, err2 := parse("bus", 8)
	slot, err3 := parse("slot", 5)
	fn, err4 := parse("function", 3)
	if err := errors.Join(err1, err2, err3, err4); err != nil {
		return "", err
	}
	return fmt.Sprintf("%04x:%02x:%02x.%d", domain, bus, slot, fn), nil
}
