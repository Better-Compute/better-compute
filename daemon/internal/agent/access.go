package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path"
	"sort"
	"strings"

	agentv1 "github.com/better-compute/better-compute/daemon/gen/bettercompute/agent/v1"
	"github.com/better-compute/better-compute/daemon/internal/converge"
	"google.golang.org/protobuf/proto"
)

// Break-glass SSH (PLAN.md §13; apps/docs guides/access/ssh): the access section's CA keys,
// node-bound principals and revoked serials become sshd configuration. sshd reads the CA, principals
// and KRL files at every authentication, so only a changed drop-in needs a reload.
const (
	sshDropIn        = "/etc/ssh/sshd_config.d/10-better-compute.conf"
	sshCAFile        = "/etc/ssh/bc_ca.pub"
	sshPrincipalsDir = "/etc/ssh/bc_principals"
	sshKRLFile       = "/etc/ssh/bc_krl"
)

var sshDropInContent = []byte(`# Written by bcd from NodeSpec access (break-glass SSH certificates). Do not edit.
TrustedUserCAKeys ` + sshCAFile + `
AuthorizedPrincipalsFile ` + sshPrincipalsDir + `/%u
RevokedKeys ` + sshKRLFile + `
`)

// accessConverger applies AccessSection. An empty or absent section removes everything it wrote,
// so a node stops trusting the CA when the control plane stops sending it.
type accessConverger struct {
	a          *Agent
	generation uint64
	// jwks is the exec-ticket JWKS of the applied section (tunnels verify tickets against it).
	jwks string
}

func (c *accessConverger) Section() converge.Section { return converge.SectionAccess }

func (c *accessConverger) Plan(_ context.Context, desired []byte) ([]converge.Action, error) {
	section := &agentv1.AccessSection{}
	if err := proto.Unmarshal(desired, section); err != nil {
		return nil, converge.Terminal(fmt.Errorf("access section: %w", err))
	}
	if err := validateAccess(section); err != nil {
		return nil, converge.Terminal(err)
	}
	c.a.mu.Lock()
	c.a.execJWKS = section.GetExecTicketJwksJson()
	c.a.mu.Unlock()
	host := c.a.host
	files := map[string][]byte{}
	if len(section.GetSshCaPublicKeys()) > 0 {
		files[sshDropIn] = sshDropInContent
		files[sshCAFile] = []byte(strings.Join(section.GetSshCaPublicKeys(), "\n") + "\n")
		krl, err := buildKRL(section.GetSshCaPublicKeys(), section.GetSshRevokedSerials(), c.generation)
		if err != nil {
			return nil, converge.Terminal(err)
		}
		files[sshKRLFile] = krl
		byAccount := map[string][]string{}
		for _, p := range section.GetSshPrincipals() {
			account, node, ok := strings.Cut(p, "@")
			// Only this node's principals; a certificate for another node never opens this one.
			if !ok || node != c.a.NodeID() || account == "" || strings.ContainsAny(account, "/\\ \t\n.") {
				continue
			}
			byAccount[account] = append(byAccount[account], p)
		}
		for account, lines := range byAccount {
			sort.Strings(lines)
			files[path.Join(sshPrincipalsDir, account)] = []byte(strings.Join(lines, "\n") + "\n")
		}
	}
	var actions []converge.Action
	reload := false
	names := make([]string, 0, len(files))
	for p := range files {
		names = append(names, p)
	}
	sort.Strings(names)
	for _, p := range names {
		content := files[p]
		current, err := os.ReadFile(host.Path(p))
		if err == nil && bytes.Equal(current, content) {
			continue
		}
		if p == sshDropIn {
			reload = true
		}
		actions = append(actions, converge.Action{
			Description: "write " + p,
			Apply:       func(context.Context) error { return writeFile(host.Path(p), content, 0o644) },
		})
	}
	// Remove what is no longer desired: stale principal files, and everything when the section is empty.
	stale := []string{}
	if entries, err := os.ReadDir(host.Path(sshPrincipalsDir)); err == nil {
		for _, e := range entries {
			p := path.Join(sshPrincipalsDir, e.Name())
			if _, keep := files[p]; !keep {
				stale = append(stale, p)
			}
		}
	}
	for _, p := range []string{sshDropIn, sshCAFile, sshKRLFile} {
		if _, keep := files[p]; !keep {
			if _, err := os.Stat(host.Path(p)); err == nil {
				stale = append(stale, p)
				if p == sshDropIn {
					reload = true
				}
			}
		}
	}
	for _, p := range stale {
		actions = append(actions, converge.Action{
			Description: "remove " + p,
			Apply: func(context.Context) error {
				if err := os.Remove(host.Path(p)); err != nil && !errors.Is(err, os.ErrNotExist) {
					return err
				}
				return nil
			},
		})
	}
	if reload {
		actions = append(actions, converge.Action{
			Description: "reload sshd",
			Apply:       func(context.Context) error { return host.ReloadSSH() },
		})
	}
	return actions, nil
}

// OpenSSH KRL (PROTOCOL.krl): the revoked certificate serials, per CA key.
const (
	krlMagic             = 0x5353484b524c0a00
	krlFormatVersion     = 1
	krlSectionCerts      = 1
	krlSectionCertSerial = 0x20
)

// buildKRL encodes a KRL revoking serials under every CA key (krl_version = generation, a fixed
// generated_date so that the file only changes with its content). No serials still yields a valid,
// empty KRL.
func buildKRL(caKeys []string, serials []uint64, generation uint64) ([]byte, error) {
	var b bytes.Buffer
	u32 := func(v uint32) { _ = binary.Write(&b, binary.BigEndian, v) }
	u64 := func(v uint64) { _ = binary.Write(&b, binary.BigEndian, v) }
	str := func(s []byte) { u32(uint32(len(s))); b.Write(s) }
	u64(krlMagic)
	u32(krlFormatVersion)
	u64(generation) // krl_version
	u64(0)          // generated_date
	u64(0)          // flags
	str(nil)        // reserved
	str([]byte("better-compute"))
	if len(serials) == 0 {
		return b.Bytes(), nil
	}
	sorted := append([]uint64(nil), serials...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	var list bytes.Buffer
	for _, s := range sorted {
		_ = binary.Write(&list, binary.BigEndian, s)
	}
	for _, line := range caKeys {
		blob, err := sshKeyBlob(line)
		if err != nil {
			return nil, err
		}
		var section bytes.Buffer
		sstr := func(s []byte) { _ = binary.Write(&section, binary.BigEndian, uint32(len(s))); section.Write(s) }
		sstr(blob) // ca_key
		sstr(nil)  // reserved
		section.WriteByte(krlSectionCertSerial)
		sstr(list.Bytes())
		b.WriteByte(krlSectionCerts)
		str(section.Bytes())
	}
	return b.Bytes(), nil
}

// hasControl reports a control character (a line break would smuggle a second line into an sshd
// file: another trusted CA, another principal).
func hasControl(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// validateAccess refuses an access section that could inject lines into sshd's files: a CA key or
// principal with a control character, a CA key that is not one OpenSSH public key, a principal with
// whitespace. A spec carrying one is refused whole (onDesired), signed or not.
func validateAccess(section *agentv1.AccessSection) error {
	for _, k := range section.GetSshCaPublicKeys() {
		if hasControl(k) {
			return errors.New("an SSH CA key contains a control character")
		}
		if _, err := sshKeyBlob(k); err != nil {
			return err
		}
	}
	for _, p := range section.GetSshPrincipals() {
		if hasControl(p) || strings.ContainsAny(p, " \t") {
			return errors.New("an SSH principal contains whitespace or a control character")
		}
	}
	return nil
}

// sshKeyBlob decodes the key blob of an OpenSSH public key line ("<type> <base64> [comment]").
func sshKeyBlob(line string) ([]byte, error) {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return nil, fmt.Errorf("access: not an OpenSSH public key: %q", line)
	}
	blob, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil || len(blob) < 4 {
		return nil, fmt.Errorf("access: not an OpenSSH public key: %q", fields[0])
	}
	// The blob starts with its own key type.
	n := binary.BigEndian.Uint32(blob)
	if int(n)+4 > len(blob) || string(blob[4:4+n]) != fields[0] {
		return nil, fmt.Errorf("access: key type mismatch in %q", fields[0])
	}
	return blob, nil
}
