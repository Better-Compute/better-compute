package helper

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
)

// file.write checks what it writes, kind by kind: the node names a file bcd owns, and root writes it
// only when its content is what bcd node legitimately writes there. A compromised node then cannot
// use these files to run anything as root: no sshd directive beyond the three of the drop-in, no CDI
// hook, mount or device node that root's own NVIDIA spec does not already hold, no env line that is
// not KEY=VALUE.
//
// What this does not decide is whose CA and principals they are: any well-formed CA key and any
// `<account>@<node>` principal pass (root is a legitimate account), so a node that is compromised
// can still make sshd trust a CA of its own. Only checking the signed access section, as host.unit
// checks the signed host section (intent.go), closes that.

// SSHDropIn is the one sshd drop-in bcd writes (the access converger's): three directives naming
// bcd's own CA, principals and KRL files. file.write takes exactly these bytes for ssh-dropin.
var SSHDropIn = []byte(`# Written by bcd from NodeSpec access (break-glass SSH certificates). Do not edit.
TrustedUserCAKeys /etc/ssh/bc_ca.pub
AuthorizedPrincipalsFile /etc/ssh/bc_principals/%u
RevokedKeys /etc/ssh/bc_krl
`)

// ContentContext is what root knows when it checks a file's content.
type ContentContext struct {
	// Root prefixes the paths root reads ("" or "/": the real ones; tests set a directory).
	Root string
	// NodeID is this node's id when root knows it (its join record); "" checks only the form.
	NodeID string
}

var (
	envLine       = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*=[^\x00-\x1f\x7f]*$`)
	sshKeyType    = regexp.MustCompile(`^[a-z0-9][a-z0-9@.-]{2,63}$`)
	principalNode = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	bootstrapTok  = regexp.MustCompile(`^[a-z0-9]{6}\.[a-z0-9]{16}$`)
	cdiVersion    = regexp.MustCompile(`^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$`)
	cdiDeviceName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)
	cdiEnvValue   = regexp.MustCompile(`^[A-Za-z0-9_.,:/@-]*$`)
)

// lines splits a text file that must end with a line break into its lines; none may hold a control
// character (a carriage return included).
func lines(data []byte, max int) ([]string, error) {
	if len(data) == 0 || data[len(data)-1] != '\n' {
		return nil, errors.New("not a text file ending in a line break")
	}
	out := strings.Split(string(data[:len(data)-1]), "\n")
	if len(out) > max {
		return nil, fmt.Errorf("%d lines; at most %d", len(out), max)
	}
	for _, l := range out {
		for _, r := range l {
			if r < 0x20 || r == 0x7f {
				return nil, errors.New("a line holds a control character")
			}
		}
	}
	return out, nil
}

// CheckContent refuses content that is not what bcd node legitimately writes to a file of kind (name
// is the kind's id, already checked against its pattern).
func CheckContent(kind, name string, data []byte, c ContentContext) error {
	var err error
	switch kind {
	case "ssh-dropin":
		if !bytes.Equal(data, SSHDropIn) {
			err = errors.New("only bcd's own three directives (TrustedUserCAKeys, AuthorizedPrincipalsFile, RevokedKeys on bcd's files) are written")
		}
	case "ssh-ca":
		err = checkCAKeys(data)
	case "ssh-principals":
		err = checkPrincipals(name, data, c.NodeID)
	case "ssh-krl":
		err = checkKRL(data)
	case "allocation-env":
		err = checkEnvFile(name, data)
	case "k8s-token":
		if len(data) > 64 || !bootstrapTok.MatchString(strings.TrimSpace(string(data))) {
			err = errors.New("not a kubeadm bootstrap token (abcdef.0123456789abcdef)")
		}
	case "cdi":
		err = checkCDI(name, data, c.Root)
	default:
		err = errors.New("no content rule for this kind")
	}
	if err != nil {
		return fmt.Errorf("file.write %s: %w", kind, err)
	}
	return nil
}

// sshKeyBlob checks one OpenSSH public key line, "<type> <base64> [comment]" with nothing before
// the type (no options), and returns its key blob.
func sshKeyBlob(line string) ([]byte, error) {
	fields := strings.Fields(line)
	if len(fields) < 2 || !sshKeyType.MatchString(fields[0]) || !strings.HasPrefix(line, fields[0]+" ") {
		return nil, errors.New("a line is not an OpenSSH public key")
	}
	blob, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil {
		return nil, errors.New("a line is not an OpenSSH public key")
	}
	if !blobOfType(blob, fields[0]) {
		return nil, errors.New("a key's type is not the type its line names")
	}
	return blob, nil
}

// blobOfType reports a key blob that starts with its own type name, typ when given.
func blobOfType(blob []byte, typ string) bool {
	if len(blob) < 4 {
		return false
	}
	n := int(binary.BigEndian.Uint32(blob))
	if n < 3 || n > 64 || n+4 >= len(blob) {
		return false
	}
	name := string(blob[4 : 4+n])
	return sshKeyType.MatchString(name) && (typ == "" || name == typ)
}

// checkCAKeys: bc_ca.pub is the access section's CA keys, one OpenSSH public key a line.
func checkCAKeys(data []byte) error {
	ls, err := lines(data, 64)
	if err != nil {
		return err
	}
	for _, l := range ls {
		if _, err := sshKeyBlob(l); err != nil {
			return err
		}
	}
	return nil
}

// checkPrincipals: bc_principals/<account> lists `<account>@<this node>`, and nothing else (no
// options, no other account's or node's principal).
func checkPrincipals(account string, data []byte, nodeID string) error {
	if strings.ContainsAny(account, "@.") {
		return fmt.Errorf("%q is not an account bcd writes principals for", account)
	}
	ls, err := lines(data, 64)
	if err != nil {
		return err
	}
	for _, l := range ls {
		node, ok := strings.CutPrefix(l, account+"@")
		if !ok || !principalNode.MatchString(node) {
			return fmt.Errorf("a line is not a principal of account %s (%s@<node id>)", account, account)
		}
		if nodeID != "" && node != nodeID {
			return fmt.Errorf("a principal names node %q, not this node", node)
		}
	}
	return nil
}

// checkKRL: bc_krl is the KRL bcd builds (PROTOCOL.krl): the header with no flags and bcd's
// comment, then one certificates section per CA key, each a list of revoked serials.
func checkKRL(data []byte) error {
	bad := errors.New("not a key revocation list as bcd writes it")
	r := bytes.NewReader(data)
	u32 := func() (uint32, bool) {
		var v uint32
		return v, binary.Read(r, binary.BigEndian, &v) == nil
	}
	u64 := func() (uint64, bool) {
		var v uint64
		return v, binary.Read(r, binary.BigEndian, &v) == nil
	}
	str := func() ([]byte, bool) {
		n, ok := u32()
		if !ok || int64(n) > int64(r.Len()) {
			return nil, false
		}
		b := make([]byte, n)
		_, err := r.Read(b)
		return b, err == nil || n == 0
	}
	magic, ok1 := u64()
	version, ok2 := u32()
	_, ok3 := u64() // krl_version
	date, ok4 := u64()
	flags, ok5 := u64()
	reserved, ok6 := str()
	comment, ok7 := str()
	if !(ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7) || magic != 0x5353484b524c0a00 || version != 1 || date != 0 || flags != 0 ||
		len(reserved) != 0 || string(comment) != "better-compute" {
		return bad
	}
	for r.Len() > 0 {
		typ, err := r.ReadByte()
		section, ok := str()
		if err != nil || !ok || typ != 1 {
			return bad
		}
		s := bytes.NewReader(section)
		field := func() ([]byte, bool) {
			var n uint32
			if binary.Read(s, binary.BigEndian, &n) != nil || int64(n) > int64(s.Len()) {
				return nil, false
			}
			b := make([]byte, n)
			_, err := s.Read(b)
			return b, err == nil || n == 0
		}
		ca, ok1 := field()
		res, ok2 := field()
		sub, err := s.ReadByte()
		serials, ok3 := field()
		if !ok1 || !ok2 || err != nil || !ok3 || !blobOfType(ca, "") || len(res) != 0 || sub != 0x20 ||
			len(serials) == 0 || len(serials)%8 != 0 || s.Len() != 0 {
			return bad
		}
	}
	return nil
}

// checkEnvFile: an allocation's env file is KEY=VALUE lines, the first naming the allocation the
// file is named after. (The control plane's own extra lines follow: their keys are not root's to
// choose, their form is.)
func checkEnvFile(id string, data []byte) error {
	ls, err := lines(data, 1024)
	if err != nil {
		return err
	}
	if ls[0] != "BCD_ALLOCATION_ID="+id {
		return fmt.Errorf("the first line is not BCD_ALLOCATION_ID=%s", id)
	}
	for _, l := range ls {
		if !envLine.MatchString(l) {
			return errors.New("a line is not KEY=VALUE")
		}
	}
	return nil
}

// ---- CDI ----------------------------------------------------------------------------------------

// cdiDoc is a hold's CDI spec, with exactly the fields bcd writes (agent.cdiSpec).
type cdiDoc struct {
	CdiVersion     string            `json:"cdiVersion"`
	Kind           string            `json:"kind"`
	Annotations    map[string]string `json:"annotations"`
	Devices        []cdiDocDevice    `json:"devices"`
	ContainerEdits cdiDocEdits       `json:"containerEdits"`
}

type cdiDocDevice struct {
	Name           string            `json:"name"`
	Annotations    map[string]string `json:"annotations"`
	ContainerEdits cdiDocEdits       `json:"containerEdits"`
}

type cdiDocEdits struct {
	Env            []string          `json:"env"`
	DeviceNodes    []json.RawMessage `json:"deviceNodes"`
	Mounts         []json.RawMessage `json:"mounts"`
	Hooks          []json.RawMessage `json:"hooks"`
	AdditionalGIDs []uint32          `json:"additionalGids"`
}

// vendorEdits is everything root's own NVIDIA CDI specs hold, by category.
type vendorEdits struct {
	env                        map[string]bool
	deviceNodes, mounts, hooks []any
	gids                       map[uint32]bool
}

func (v *vendorEdits) add(e cdiDocEdits) {
	for _, s := range e.Env {
		v.env[s] = true
	}
	for _, g := range e.AdditionalGIDs {
		v.gids[g] = true
	}
	for dst, src := range map[*[]any][]json.RawMessage{&v.deviceNodes: e.DeviceNodes, &v.mounts: e.Mounts, &v.hooks: e.Hooks} {
		for _, raw := range src {
			var item any
			if json.Unmarshal(raw, &item) == nil {
				*dst = append(*dst, item)
			}
		}
	}
}

// vendorCDIDirs are where NVIDIA's specs live (agent.vendorCDIDirs): written by root's
// container-toolkit unit, never by the node.
var vendorCDIDirs = []string{"/etc/cdi", "/var/run/cdi"}

// loadVendorEdits reads root's NVIDIA JSON specs (kind nvidia.com/gpu; never bcd's own bcd-*.json,
// which hold what the node asked for). On the real filesystem as root, a spec or a directory that
// is not root's alone is not read: the node could have written it.
func loadVendorEdits(root string) *vendorEdits {
	v := &vendorEdits{env: map[string]bool{}, gids: map[uint32]bool{}}
	real := (root == "" || root == "/") && os.Geteuid() == 0
	for _, dir := range vendorCDIDirs {
		full := filepath.Join(root, dir)
		if fi, err := os.Stat(full); err != nil || !fi.IsDir() || (real && !rootOnly(fi)) {
			continue
		}
		entries, _ := os.ReadDir(full)
		for _, e := range entries {
			name := e.Name()
			if !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, "bcd-") {
				continue
			}
			file := filepath.Join(full, name)
			fi, err := os.Lstat(file)
			if err != nil || !fi.Mode().IsRegular() || (real && !rootOnly(fi)) || fi.Size() > 8<<20 {
				continue
			}
			raw, err := os.ReadFile(file)
			if err != nil {
				continue
			}
			var spec struct {
				Kind           string      `json:"kind"`
				ContainerEdits cdiDocEdits `json:"containerEdits"`
				Devices        []struct {
					ContainerEdits cdiDocEdits `json:"containerEdits"`
				} `json:"devices"`
			}
			if json.Unmarshal(raw, &spec) != nil || spec.Kind != "nvidia.com/gpu" {
				continue
			}
			v.add(spec.ContainerEdits)
			for _, d := range spec.Devices {
				v.add(d.ContainerEdits)
			}
		}
	}
	return v
}

// The env keys of bcd's own in a hold's spec (agent.holdEnv and NVIDIA_VISIBLE_DEVICES).
var cdiOwnEnv = []string{"BCD_ALLOCATION_ID", "BCD_CGROUP_PARENT", "CUDA_MPS_PIPE_DIRECTORY", "NVIDIA_VISIBLE_DEVICES"}

// The annotations bcd puts on a hold's spec and on its devices.
var (
	cdiSpecAnnotations   = []string{"bcd.dev/allocation-id", "bcd.dev/reservation-id", "bcd.dev/generation", "bcd.dev/cgroup-parent", "bcd.dev/binding"}
	cdiDeviceAnnotations = []string{"bcd.dev/device-id"}
)

func checkAnnotations(got map[string]string, allowed []string) error {
	for k, v := range got {
		if !containsString(allowed, k) {
			return fmt.Errorf("annotation %q is not one bcd writes", k)
		}
		if len(v) > 256 || strings.ContainsFunc(v, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
			return fmt.Errorf("annotation %q holds a control character or is too long", k)
		}
	}
	return nil
}

func containsString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// checkEdits: a hold's container edits are bcd's own env, and otherwise only what root's NVIDIA
// spec holds, item for item. No other hook runs and no other path is mounted or created in a
// container because the node asked.
func (v *vendorEdits) checkEdits(e cdiDocEdits) error {
	for _, env := range e.Env {
		key, value, ok := strings.Cut(env, "=")
		if ok && containsString(cdiOwnEnv, key) && cdiEnvValue.MatchString(value) {
			continue
		}
		if !v.env[env] {
			return fmt.Errorf("env %q is neither bcd's nor in root's NVIDIA CDI spec", key)
		}
	}
	for _, g := range e.AdditionalGIDs {
		if !v.gids[g] {
			return fmt.Errorf("additional gid %d is not in root's NVIDIA CDI spec", g)
		}
	}
	for what, c := range map[string]struct {
		got  []json.RawMessage
		have []any
	}{"device node": {e.DeviceNodes, v.deviceNodes}, "mount": {e.Mounts, v.mounts}, "hook": {e.Hooks, v.hooks}} {
		for _, raw := range c.got {
			var item any
			if err := json.Unmarshal(raw, &item); err != nil {
				return err
			}
			found := false
			for _, known := range c.have {
				if reflect.DeepEqual(item, known) {
					found = true
					break
				}
			}
			if !found {
				return fmt.Errorf("a %s is not in root's NVIDIA CDI spec (%s): bcd copies those, it never adds one", what, strings.Join(vendorCDIDirs, ", "))
			}
		}
	}
	return nil
}

// checkCDI: /etc/cdi/bcd-<allocation>.json is a hold's spec of kind bcd.dev/gpu with exactly the
// fields bcd writes.
func checkCDI(id string, data []byte, root string) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var doc cdiDoc
	if err := dec.Decode(&doc); err != nil {
		return fmt.Errorf("not a CDI spec as bcd writes it: %w", err)
	}
	if dec.More() {
		return errors.New("more than one JSON document")
	}
	if !cdiVersion.MatchString(doc.CdiVersion) || doc.Kind != "bcd.dev/gpu" {
		return errors.New("not a bcd.dev/gpu CDI spec")
	}
	if doc.Annotations["bcd.dev/allocation-id"] != id {
		return fmt.Errorf("the spec is not allocation %s's", id)
	}
	if err := checkAnnotations(doc.Annotations, cdiSpecAnnotations); err != nil {
		return err
	}
	if len(doc.Devices) > 4096 {
		return errors.New("too many devices")
	}
	vendor := loadVendorEdits(root)
	if err := vendor.checkEdits(doc.ContainerEdits); err != nil {
		return err
	}
	for _, d := range doc.Devices {
		if !cdiDeviceName.MatchString(d.Name) {
			return fmt.Errorf("device name %q", d.Name)
		}
		if err := checkAnnotations(d.Annotations, cdiDeviceAnnotations); err != nil {
			return err
		}
		if err := vendor.checkEdits(d.ContainerEdits); err != nil {
			return fmt.Errorf("device %s: %w", d.Name, err)
		}
	}
	return nil
}

// checkContent is CheckContent with what this helper knows.
func (s *Server) checkContent(kind, name string, data []byte) error {
	c := ContentContext{Root: s.Root}
	if s.HostSystem != nil && len(s.JoinSigningPin) > 0 {
		if joined, err := ReadJoinRecord(s.HostSystem, s.JoinSigningPin); err == nil && joined != nil {
			c.NodeID = joined.NodeID
		}
	}
	return CheckContent(kind, name, data, c)
}
