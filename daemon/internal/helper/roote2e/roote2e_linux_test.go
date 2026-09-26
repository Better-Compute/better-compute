//go:build linux && helpere2e

package roote2e

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	commonv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/common/v1"
	"github.com/better-compute/better-compute/daemon/internal/helper"
	"github.com/better-compute/better-compute/daemon/internal/pki"
	"github.com/better-compute/better-compute/daemon/internal/runtime"
	"google.golang.org/protobuf/proto"
)

// The helper-as-root e2e (scripts/helper-e2e.mjs builds bcd and this test with -tags nonvml,helpere2e,
// renders the install script, and runs this as root under `unshare --mount --net`):
//
//  1. the install script's --unprivileged mode, on overlays of /etc, /usr/local and /var (and a fresh
//     /run), so nothing reaches the real host: an existing root-mode node is moved under the helper;
//  2. bcd helper started as root from what the script installed, the node's requests sent by the
//     installed bcd binary as the bcd user (bcd helper-call);
//  3. signed host units applied through the helper (a per-netns sysctl, so the real kernel's are
//     untouched), and refused: unsigned, tampered, another node's, an older generation, a root
//     not pinned, settings not the signed ones, a guarded key even when signed;
//  4. libvirt domains defined and started through the helper against a fake virsh, and refused: a
//     disk outside bcd's directories, a root-owned disk, <qemu:commandline>, a GPU the host does not
//     give, a bridge not in instance_bridges, a domain bcd did not define;
//  5. cloud-hypervisor through the helper (ch.*): real taps in the test's network namespace, made by
//     root for the node on the instance bridge and deleted by name, never an interface that is not a
//     tap; root's VMM unit (systemd-run, stubbed) built from the record it checks, refused for a
//     symlink in the instance's directory or a record the node does not own, and VFIO refused for a
//     GPU the host does not have.

const (
	nodeID    = "node_01k5w0000000000000000000e2"
	instance  = "inst_01k5w0000000000000000000ab"
	foreign   = "inst_01k5w0000000000000000000zz"
	bridge    = "bcbr0"
	keepalive = "/proc/sys/net/ipv4/tcp_keepalive_time"
	config    = "/etc/bcd/config.toml"
	bcd       = "/usr/local/bin/bcd"
)

func TestHelperAsRoot(t *testing.T) {
	scriptPath, bcdBuild, placeholder := os.Getenv("BCD_ROOTE2E_SCRIPT"), os.Getenv("BCD_ROOTE2E_BCD"), os.Getenv("BCD_ROOTE2E_PLACEHOLDER")
	if scriptPath == "" || bcdBuild == "" || placeholder == "" {
		t.Skip("run by scripts/helper-e2e.mjs")
	}
	if os.Geteuid() != 0 {
		t.Fatal("the helper e2e runs as root")
	}
	// Never on the real host: only in mount and network namespaces of its own.
	for _, ns := range []string{"mnt", "net"} {
		self, _ := os.Readlink("/proc/self/ns/" + ns)
		init, _ := os.Readlink("/proc/1/ns/" + ns)
		if self == "" || self == init {
			t.Fatalf("not in a private %s namespace: run it through scripts/helper-e2e.mjs", ns)
		}
	}
	scratch := t.TempDir()
	for _, dir := range []string{"/etc", "/usr/local", "/var"} {
		overlay(t, scratch, dir)
	}
	mount(t, "tmpfs", "/run", "tmpfs", "mode=0755")

	stubs, logs, domains := filepath.Join(scratch, "stubs"), filepath.Join(scratch, "logs"), filepath.Join(scratch, "domains")
	for _, d := range []string{stubs, logs, domains} {
		must(t, os.MkdirAll(d, 0o755))
	}
	stub(t, stubs, "curl", fmt.Sprintf(`out=; url=
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift 2 ;; --proto | --retry) shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac
done
echo "$url" >> %[1]s/curl
case "$url" in */bcd/*/linux-amd64) cp %[2]s "$out" ;; *) exit 22 ;; esac
`, quote(logs), quote(bcdBuild)))
	stub(t, stubs, "systemctl", fmt.Sprintf("echo \"$*\" >> %s/systemctl\n", quote(logs)))
	// virsh on qemu:///system: domains are files in a directory; one domain bcd did not define.
	stub(t, stubs, "virsh", fmt.Sprintf(`[ "$1" = -c ] && shift 2
echo "$*" >> %[1]s/virsh
D=%[2]s
case "$1" in
  list) for f in "$D"/*.xml; do [ -e "$f" ] && basename "$f" .xml; done ;;
  dumpxml) [ -f "$D/$2.xml" ] || { echo "error: failed to get domain '$2'" >&2; exit 1; }; cat "$D/$2.xml" ;;
  define) name=$(sed -n 's:.*<name>\(.*\)</name>.*:\1:p' "$2" | head -n 1); cp "$2" "$D/$name.xml" ;;
  start | shutdown | destroy | suspend | resume) [ -f "$D/$2.xml" ] || exit 1; echo "$1" > "$D/$2.state" ;;
  save) printf 'memory of %%s' "$2" > "$3" ;;
esac
`, quote(logs), quote(domains)))
	must(t, os.WriteFile(filepath.Join(domains, foreign+".xml"), []byte("<domain><name>"+foreign+"</name></domain>\n"), 0o644))
	// cloud-hypervisor installed (bcd helper resolves it at start; the unit is never really run) and
	// systemd-run recording the units root asks for.
	stub(t, stubs, "cloud-hypervisor", "exit 1\n")
	stub(t, stubs, "systemd-run", fmt.Sprintf("printf '%%s\\n' \"$*\" >> %s/systemd-run\n", quote(logs)))
	path := stubs + ":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

	signer := newSigner(t)
	pin := sha256.Sum256(signer.root)

	// 1. The install script, as rendered, with this run's command-signing root pinned.
	raw, err := os.ReadFile(scriptPath)
	must(t, err)
	if n := strings.Count(string(raw), placeholder); n != 1 {
		t.Fatalf("the script names the placeholder pin %d times, want 1", n)
	}
	script := filepath.Join(scratch, "install-bcd.sh")
	must(t, os.WriteFile(script, []byte(strings.Replace(string(raw), placeholder, hex.EncodeToString(pin[:]), 1)), 0o700))
	// An existing root-mode node on a VPS host with libvirt, moved under the helper by an upgrade.
	must(t, os.MkdirAll("/etc/bcd", 0o700))
	must(t, os.WriteFile(config, []byte("# e2e: a node installed before privilege separation\n"), 0o600))
	must(t, os.MkdirAll("/etc/libvirt", 0o755))
	must(t, os.WriteFile("/etc/libvirt/qemu.conf", []byte("#dynamic_ownership = 1\n"), 0o644))
	if _, err := user.Lookup("libvirt-qemu"); err != nil {
		run(t, path, "useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", "libvirt-qemu")
	}
	out := run(t, path, "sh", script)
	if !strings.Contains(out, "bcd upgraded to") {
		t.Fatalf("install script:\n%s", out)
	}
	checkInstall(t, bcdBuild, logs, hex.EncodeToString(pin[:]))
	account, err := user.Lookup("bcd")
	must(t, err)
	uid64, _ := strconv.ParseUint(account.Uid, 10, 32)
	gid64, _ := strconv.ParseUint(account.Gid, 10, 32)
	uid, gid := uint32(uid64), uint32(gid64)

	// 2. bcd helper, as root, as bcd-helper.service runs it (systemd makes its RuntimeDirectory).
	must(t, os.MkdirAll("/run/bcd-helper", 0o755))
	var helperLog lockedBuffer
	h := exec.Command(bcd, "helper", "--config", config)
	h.Env = []string{"PATH=" + path}
	h.Stdout, h.Stderr = &helperLog, &helperLog
	must(t, h.Start())
	exited := make(chan error, 1)
	go func() { exited <- h.Wait() }()
	t.Cleanup(func() {
		_ = h.Process.Kill()
		<-exited
		if t.Failed() {
			t.Logf("bcd helper log:\n%s", helperLog.String())
		}
	})
	deadline := time.Now().Add(20 * time.Second)
	for {
		if fi, err := os.Stat("/run/bcd-helper/helper.sock"); err == nil && fi.Mode()&os.ModeSocket != 0 {
			break
		}
		select {
		case err := <-exited:
			t.Fatalf("bcd helper exited: %v\n%s", err, helperLog.String())
		case <-time.After(100 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			t.Fatalf("no helper socket\n%s", helperLog.String())
		}
	}
	call := func(req helper.Request) string { return callAs(t, uid, gid, bcd, req) }

	// Only the installed binary, as the bcd user: a copy of it, or another user, is not served.
	must(t, os.MkdirAll("/run/e2e-copy", 0o755))
	copyFile(t, bcd, "/run/e2e-copy/bcd", 0o755)
	probe := helper.Request{Op: "host.unit", Unit: "sysctl"}
	if got := callAs(t, uid, gid, "/run/e2e-copy/bcd", probe); !strings.Contains(got, "not allowed") {
		t.Fatalf("a copy of bcd: %q", got)
	}
	if got := callAs(t, 65534, 65534, bcd, probe); got == "ok" {
		t.Fatal("nobody was served")
	}

	// 3. Signed host units.
	sysctl := func(v string) *agentv1.ConfigUnit {
		return &agentv1.ConfigUnit{Unit: "sysctl", ConfigJson: `{"net.ipv4.tcp_keepalive_time":` + v + `}`}
	}
	unit := func(settings string, in *helper.HostIntent) helper.Request {
		return helper.Request{Op: "host.unit", Unit: "sysctl", Settings: json.RawMessage(settings), Intent: in}
	}
	expect := func(what string, got, want string) {
		t.Helper()
		if want == "ok" && got != "ok" || want != "ok" && (got == "ok" || !strings.Contains(got, want)) {
			t.Fatalf("%s: %q, want %q", what, got, want)
		}
	}
	before := kernel(t, keepalive)
	g5 := signer.spec(t, nodeID, 5, sysctl("1234"))
	expect("unsigned", call(unit(`{"net.ipv4.tcp_keepalive_time":1234}`, nil)), "needs the signed spec")
	tampered := *g5
	tampered.Body = bytes.Clone(g5.Body)
	tampered.Body[len(tampered.Body)-3] ^= 1
	expect("tampered", call(unit(`{"net.ipv4.tcp_keepalive_time":1234}`, &tampered)), "host.unit")
	other := newSigner(t)
	expect("unpinned root", call(unit(`{"net.ipv4.tcp_keepalive_time":1234}`, other.spec(t, nodeID, 5, sysctl("1234")))), "not pinned")
	if got := kernel(t, keepalive); got != before {
		t.Fatalf("a refused request set %s to %s", keepalive, got)
	}
	expect("signed", call(unit(`{"net.ipv4.tcp_keepalive_time":1234}`, g5)), "ok")
	if got := kernel(t, keepalive); got != "1234" {
		t.Fatalf("%s = %s after the signed unit", keepalive, got)
	}
	if b, _ := os.ReadFile("/etc/sysctl.d/90-bcd.conf"); !strings.Contains(string(b), "net.ipv4.tcp_keepalive_time = 1234") {
		t.Fatalf("drop-in:\n%s", b)
	}
	if b, _ := os.ReadFile("/var/lib/bcd-hostconfig/helper-intent.json"); !strings.Contains(string(b), `"nodeId":"`+nodeID+`"`) {
		t.Fatalf("intent record: %s", b)
	}
	expect("other settings", call(unit(`{"net.ipv4.tcp_keepalive_time":999}`, g5)), "not the signed spec's")
	expect("another node", call(unit(`{"net.ipv4.tcp_keepalive_time":999}`, signer.spec(t, "node_01k5w0000000000000000000xx", 9, sysctl("999")))), "not this node")
	g7 := signer.spec(t, nodeID, 7, sysctl("2345"))
	expect("newer", call(unit(`{"net.ipv4.tcp_keepalive_time":2345}`, g7)), "ok")
	expect("older", call(unit(`{"net.ipv4.tcp_keepalive_time":1234}`, g5)), "older than one already applied")
	if got := kernel(t, keepalive); got != "2345" {
		t.Fatalf("%s = %s, want the newest signed value", keepalive, got)
	}
	// Signed is not enough for what the unit guards: a core_pattern pipe runs a program as root.
	core := kernel(t, "/proc/sys/kernel/core_pattern")
	g8 := signer.spec(t, nodeID, 8, &agentv1.ConfigUnit{Unit: "sysctl", ConfigJson: `{"kernel.core_pattern":"|/tmp/x"}`})
	expect("guarded key", call(unit(`{"kernel.core_pattern":"|/tmp/x"}`, g8)), "refused")
	if got := kernel(t, "/proc/sys/kernel/core_pattern"); got != core {
		t.Fatalf("core_pattern = %q", got)
	}

	// 4. libvirt through the helper, against the fake virsh.
	for _, d := range []string{"/var/lib/bcd/volumes", "/var/lib/bcd/libvirt/instances/" + instance} {
		must(t, os.MkdirAll(d, 0o700))
	}
	for _, d := range []string{"/var/lib/bcd/volumes", "/var/lib/bcd/libvirt", "/var/lib/bcd/libvirt/instances", "/var/lib/bcd/libvirt/instances/" + instance} {
		must(t, os.Chown(d, int(uid), int(gid)))
	}
	disk := "/var/lib/bcd/volumes/vol_01k5w0000000000000000000cd.raw"
	must(t, os.WriteFile(disk, make([]byte, 4096), 0o600))
	must(t, os.Chown(disk, int(uid), int(gid)))
	rootDisk := "/var/lib/bcd/volumes/vol_01k5w0000000000000000000ee.raw"
	must(t, os.WriteFile(rootDisk, make([]byte, 4096), 0o600))
	good := domainXML(instance, disk)
	libvirt := func(verb string, req helper.LibvirtRequest) string {
		return call(helper.Request{Op: "libvirt." + verb, Libvirt: &req})
	}
	refusals := map[string][2]string{
		"a disk outside bcd's directories": {strings.Replace(good, disk, "/etc/shadow", 1), "outside bcd's instance directories"},
		"a disk root owns":                 {strings.Replace(good, disk, rootDisk, 1), "not the node's"},
		"qemu:commandline": {strings.Replace(good, "</devices>", `</devices><qemu:commandline xmlns:qemu="http://libvirt.org/schemas/domain/qemu/1.0"><qemu:arg value="-foo"></qemu:arg></qemu:commandline>`, 1),
			"refused"},
		"a GPU not the host's": {strings.Replace(good, "<serial", `<hostdev mode="subsystem" type="pci" managed="yes"><source><address domain="0x0000" bus="0x3b" slot="0x00" function="0x0"></address></source></hostdev><serial`, 1),
			"not one of this host's GPUs"},
		"another bridge":   {strings.Replace(good, `bridge="`+bridge+`"`, `bridge="br0"`, 1), "not an instance network"},
		"a foreign domain": {domainXML(foreign, disk), "not bcd's"},
	}
	for what, c := range refusals {
		expect(what, libvirt("define", helper.LibvirtRequest{XML: []byte(c[0])}), c[1])
	}
	if _, err := os.Stat(filepath.Join(domains, instance+".xml")); err == nil {
		t.Fatal("a refused definition reached virsh")
	}
	expect("define", libvirt("define", helper.LibvirtRequest{XML: []byte(good)}), "ok")
	if b, _ := os.ReadFile(filepath.Join(domains, instance+".xml")); string(b) != good {
		t.Fatalf("virsh defined:\n%s", b)
	}
	expect("start", libvirt("start", helper.LibvirtRequest{Domain: instance}), "ok")
	if b, _ := os.ReadFile(filepath.Join(domains, instance+".state")); strings.TrimSpace(string(b)) != "start" {
		t.Fatalf("domain state %q", b)
	}
	expect("start a foreign domain", libvirt("start", helper.LibvirtRequest{Domain: foreign}), "not bcd's")
	expect("destroy a non-instance", libvirt("destroy", helper.LibvirtRequest{Domain: "legacy-vm"}), "not an instance id")
	// save: root writes into its own staging, then hands the file to the node, owned by it.
	state := "/var/lib/bcd/libvirt/instances/" + instance + "/memory.state"
	expect("save", libvirt("save", helper.LibvirtRequest{Domain: instance, File: state}), "ok")
	if fi, err := os.Stat(state); err != nil || fi.Sys().(*syscall.Stat_t).Uid != uid {
		t.Fatalf("saved state: %v", err)
	}
	// restore: only under a definition the helper checked, never the one the node's state file embeds.
	expect("restore without a definition", libvirt("restore", helper.LibvirtRequest{Domain: instance, File: state}), "needs the domain's definition")
	expect("restore", libvirt("restore", helper.LibvirtRequest{Domain: instance, File: state, XML: []byte(good)}), "ok")
	virshLog, _ := os.ReadFile(filepath.Join(logs, "virsh"))
	if strings.Contains(string(virshLog), "restore "+state+"\n") {
		t.Fatalf("virsh restored without --xml:\n%s", virshLog)
	}
	for _, want := range []string{"define /var/lib/bcd-hostconfig/libvirt/domain-", "start " + instance, "save " + instance + " /var/lib/bcd-hostconfig/libvirt/",
		"restore " + state + " --xml /var/lib/bcd-hostconfig/libvirt/domain-"} {
		if !strings.Contains(string(virshLog), want) {
			t.Fatalf("virsh calls lack %q:\n%s", want, virshLog)
		}
	}
	if left, _ := filepath.Glob("/var/lib/bcd-hostconfig/libvirt/*"); len(left) != 0 {
		t.Fatalf("staging left behind: %v", left)
	}
	// Every refusal and operation is in the helper's log.
	if log := helperLog.String(); !strings.Contains(log, `"op":"libvirt.define"`) || !strings.Contains(log, `"op":"host.unit"`) ||
		!strings.Contains(log, "the peer does not run an installed bcd binary") {
		t.Fatalf("helper log lacks the operations:\n%s", log)
	}

	cloudHypervisor(t, path, logs, uid, gid, call, expect, helperLog.String)
}

// cloudHypervisor is step 5: ch.* through bcd helper, with real taps in the test's network namespace.
func cloudHypervisor(t *testing.T, path, logs string, uid, gid uint32, call func(helper.Request) string,
	expect func(what, got, want string), helperLog func() string) {
	t.Helper()
	if _, err := os.Stat("/dev/net/tun"); err != nil {
		t.Logf("no /dev/net/tun: cloud-hypervisor through the helper not tested (%v)", err)
		return
	}
	// sysfs as this network namespace sees it (root reads /sys/class/net to tell taps from anything else).
	mount(t, "sysfs", "/sys", "sysfs", "")
	run(t, path, "ip", "link", "add", bridge, "type", "bridge")
	ch := func(verb string, req helper.CHRequest) string {
		return call(helper.Request{Op: "ch." + verb, CH: &req})
	}
	const (
		dir     = "/var/lib/bcd/cloud-hypervisor"
		vmmUser = 0x7FFD0000 + 5 // in bcd's VMM range
		gpuVM   = "inst_01k5w0000000000000000000gp"
	)
	record := func(id, recordID string, owner uint32, gpus string) {
		t.Helper()
		inst := filepath.Join(dir, "instances", id)
		must(t, os.MkdirAll(inst, 0o700))
		for _, d := range []string{dir, filepath.Join(dir, "instances"), inst} {
			must(t, os.Chown(d, int(uid), int(gid)))
		}
		file := filepath.Join(inst, "vm.json")
		must(t, os.WriteFile(file, []byte(fmt.Sprintf(
			`{"id":%q,"managed":"better-compute/cloud-hypervisor/1","uid":%d,"vcpu":1,"memoryBytes":1073741824,"networks":[%q],"gpus":[%s],"config":null}`,
			recordID, vmmUser, bridge, gpus)), 0o600))
		must(t, os.Chown(file, int(owner), int(owner)))
	}
	record(instance, instance, uid, "")

	// Taps: made by root, owned by the node, on the instance bridge; nothing else.
	tap := runtime.TapName(instance, 0)
	expect("a tap off the instance bridges", ch("taps", helper.CHRequest{Instance: instance, Networks: []string{"br0"}}), "not an instance bridge")
	expect("taps", ch("taps", helper.CHRequest{Instance: instance, Networks: []string{bridge}}), "ok")
	if _, err := os.Stat("/sys/class/net/" + tap + "/tun_flags"); err != nil {
		t.Fatalf("no tap %s: %v", tap, err)
	}
	if owner := kernel(t, "/sys/class/net/"+tap+"/owner"); owner != strconv.FormatUint(uint64(uid), 10) {
		t.Fatalf("tap %s is uid %s's, not the node's (%d)", tap, owner, uid)
	}
	if master, err := os.Readlink("/sys/class/net/" + tap + "/master"); err != nil || filepath.Base(master) != bridge {
		t.Fatalf("tap %s is on %q (%v), not %s", tap, master, err, bridge)
	}
	// An interface of an instance's tap name that is not a tap is never deleted.
	impostor := runtime.TapName(foreign, 0)
	run(t, path, "ip", "link", "add", impostor, "type", "dummy")
	expect("untaps of a non-tap", ch("untaps", helper.CHRequest{Instance: foreign, NICs: 1}), "not a tap")
	if _, err := os.Stat("/sys/class/net/" + impostor); err != nil {
		t.Fatalf("the non-tap %s was deleted", impostor)
	}
	expect("a path as an instance", ch("taps", helper.CHRequest{Instance: "../../etc", Networks: []string{bridge}}), "an instance id")

	// The VMM unit: root's, from the record root checked, never one the node wrote.
	expect("launch", ch("launch", helper.CHRequest{Instance: instance}), "ok")
	units, _ := os.ReadFile(filepath.Join(logs, "systemd-run"))
	for _, want := range []string{"--unit=bcd-ch-" + instance + ".service", "User=" + strconv.Itoa(vmmUser), "UMask=0007",
		"-- " + filepath.Join(strings.SplitN(path, ":", 2)[0], "cloud-hypervisor") + " --api-socket path=" + filepath.Join(dir, "instances", instance, "api.sock")} {
		if !strings.Contains(string(units), want) {
			t.Fatalf("root's unit lacks %q:\n%s", want, units)
		}
	}
	must(t, os.Symlink("/etc/shadow", filepath.Join(dir, "instances", instance, "seed.iso")))
	expect("launch with a symlink", ch("launch", helper.CHRequest{Instance: instance}), "symlink")
	must(t, os.Remove(filepath.Join(dir, "instances", instance, "seed.iso")))
	record(foreign, foreign, 0, "")
	expect("launch of a record root owns", ch("launch", helper.CHRequest{Instance: foreign}), "not the node's")
	record(foreign, instance, uid, "")
	expect("launch of another instance's record", ch("launch", helper.CHRequest{Instance: foreign}), "not bcd's")
	if units, _ := os.ReadFile(filepath.Join(logs, "systemd-run")); strings.Count(string(units), "\n") != 1 {
		t.Fatalf("refused launches reached systemd-run:\n%s", units)
	}

	// VFIO: only this host's GPUs (none here).
	record(gpuVM, gpuVM, uid, `"GPU-e2e"`)
	expect("vfio of a GPU the host lacks", ch("vfio", helper.CHRequest{Instance: gpuVM}), "not one of this host's")
	expect("unvfio of an address not the host's", ch("unvfio", helper.CHRequest{Instance: gpuVM, Addrs: []string{"0000:3b:00.0"}}), "not one of this host's GPUs")

	// Stop, then the taps go by name.
	expect("stop", ch("stop", helper.CHRequest{Instance: instance}), "ok")
	if calls, _ := os.ReadFile(filepath.Join(logs, "systemctl")); !strings.Contains(string(calls), "stop bcd-ch-"+instance+".service") {
		t.Fatalf("systemctl calls lack the stop:\n%s", calls)
	}
	expect("untaps", ch("untaps", helper.CHRequest{Instance: instance, NICs: 1}), "ok")
	if _, err := os.Stat("/sys/class/net/" + tap); err == nil {
		t.Fatalf("tap %s is still there", tap)
	}
	if log := helperLog(); !strings.Contains(log, `"op":"ch.launch"`) || !strings.Contains(log, `"instance":"`+instance+`"`) {
		t.Fatalf("helper log lacks the ch.* operations:\n%s", log)
	}
}

// checkInstall checks what the install script's --unprivileged mode left.
func checkInstall(t *testing.T, bcdBuild, logs, pinHex string) {
	t.Helper()
	want, got := digest(t, bcdBuild), digest(t, bcd)
	if want != got {
		t.Fatal("the installed bcd is not the build")
	}
	cfg, err := os.ReadFile(config)
	must(t, err)
	for _, line := range []string{`command_root_sha256 = "` + pinHex + `"`, "[helper]", `socket = "/run/bcd-helper/helper.sock"`, `user = "bcd"`, `instance_bridges = "` + bridge + `"`} {
		if !strings.Contains(string(cfg), line) {
			t.Fatalf("config.toml lacks %q:\n%s", line, cfg)
		}
	}
	account, err := user.Lookup("bcd")
	must(t, err)
	gid, _ := strconv.Atoi(account.Gid)
	for file, mode := range map[string]os.FileMode{"/etc/bcd": 0o750, config: 0o640} {
		fi, err := os.Stat(file)
		must(t, err)
		st := fi.Sys().(*syscall.Stat_t)
		if fi.Mode().Perm() != mode || st.Uid != 0 || int(st.Gid) != gid {
			t.Fatalf("%s is %v %d:%d, want %v root:bcd", file, fi.Mode().Perm(), st.Uid, st.Gid, mode)
		}
	}
	dropIn, err := os.ReadFile("/etc/systemd/system/bcd.service.d/unprivileged.conf")
	must(t, err)
	if !strings.Contains(string(dropIn), "User=bcd") || strings.Contains(string(dropIn), "libvirt") {
		t.Fatalf("unprivileged.conf:\n%s", dropIn)
	}
	if _, err := os.Stat("/etc/systemd/system/bcd-helper.service"); err != nil {
		t.Fatal(err)
	}
	qemu, _ := os.ReadFile("/etc/libvirt/qemu.conf")
	if strings.TrimSpace(string(qemu)) != "dynamic_ownership = 0" {
		t.Fatalf("qemu.conf:\n%s", qemu)
	}
	group, _ := os.ReadFile("/etc/group")
	member := false
	for _, line := range strings.Split(string(group), "\n") {
		if f := strings.Split(line, ":"); len(f) == 4 && f[0] == "bcd" {
			for _, m := range strings.Split(f[3], ",") {
				member = member || m == "libvirt-qemu"
			}
		}
	}
	if !member {
		t.Fatal("libvirt-qemu is not in the bcd group")
	}
	systemctl, _ := os.ReadFile(filepath.Join(logs, "systemctl"))
	for _, want := range []string{"daemon-reload", "enable bcd-helper.service", "restart bcd-helper.service", "restart bcd.service"} {
		if !strings.Contains(string(systemctl), want) {
			t.Fatalf("systemctl calls lack %q:\n%s", want, systemctl)
		}
	}
}

func domainXML(name, disk string) string {
	return `<domain type="kvm">
  <name>` + name + `</name>
  <metadata><bc:instance xmlns:bc="https://better-compute.dev/libvirt/1" id="` + name + `"></bc:instance></metadata>
  <memory unit="KiB">1048576</memory>
  <vcpu placement="static">1</vcpu>
  <os><type>hvm</type><boot dev="hd"></boot></os>
  <devices>
    <disk type="file" device="disk"><driver name="qemu" type="raw"></driver><source file="` + disk + `"></source><target dev="vda" bus="virtio"></target></disk>
    <interface type="bridge"><mac address="52:54:00:12:34:56"></mac><source bridge="` + bridge + `"></source><target dev="` + runtime.TapName(name, 0) + `"></target><model type="virtio"></model></interface>
    <serial type="pty"></serial>
    <console type="pty"></console>
  </devices>
</domain>
`
}

// signer is a command-signing root and a worker certificate under it (as the control plane's).
type signer struct {
	root []byte
	sign func(body []byte) []byte
}

func newSigner(t *testing.T) signer {
	t.Helper()
	rootKey, err := pki.GenerateKey()
	must(t, err)
	now := time.Now()
	rootTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "e2e command-signing root"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	root, err := x509.CreateCertificate(rand.Reader, rootTmpl, rootTmpl, &rootKey.PublicKey, rootKey)
	must(t, err)
	rootCert, _ := x509.ParseCertificate(root)
	key, err := pki.GenerateKey()
	must(t, err)
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "worker", OrganizationalUnit: []string{pki.RolePrefix + "worker"}},
		NotBefore:    now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature,
	}
	leaf, err := x509.CreateCertificate(rand.Reader, leafTmpl, rootCert, &key.PublicKey, rootKey)
	must(t, err)
	return signer{root: root, sign: func(body []byte) []byte {
		sig, err := pki.SignP1363(key, pki.SigningInput(pki.PurposeDesiredState, body))
		must(t, err)
		raw, _ := proto.Marshal(&commonv1.Signature{Kid: "worker", Sig: sig, Chain: [][]byte{leaf}})
		return raw
	}}
}

// spec is a signed full NodeSpec whose host section holds units.
func (s signer) spec(t *testing.T, node string, generation uint64, units ...*agentv1.ConfigUnit) *helper.HostIntent {
	t.Helper()
	body, err := proto.Marshal(&agentv1.DesiredStateBody{
		NodeId: node, Generation: generation,
		Spec: &agentv1.DesiredStateBody_Full{Full: &agentv1.NodeSpec{Host: &agentv1.HostSection{Units: units}}},
	})
	must(t, err)
	return &helper.HostIntent{Body: body, Signature: s.sign(body), Roots: [][]byte{s.root}}
}

// callAs sends one helper request through `<binary> helper-call` as uid:gid; "ok" or the error.
func callAs(t *testing.T, uid, gid uint32, binary string, req helper.Request) string {
	t.Helper()
	raw, err := json.Marshal(req)
	must(t, err)
	cmd := exec.Command(binary, "helper-call", "--config", config)
	cmd.Stdin = bytes.NewReader(raw)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=/"}
	cmd.Dir = "/"
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid, Groups: []uint32{}}}
	out, _ := cmd.CombinedOutput()
	return strings.TrimSpace(string(out))
}

func overlay(t *testing.T, scratch, dir string) {
	t.Helper()
	name := strings.ReplaceAll(strings.Trim(dir, "/"), "/", "_")
	up, work := filepath.Join(scratch, "up", name), filepath.Join(scratch, "work", name)
	for _, d := range []string{up, work} {
		must(t, os.MkdirAll(d, 0o755))
	}
	// The merged directory takes the upper one's attributes: the lower one's, as root's helper checks.
	fi, err := os.Stat(dir)
	must(t, err)
	must(t, os.Chmod(up, fi.Mode().Perm()))
	mount(t, "overlay", dir, "overlay", "lowerdir="+dir+",upperdir="+up+",workdir="+work)
}

func mount(t *testing.T, source, target, fstype, data string) {
	t.Helper()
	if err := syscall.Mount(source, target, fstype, 0, data); err != nil {
		t.Fatalf("mount %s on %s: %v", fstype, target, err)
	}
	t.Cleanup(func() { _ = syscall.Unmount(target, syscall.MNT_DETACH) })
}

func stub(t *testing.T, dir, name, body string) {
	t.Helper()
	must(t, os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body), 0o755))
}

func run(t *testing.T, path string, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Env = []string{"PATH=" + path, "HOME=/root"}
	cmd.Dir = "/"
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v: %v\n%s", name, args, err, out)
	}
	return string(out)
}

func kernel(t *testing.T, file string) string {
	t.Helper()
	b, err := os.ReadFile(file)
	must(t, err)
	return strings.TrimSpace(string(b))
}

func digest(t *testing.T, file string) string {
	t.Helper()
	b, err := os.ReadFile(file)
	must(t, err)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func copyFile(t *testing.T, from, to string, mode os.FileMode) {
	t.Helper()
	src, err := os.Open(from)
	must(t, err)
	defer src.Close()
	dst, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	must(t, err)
	_, err = io.Copy(dst, src)
	must(t, err)
	must(t, dst.Close())
}

func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// lockedBuffer collects the helper's output from its goroutines.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}
