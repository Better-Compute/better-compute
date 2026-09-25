package agent

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
)

// fakeCAKey is an ssh-ed25519 public key line (the key bytes need not be a real point for sshd files).
func fakeCAKey() string {
	var blob bytes.Buffer
	for _, s := range [][]byte{[]byte("ssh-ed25519"), bytes.Repeat([]byte{7}, 32)} {
		_ = binary.Write(&blob, binary.BigEndian, uint32(len(s)))
		blob.Write(s)
	}
	return "ssh-ed25519 " + base64.StdEncoding.EncodeToString(blob.Bytes()) + " compute-ca"
}

func TestAccessWritesSshdFilesAndRemovesThem(t *testing.T) {
	h := newHarness(t, nil)
	s, _ := h.open()
	ca := fakeCAKey()
	spec := &agentv1.NodeSpec{Access: &agentv1.AccessSection{
		SshCaPublicKeys:   []string{ca},
		SshPrincipals:     []string{"root@" + testNode, "ops@" + testNode, "root@node_other", "../etc@" + testNode},
		SshRevokedSerials: []uint64{9, 3},
	}}
	s.push(desired(1, spec))
	status := s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil }).GetStatus()
	for _, sec := range status.GetSections() {
		if sec.GetSection() == "access" && sec.GetState() != agentv1.SectionState_SECTION_STATE_CONVERGED {
			t.Fatalf("access = %v", sec)
		}
	}
	read := func(p string) string {
		b, err := os.ReadFile(h.host.Path(p))
		if err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		return string(b)
	}
	if !strings.Contains(read(sshDropIn), "TrustedUserCAKeys /etc/ssh/bc_ca.pub") || read(sshCAFile) != ca+"\n" {
		t.Fatal("drop-in or CA file")
	}
	if read(sshPrincipalsDir+"/root") != "root@"+testNode+"\n" || read(sshPrincipalsDir+"/ops") != "ops@"+testNode+"\n" {
		t.Fatal("principals")
	}
	if entries, _ := os.ReadDir(h.host.Path(sshPrincipalsDir)); len(entries) != 2 {
		t.Fatalf("principal files: %d (another node's or a path principal leaked)", len(entries))
	}
	krl := []byte(read(sshKRLFile))
	if !bytes.HasPrefix(krl, []byte("SSHKRL\n\x00")) || !bytes.HasSuffix(krl, []byte{0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 9}) {
		t.Fatalf("krl = %x", krl)
	}
	if h.host.sshReloads != 1 {
		t.Fatalf("sshd reloads = %d", h.host.sshReloads)
	}
	// An unchanged access section at the next generation touches nothing but the KRL version.
	s.push(desired(2, spec))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil })
	if h.host.sshReloads != 1 {
		t.Fatalf("sshd reloaded again: %d", h.host.sshReloads)
	}
	// No access section: the node stops trusting the CA.
	s.push(desired(3, &agentv1.NodeSpec{}))
	s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil })
	for _, p := range []string{sshDropIn, sshCAFile, sshKRLFile, sshPrincipalsDir + "/root"} {
		if _, err := os.Stat(h.host.Path(p)); !os.IsNotExist(err) {
			t.Fatalf("%s still exists", p)
		}
	}
	if h.host.sshReloads != 2 {
		t.Fatalf("sshd reloads = %d", h.host.sshReloads)
	}
}

// The KRL is read by OpenSSH itself: a certificate whose serial is listed is REVOKED, another is not.
func TestKRLWithSshKeygen(t *testing.T) {
	keygen, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("ssh-keygen is not installed")
	}
	dir := t.TempDir()
	run := func(args ...string) ([]byte, error) { return exec.Command(keygen, args...).CombinedOutput() }
	if out, err := run("-q", "-t", "ed25519", "-N", "", "-f", filepath.Join(dir, "ca")); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if out, err := run("-q", "-t", "ed25519", "-N", "", "-f", filepath.Join(dir, "user")); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	for _, serial := range []string{"3", "4"} {
		if err := os.Rename(filepath.Join(dir, "user.pub"), filepath.Join(dir, "user"+serial+".pub")); err != nil && serial == "3" {
			t.Fatal(err)
		}
		if serial == "4" {
			_ = copyFile(filepath.Join(dir, "user3.pub"), filepath.Join(dir, "user4.pub"))
		}
		if out, err := run("-s", filepath.Join(dir, "ca"), "-I", "bc:test", "-n", "root@"+testNode, "-z", serial, filepath.Join(dir, "user"+serial+".pub")); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	caPub, _ := os.ReadFile(filepath.Join(dir, "ca.pub"))
	krl, err := buildKRL([]string{strings.TrimSpace(string(caPub))}, []uint64{3, 10}, 7)
	if err != nil {
		t.Fatal(err)
	}
	krlPath := filepath.Join(dir, "krl")
	if err := os.WriteFile(krlPath, krl, 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := run("-Q", "-f", krlPath, filepath.Join(dir, "user3-cert.pub")); err == nil || !strings.Contains(string(out), "REVOKED") {
		t.Fatalf("serial 3 not revoked: %v %s", err, out)
	}
	if out, err := run("-Q", "-f", krlPath, filepath.Join(dir, "user4-cert.pub")); err != nil {
		t.Fatalf("serial 4 revoked: %v %s", err, out)
	}
	empty, _ := buildKRL([]string{strings.TrimSpace(string(caPub))}, nil, 8)
	_ = os.WriteFile(krlPath, empty, 0o644)
	if out, err := run("-Q", "-f", krlPath, filepath.Join(dir, "user3-cert.pub")); err != nil {
		t.Fatalf("an empty KRL revoked: %v %s", err, out)
	}
}

func copyFile(from, to string) error {
	b, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	return os.WriteFile(to, b, 0o644)
}

// A CA key or principal that would add a line to sshd's files refuses the whole spec.
func TestAccessRefusesLineInjection(t *testing.T) {
	h := newHarness(t, nil)
	s, _ := h.open()
	ca := fakeCAKey()
	for i, access := range []*agentv1.AccessSection{
		{SshCaPublicKeys: []string{ca + "\n" + fakeCAKey()}},
		{SshCaPublicKeys: []string{ca + "\r"}},
		{SshCaPublicKeys: []string{"not a key"}},
		{SshCaPublicKeys: []string{ca}, SshPrincipals: []string{"root@" + testNode + "\nroot"}},
		{SshCaPublicKeys: []string{ca}, SshPrincipals: []string{"root @" + testNode}},
	} {
		s.push(desired(uint64(i+1), &agentv1.NodeSpec{Access: access}))
	}
	s.push(desired(10, &agentv1.NodeSpec{Access: &agentv1.AccessSection{SshCaPublicKeys: []string{ca}}}))
	status := s.next(t, "status", func(f *agentv1.AgentFrame) bool { return f.GetStatus() != nil }).GetStatus()
	if status.GetAppliedGeneration() != 10 {
		t.Fatalf("applied %d: an injecting spec was applied", status.GetAppliedGeneration())
	}
	if b, _ := os.ReadFile(h.host.Path(sshCAFile)); string(b) != ca+"\n" {
		t.Fatalf("CA file = %q", b)
	}
}
