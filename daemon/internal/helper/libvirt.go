package helper

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Libvirt operations for an unprivileged bcd node (security review round 5, with [06192c]): the node
// is not in the libvirt group (that is root: a dir pool at /etc, a raw /dev disk); it asks the
// helper, which runs virsh on qemu:///system itself, only on bcd's domains, and defines only what
// ValidateDomainXML admits. Reading (list, domstate, dumpxml) needs no helper: the node uses the
// read-only socket.

// LibvirtRequest is one libvirt.* operation's arguments.
type LibvirtRequest struct {
	// Domain is the instance id (DomainName).
	Domain string `json:"domain,omitempty"`
	// XML is a domain definition (libvirt.define, libvirt.restore's --xml).
	XML []byte `json:"xml,omitempty"`
	// Target is a disk's target device (vda, vdz: blockresize, attach-disk, detach-disk).
	Target string `json:"target,omitempty"`
	// Bytes is blockresize's new size, and setmem's (what the guest's balloon leaves it).
	Bytes uint64 `json:"bytes,omitempty"`
	// File is a node-owned file: attach-disk's disk, restore's memory state, save's destination.
	File string `json:"file,omitempty"`
	// Paused starts or restores the domain paused (start, restore).
	Paused bool `json:"paused,omitempty"`
}

// LibvirtPolicy is the host's side of what the libvirt operations may touch.
type LibvirtPolicy struct {
	// Domain is what a definition may use (ValidateDomainXML).
	Domain DomainPolicy
	// StateDirs are where save may put, and restore read, a memory state (the node's instance and
	// snapshot work directories); CheckState checks a state file restore reads (NodeFileCheck).
	StateDirs  []string
	CheckState func(path string) error
	// NodeUID owns what save hands back to the node.
	NodeUID, NodeGID int
	// Staging is root's own directory save writes into first (never a node-owned path).
	Staging string
}

var (
	diskTarget  = regexp.MustCompile(`^vd[a-z]{1,2}$`)
	libvirtVerb = map[string]bool{
		"start": true, "shutdown": true, "destroy": true, "suspend": true, "resume": true, "undefine": true,
	}
)

// Virsh runs virsh as root on qemu:///system and returns its standard output.
type Virsh func(ctx context.Context, args ...string) ([]byte, error)

// libvirt serves libvirt.<verb>.
func (s *Server) libvirt(ctx context.Context, verb string, req *LibvirtRequest) error {
	if s.Virsh == nil || s.LibvirtPolicy == nil {
		return errors.New("libvirt operations are not configured on this helper")
	}
	if req == nil {
		return errors.New("no libvirt arguments")
	}
	policy, err := s.LibvirtPolicy()
	if err != nil {
		return err
	}
	if verb == "define" {
		name, err := ValidateDomainXML(req.XML, policy.Domain)
		if err != nil {
			return err
		}
		if err := s.ownDomainOrNone(ctx, name); err != nil {
			return err
		}
		return s.virshWithXML(ctx, policy, req.XML, "define")
	}
	if !DomainName.MatchString(req.Domain) {
		return fmt.Errorf("%q is not an instance id", req.Domain)
	}
	if err := s.ownDomain(ctx, req.Domain); err != nil {
		return err
	}
	switch {
	case libvirtVerb[verb]:
		args := []string{verb, req.Domain}
		if verb == "undefine" {
			args = append(args, "--nvram", "--managed-save")
		}
		if verb == "start" && req.Paused {
			args = append(args, "--paused")
		}
		_, err := s.Virsh(ctx, args...)
		return err
	case verb == "blockresize":
		if !diskTarget.MatchString(req.Target) || req.Bytes == 0 {
			return errors.New("blockresize: a vdX target and a size")
		}
		_, err := s.Virsh(ctx, "blockresize", req.Domain, req.Target, strconv.FormatUint(req.Bytes, 10)+"B")
		return err
	case verb == "setmem":
		// The balloon: libvirt caps it at the domain's memory; below that it only squeezes the node's
		// own guest, which the node may stop anyway.
		if req.Bytes < 1<<20 {
			return errors.New("setmem: a size of at least 1 MiB")
		}
		_, err := s.Virsh(ctx, "setmem", req.Domain, strconv.FormatUint(req.Bytes/1024, 10), "--live")
		return err
	case verb == "attach-disk":
		if req.Target != "vdz" {
			return errors.New("attach-disk: only the rebind disk (vdz) attaches live")
		}
		if err := policy.Domain.checkDiskFile(req.File); err != nil {
			return err
		}
		_, err := s.Virsh(ctx, "attach-disk", req.Domain, req.File, "vdz", "--targetbus", "virtio", "--subdriver", "raw", "--serial", "bc-rebind", "--live")
		return err
	case verb == "detach-disk":
		if req.Target != "vdz" {
			return errors.New("detach-disk: only the rebind disk (vdz)")
		}
		_, err := s.Virsh(ctx, "detach-disk", req.Domain, "vdz", "--live")
		return err
	case verb == "save":
		return s.saveDomain(ctx, policy, req)
	case verb == "restore":
		return s.restoreDomain(ctx, policy, req)
	}
	return fmt.Errorf("unknown libvirt operation %q", verb)
}

// ownDomain refuses a domain bcd did not define (its metadata names it as bcd's instance).
func (s *Server) ownDomain(ctx context.Context, name string) error {
	out, err := s.Virsh(ctx, "dumpxml", name)
	if err != nil {
		return err
	}
	if !bytes.Contains(out, []byte(bcdMetadataNS)) || !bytes.Contains(out, []byte(`id="`+name+`"`)) {
		return fmt.Errorf("domain %s is not bcd's", name)
	}
	return nil
}

// ownDomainOrNone lets define create a new domain or redefine bcd's own, never another's.
func (s *Server) ownDomainOrNone(ctx context.Context, name string) error {
	list, err := s.Virsh(ctx, "list", "--all", "--name")
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(list), "\n") {
		if strings.TrimSpace(line) == name {
			return s.ownDomain(ctx, name)
		}
	}
	return nil
}

// virshWithXML writes a checked definition into root's staging directory and runs virsh on it.
func (s *Server) virshWithXML(ctx context.Context, policy LibvirtPolicy, xml []byte, args ...string) error {
	if err := os.MkdirAll(policy.Staging, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(policy.Staging, "domain-*.xml")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(xml); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	_, err = s.Virsh(ctx, append(args, f.Name())...)
	return err
}

// saveDomain saves a domain's memory into root's staging directory, then hands the file to the node
// at req.File through an os.Root of its state directory: root never writes into a node path, and a
// symlink the node planted cannot move the copy elsewhere.
func (s *Server) saveDomain(ctx context.Context, policy LibvirtPolicy, req *LibvirtRequest) error {
	dir, name, err := stateFile(policy.StateDirs, req.File)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(policy.Staging, 0o700); err != nil {
		return err
	}
	staged := filepath.Join(policy.Staging, req.Domain+".memory.state")
	_ = os.Remove(staged)
	defer os.Remove(staged)
	if _, err := s.Virsh(ctx, "save", req.Domain, staged); err != nil {
		return err
	}
	src, err := os.Open(staged)
	if err != nil {
		return err
	}
	defer src.Close()
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	dst, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		return err
	}
	if err := dst.Chown(policy.NodeUID, policy.NodeGID); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		dst.Close()
		return err
	}
	return dst.Close()
}

// restoreDomain restores a memory state the node holds, with a checked definition when it gives one.
func (s *Server) restoreDomain(ctx context.Context, policy LibvirtPolicy, req *LibvirtRequest) error {
	if _, _, err := stateFile(policy.StateDirs, req.File); err != nil {
		return err
	}
	if policy.CheckState == nil {
		return errors.New("restore: no state file check configured")
	}
	if err := policy.CheckState(req.File); err != nil {
		return fmt.Errorf("restore: %s: %w", req.File, err)
	}
	paused := []string{}
	if req.Paused {
		paused = append(paused, "--paused")
	}
	if len(req.XML) == 0 {
		_, err := s.Virsh(ctx, append([]string{"restore", req.File}, paused...)...)
		return err
	}
	name, err := ValidateDomainXML(req.XML, policy.Domain)
	if err != nil {
		return err
	}
	if name != req.Domain {
		return errors.New("restore: the definition names another domain")
	}
	// virshWithXML appends the staged definition's path: --xml takes it.
	return s.virshWithXML(ctx, policy, req.XML, append(append([]string{"restore", req.File}, paused...), "--xml")...)
}

// stateFile splits a memory state path into its state directory and a plain name in it.
func stateFile(dirs []string, file string) (dir, name string, err error) {
	clean := filepath.Clean(file)
	if file == "" || clean != file || !filepath.IsAbs(file) {
		return "", "", fmt.Errorf("%q is not a clean absolute path", file)
	}
	for _, d := range dirs {
		if rel, err := filepath.Rel(d, file); err == nil && !strings.HasPrefix(rel, "..") && rel != "." {
			return d, rel, nil
		}
	}
	return "", "", fmt.Errorf("%s is outside the instances' state directories", file)
}

// ptsPath is a console pty libvirt hands a domain.
var ptsPath = regexp.MustCompile(`^/dev/pts/[0-9]{1,6}$`)

// console opens the pty of a bcd domain's serial console for the node: libvirt's pty is root's, and
// the node gets the one descriptor, never the path's permissions.
func (s *Server) console(ctx context.Context, req *LibvirtRequest) (*os.File, error) {
	if s.Virsh == nil {
		return nil, errors.New("libvirt operations are not configured on this helper")
	}
	if req == nil || !DomainName.MatchString(req.Domain) {
		return nil, errors.New("console: an instance id")
	}
	out, err := s.Virsh(ctx, "dumpxml", req.Domain)
	if err != nil {
		return nil, err
	}
	var dom struct {
		Metadata struct {
			Instance struct {
				ID string `xml:"id,attr"`
			} `xml:"https://better-compute.dev/libvirt/1 instance"`
		} `xml:"metadata"`
		Consoles []struct {
			Type   string `xml:"type,attr"`
			Source struct {
				Path string `xml:"path,attr"`
			} `xml:"source"`
		} `xml:"devices>console"`
	}
	if err := xml.Unmarshal(out, &dom); err != nil {
		return nil, fmt.Errorf("console: %w", err)
	}
	if dom.Metadata.Instance.ID != req.Domain {
		return nil, fmt.Errorf("domain %s is not bcd's", req.Domain)
	}
	for _, c := range dom.Consoles {
		if c.Type == "pty" && ptsPath.MatchString(c.Source.Path) {
			open := s.OpenConsole
			if open == nil {
				open = openPty
			}
			return open(c.Source.Path)
		}
	}
	return nil, errors.New("console: the domain has no pty console (is it running?)")
}

// Console asks the helper for a bcd domain's console: the pty's descriptor, read and written by the
// caller.
func (c Client) Console(ctx context.Context, domain string) (*os.File, error) {
	return c.callForFile(ctx, Request{Op: "libvirt.console", Libvirt: &LibvirtRequest{Domain: domain}})
}

// Libvirt runs a libvirt.<verb> through the helper.
func (c Client) Libvirt(ctx context.Context, verb string, req LibvirtRequest) error {
	c.Timeout = HostUnitTimeout // a memory save can be large
	return c.Do(ctx, Request{Op: "libvirt." + verb, Libvirt: &req})
}
