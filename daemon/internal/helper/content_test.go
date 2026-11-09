package helper

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testCAKey is an OpenSSH public key line of the given type whose blob names that type.
func testCAKey(typ string) string {
	blob := binary.BigEndian.AppendUint32(nil, uint32(len(typ)))
	blob = append(blob, typ...)
	blob = append(blob, bytes.Repeat([]byte{7}, 36)...)
	return typ + " " + base64.StdEncoding.EncodeToString(blob) + " break-glass CA"
}

// testKRL is a KRL as the access converger builds it: the header, then one certificates section
// per CA blob revoking serials.
func testKRL(caBlobs [][]byte, serials ...uint64) []byte {
	var b bytes.Buffer
	str := func(w *bytes.Buffer, s []byte) {
		_ = binary.Write(w, binary.BigEndian, uint32(len(s)))
		w.Write(s)
	}
	_ = binary.Write(&b, binary.BigEndian, uint64(0x5353484b524c0a00))
	_ = binary.Write(&b, binary.BigEndian, uint32(1))
	_ = binary.Write(&b, binary.BigEndian, uint64(42)) // krl_version
	_ = binary.Write(&b, binary.BigEndian, uint64(0))
	_ = binary.Write(&b, binary.BigEndian, uint64(0))
	str(&b, nil)
	str(&b, []byte("better-compute"))
	if len(serials) == 0 {
		return b.Bytes()
	}
	var list bytes.Buffer
	for _, s := range serials {
		_ = binary.Write(&list, binary.BigEndian, s)
	}
	for _, ca := range caBlobs {
		var section bytes.Buffer
		str(&section, ca)
		str(&section, nil)
		section.WriteByte(0x20)
		str(&section, list.Bytes())
		b.WriteByte(1)
		str(&b, section.Bytes())
	}
	return b.Bytes()
}

// legitFiles are files as bcd node writes them, by path.
func legitFiles() map[string][]byte {
	ca := testCAKey("ssh-ed25519")
	blob, _ := sshKeyBlob(ca)
	return map[string][]byte{
		"/run/bcd/allocations/alloc_1.env":              []byte("BCD_ALLOCATION_ID=alloc_1\nBCD_RESERVATION_ID=res_1\nNVIDIA_VISIBLE_DEVICES=GPU-1,GPU-2\nFOO=a b=c\n"),
		"/etc/ssh/sshd_config.d/10-better-compute.conf": SSHDropIn,
		"/etc/ssh/bc_ca.pub":                            []byte(ca + "\n" + testCAKey("ecdsa-sha2-nistp256") + "\n"),
		"/etc/ssh/bc_krl":                               testKRL([][]byte{blob}, 7, 9),
		"/etc/ssh/bc_principals/root":                   []byte("root@node_1\n"),
	}
}

func TestFileContentIsCheckedPerKind(t *testing.T) {
	root := t.TempDir()
	// Root's own NVIDIA spec: what a hold may copy from.
	vendor := `{"cdiVersion":"0.7.0","kind":"nvidia.com/gpu",
		"containerEdits":{"env":["NVIDIA_CTK_LIBCUDA_DIR=/usr/lib/x86_64-linux-gnu"],
			"hooks":[{"hookName":"createContainer","path":"/usr/bin/nvidia-cdi-hook","args":["nvidia-cdi-hook","update-ldcache"]}],
			"mounts":[{"hostPath":"/usr/bin/nvidia-smi","containerPath":"/usr/bin/nvidia-smi","options":["ro","bind"]}]},
		"devices":[{"name":"GPU-1","containerEdits":{"deviceNodes":[{"path":"/dev/nvidia0"}],"additionalGids":[44]}}]}`
	if err := os.MkdirAll(filepath.Join(root, "etc/cdi"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc/cdi/nvidia.json"), []byte(vendor), 0o644); err != nil {
		t.Fatal(err)
	}
	// A hold's own earlier spec is never a source of edits, whatever it holds.
	planted := `{"cdiVersion":"0.7.0","kind":"nvidia.com/gpu","containerEdits":{"hooks":[{"hookName":"createRuntime","path":"/tmp/x"}]}}`
	if err := os.WriteFile(filepath.Join(root, "etc/cdi/bcd-planted.json"), []byte(planted), 0o644); err != nil {
		t.Fatal(err)
	}
	c := ContentContext{Root: root, NodeID: "node_1"}
	hold := func(edits, deviceEdits string) []byte {
		return []byte(`{"cdiVersion":"0.7.0","kind":"bcd.dev/gpu","annotations":{"bcd.dev/allocation-id":"alloc_1","bcd.dev/reservation-id":"res_1","bcd.dev/generation":"3"},` +
			`"devices":[{"name":"GPU-1","annotations":{"bcd.dev/device-id":"GPU-1"},"containerEdits":{"env":null` + deviceEdits + `}}],` +
			`"containerEdits":{"env":["BCD_ALLOCATION_ID=alloc_1","NVIDIA_VISIBLE_DEVICES=GPU-1","NVIDIA_CTK_LIBCUDA_DIR=/usr/lib/x86_64-linux-gnu"]` + edits + `}}`)
	}
	vendorHook := `,"hooks":[{"hookName":"createContainer","path":"/usr/bin/nvidia-cdi-hook","args":["nvidia-cdi-hook","update-ldcache"]}]`
	vendorMount := `,"mounts":[{"hostPath":"/usr/bin/nvidia-smi","containerPath":"/usr/bin/nvidia-smi","options":["ro","bind"]}]`
	vendorDevice := `,"deviceNodes":[{"path":"/dev/nvidia0"}],"additionalGids":[44]`
	ca := testCAKey("ssh-ed25519")
	blob, _ := sshKeyBlob(ca)

	// What bcd node writes passes.
	for p, content := range legitFiles() {
		kind, name, ok := Classify(p)
		if !ok {
			t.Fatalf("%s does not classify", p)
		}
		if err := CheckContent(kind, name, content, c); err != nil {
			t.Errorf("%s: %v", p, err)
		}
	}
	for what, legit := range map[string]struct {
		kind, name string
		data       []byte
	}{
		"a hold without vendor edits":     {"cdi", "alloc_1", hold("", "")},
		"a hold with root's NVIDIA edits": {"cdi", "alloc_1", hold(vendorHook+vendorMount, vendorDevice)},
		"an empty KRL":                    {"ssh-krl", "", testKRL(nil)},
		"a bootstrap token":               {"k8s-token", "", []byte("abcdef.0123456789abcdef\n")},
	} {
		if err := CheckContent(legit.kind, legit.name, legit.data, c); err != nil {
			t.Errorf("%s: %v", what, err)
		}
	}

	// What a compromised node would write does not.
	for what, bad := range map[string]struct {
		kind, name string
		data       []byte
		want       string
	}{
		"an sshd drop-in with another directive":      {"ssh-dropin", "", append(append([]byte(nil), SSHDropIn...), "AuthorizedKeysCommand /tmp/x\n"...), "three directives"},
		"an sshd drop-in that permits root passwords": {"ssh-dropin", "", []byte("PermitRootLogin yes\nPasswordAuthentication yes\n"), "three directives"},
		"a CA file with options":                      {"ssh-ca", "", []byte(`command="/bin/sh" ` + ca + "\n"), "OpenSSH public key"},
		"a CA file that is not keys":                  {"ssh-ca", "", []byte("Include /tmp/x\n"), "OpenSSH public key"},
		"a CA key whose blob is another type":         {"ssh-ca", "", []byte(strings.Replace(ca, "ssh-ed25519 ", "ssh-rsa ", 1) + "\n"), "type"},
		"a CA file without a final line break":        {"ssh-ca", "", []byte(ca), "line break"},
		"a principal of another account":              {"ssh-principals", "ubuntu", []byte("root@node_1\n"), "principal of account ubuntu"},
		"a principal of another node":                 {"ssh-principals", "root", []byte("root@node_2\n"), "not this node"},
		"a principals line with options":              {"ssh-principals", "root", []byte(`command="/bin/sh" root@node_1` + "\n"), "principal of account root"},
		"a bare principal":                            {"ssh-principals", "root", []byte("root\n"), "principal of account root"},
		"a KRL that is text":                          {"ssh-krl", "", []byte("ssh-ed25519 AAAA\n"), "revocation list"},
		"a KRL with trailing bytes":                   {"ssh-krl", "", append(testKRL([][]byte{blob}, 7), 1, 2, 3), "revocation list"},
		"a KRL section of another type":               {"ssh-krl", "", append(testKRL(nil), 2, 0, 0, 0, 0), "revocation list"},
		"an env file for another allocation":          {"allocation-env", "alloc_1", []byte("BCD_ALLOCATION_ID=alloc_2\n"), "first line"},
		"an env file with a non-assignment":           {"allocation-env", "alloc_1", []byte("BCD_ALLOCATION_ID=alloc_1\nexport X; rm -rf /\n"), "KEY=VALUE"},
		"an env file with a carriage return":          {"allocation-env", "alloc_1", []byte("BCD_ALLOCATION_ID=alloc_1\nA=b\rC=d\n"), "control character"},
		"a token file with a second line":             {"k8s-token", "", []byte("abcdef.0123456789abcdef\nx\n"), "bootstrap token"},
		"a CDI spec of another kind":                  {"cdi", "alloc_1", bytes.Replace(hold("", ""), []byte("bcd.dev/gpu"), []byte("nvidia.com/gpu"), 1), "bcd.dev/gpu"},
		"a CDI spec for another allocation":           {"cdi", "alloc_2", hold("", ""), "allocation alloc_2"},
		"a CDI hook of the node's":                    {"cdi", "alloc_1", hold(`,"hooks":[{"hookName":"createRuntime","path":"/bin/sh","args":["sh","-c","id > /tmp/pwned"]}]`, ""), "hook is not in root's NVIDIA CDI spec"},
		"a vendor hook with other arguments":          {"cdi", "alloc_1", hold(strings.Replace(vendorHook, "update-ldcache", "chmod", 1), ""), "hook is not in root's NVIDIA CDI spec"},
		"a hook copied from a planted bcd- spec":      {"cdi", "alloc_1", hold(`,"hooks":[{"hookName":"createRuntime","path":"/tmp/x"}]`, ""), "hook is not in root's NVIDIA CDI spec"},
		"a mount of the host's root":                  {"cdi", "alloc_1", hold(`,"mounts":[{"hostPath":"/","containerPath":"/host","options":["rw","bind"]}]`, ""), "mount is not in root's NVIDIA CDI spec"},
		"a device node of the node's":                 {"cdi", "alloc_1", hold("", `,"deviceNodes":[{"path":"/dev/sda"}]`), "device node is not in root's NVIDIA CDI spec"},
		"an env of the node's":                        {"cdi", "alloc_1", bytes.Replace(hold("", ""), []byte("NVIDIA_CTK_LIBCUDA_DIR=/usr/lib/x86_64-linux-gnu"), []byte("LD_PRELOAD=/tmp/x.so"), 1), "env"},
		"a CDI field bcd does not write":              {"cdi", "alloc_1", bytes.Replace(hold("", ""), []byte(`"devices":`), []byte(`"intelRdt":{},"devices":`), 1), "unknown field"},
		"an annotation bcd does not write":            {"cdi", "alloc_1", bytes.Replace(hold("", ""), []byte(`"bcd.dev/generation":"3"`), []byte(`"io.kubernetes.cri.x":"3"`), 1), "annotation"},
	} {
		err := CheckContent(bad.kind, bad.name, bad.data, c)
		if err == nil || !strings.Contains(err.Error(), bad.want) {
			t.Errorf("%s = %v, want %q", what, err, bad.want)
		}
	}
}
