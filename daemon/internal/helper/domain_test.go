package helper

import (
	"errors"
	"strings"
	"testing"

	"github.com/better-compute/better-compute/daemon/internal/runtime"
)

var (
	tap0       = runtime.TapName("inst_01k5w0000000000000000000ab", 0)
	goodDomain = strings.Replace(goodDomainTemplate, "TAP0", tap0, 1)
)

const goodDomainTemplate = `<domain type="kvm">
  <name>inst_01k5w0000000000000000000ab</name>
  <metadata><bc:instance xmlns:bc="https://better-compute.dev/libvirt/1" id="inst_01k5w0000000000000000000ab"><bc:image>ubuntu</bc:image><bc:format>qcow2</bc:format></bc:instance></metadata>
  <memory unit="KiB">4194304</memory>
  <vcpu placement="static" cpuset="4-7">2</vcpu>
  <cputune><vcpupin vcpu="0" cpuset="4"></vcpupin></cputune>
  <memoryBacking><hugepages><page size="1" unit="G" nodeset="0"></page></hugepages><locked></locked></memoryBacking>
  <os><type>hvm</type><boot dev="hd"></boot></os>
  <features><acpi></acpi><apic></apic></features>
  <cpu mode="host-passthrough"></cpu>
  <devices>
    <disk type="file" device="disk"><driver name="qemu" type="qcow2"></driver><source file="/var/lib/bcd/libvirt/instances/inst_01k5w0000000000000000000ab/disk.qcow2"></source><target dev="vda" bus="virtio"></target></disk>
    <disk type="file" device="cdrom"><driver name="qemu" type="raw"></driver><source file="/var/lib/bcd/libvirt/images/abc.iso"></source><target dev="sda" bus="sata"></target><readonly></readonly></disk>
    <disk type="file" device="disk"><driver name="qemu" type="raw"></driver><source file="/var/lib/bcd/volumes/vol_01k5w0000000000000000000cd.raw"></source><target dev="vdb" bus="virtio"></target><serial>bcv-0000000000cd</serial></disk>
    <interface type="bridge"><mac address="52:54:00:12:34:56"></mac><source bridge="bcnet0"></source><target dev="TAP0"></target><model type="virtio"></model></interface>
    <hostdev mode="subsystem" type="pci" managed="yes"><source><address domain="0x0000" bus="0x3b" slot="0x00" function="0x0"></address></source></hostdev>
    <memballoon model="virtio"></memballoon>
    <serial type="pty"></serial>
    <console type="pty"></console>
  </devices>
</domain>`

func domainPolicy(checked *[]string) DomainPolicy {
	return DomainPolicy{
		Dirs:      []string{"/var/lib/bcd/libvirt/instances", "/var/lib/bcd/libvirt/images", "/var/lib/bcd/volumes"},
		CheckFile: func(p string) error { *checked = append(*checked, p); return nil },
		PCI:       map[string]bool{"0000:3b:00.0": true},
		Bridges:   map[string]bool{"bcnet0": true},
		Images:    "/var/lib/bcd/libvirt/images",
		Overlay: func(p, base, format string) error {
			*checked = append(*checked, "overlay "+p+" "+base+" "+format)
			return nil
		},
		Base: func(p, format string) error { *checked = append(*checked, "base "+p+" "+format); return nil },
	}
}

func TestValidateDomainXML(t *testing.T) {
	var checked []string
	name, err := ValidateDomainXML([]byte(goodDomain), domainPolicy(&checked))
	if err != nil || name != "inst_01k5w0000000000000000000ab" || len(checked) != 5 {
		t.Fatalf("good domain: %q %v (checked %v)", name, err, checked)
	}
	// Root checks the overlay against the metadata's image, and the cdrom's format.
	joined := strings.Join(checked, "\n")
	for _, want := range []string{
		"overlay /var/lib/bcd/libvirt/instances/inst_01k5w0000000000000000000ab/disk.qcow2 /var/lib/bcd/libvirt/images/ubuntu.qcow2 qcow2",
		"base /var/lib/bcd/libvirt/images/abc.iso iso",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("checks %q, want %q", checked, want)
		}
	}
	// A restored domain's disk is flat: no base.
	checked = nil
	restored := strings.Replace(goodDomain, `<bc:format>qcow2</bc:format>`, `<bc:format>qcow2</bc:format><bc:restored>snap_1</bc:restored>`, 1)
	if _, err := ValidateDomainXML([]byte(restored), domainPolicy(&checked)); err != nil || !strings.Contains(strings.Join(checked, "\n"), "disk.qcow2  \n") && !strings.Contains(strings.Join(checked, "\n"), "disk.qcow2  ") {
		t.Fatalf("restored: %v %q", err, checked)
	}
	bad := map[string][2]string{
		"qemu commandline":  {`</devices>`, `</devices><qemu:commandline xmlns:qemu="http://libvirt.org/schemas/domain/qemu/1.0"><qemu:arg value="-foo"></qemu:arg></qemu:commandline>`},
		"a disk in /etc":    {`/var/lib/bcd/volumes/vol_01k5w0000000000000000000cd.raw`, `/etc/shadow`},
		"a dotted escape":   {`/var/lib/bcd/volumes/vol_01k5w0000000000000000000cd.raw`, `/var/lib/bcd/volumes/../../../etc/shadow`},
		"a block disk":      {`<disk type="file" device="disk"><driver name="qemu" type="qcow2">`, `<disk type="block" device="disk"><driver name="qemu" type="qcow2">`},
		"a source dev":      {`<source file="/var/lib/bcd/libvirt/images/abc.iso">`, `<source file="/var/lib/bcd/libvirt/images/abc.iso" dev="/dev/sda">`},
		"filesystem":        {`<memballoon`, `<filesystem type="mount"><source dir="/"></source><target dir="host"></target></filesystem><memballoon`},
		"another GPU":       {`bus="0x3b"`, `bus="0x3c"`},
		"a USB hostdev":     {`type="pci" managed="yes"`, `type="usb" managed="yes"`},
		"unmanaged hostdev": {`managed="yes"`, `managed="no"`},
		"a host bridge":     {`bridge="bcnet0"`, `bridge="br0"`},
		"direct interface":  {`<interface type="bridge">`, `<interface type="direct">`},
		"someone's tap":     {`dev="` + tap0 + `"`, `dev="eth0"`},
		"no base image":     {`<bc:format>qcow2</bc:format>`, `<bc:format>vmdk</bc:format>`},
		"a file console":    {`<serial type="pty"></serial>`, `<serial type="file"><source path="/etc/passwd"></source></serial>`},
		"graphics":          {`<memballoon`, `<graphics type="vnc" listen="0.0.0.0"></graphics><memballoon`},
		"an emulator":       {`<memballoon`, `<emulator>/tmp/evil</emulator><memballoon`},
		"os kernel":         {`<boot dev="hd"></boot>`, `<boot dev="hd"></boot><kernel>/tmp/vmlinuz</kernel>`},
		"not kvm":           {`<domain type="kvm">`, `<domain type="qemu">`},
		"foreign metadata":  {`<bc:image>ubuntu</bc:image>`, `<x:y xmlns:x="urn:x"></x:y>`},
		"metadata mismatch": {`id="inst_01k5w0000000000000000000ab"`, `id="inst_01k5w0000000000000000000zz"`},
		"a name not an id":  {`<name>inst_01k5w0000000000000000000ab</name>`, `<name>../etc</name>`},
		"a doctype":         {`<domain type="kvm">`, `<!DOCTYPE domain [<!ENTITY x SYSTEM "file:///etc/shadow">]><domain type="kvm">`},
		"seclabel":          {`<memballoon`, `<seclabel type="none"></seclabel><memballoon`},
	}
	for what, edit := range bad {
		if !strings.Contains(goodDomain, edit[0]) {
			t.Fatalf("%s: the fixture has no %q", what, edit[0])
		}
		var none []string
		if _, err := ValidateDomainXML([]byte(strings.Replace(goodDomain, edit[0], edit[1], 1)), domainPolicy(&none)); err == nil {
			t.Fatalf("%s: accepted", what)
		}
	}
	// The host's own check has the last word on every disk.
	p := domainPolicy(&checked)
	p.CheckFile = func(string) error { return errors.New("a symlink") }
	if _, err := ValidateDomainXML([]byte(goodDomain), p); err == nil || !strings.Contains(err.Error(), "a symlink") {
		t.Fatalf("file check: %v", err)
	}
}
