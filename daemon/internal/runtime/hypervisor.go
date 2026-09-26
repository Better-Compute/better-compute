package runtime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Hypervisor does libvirt's privileged operations for an unprivileged bcd node (bcd helper's
// libvirt.* ops, where root validates every domain definition and path): the node then needs no
// write access to qemu:///system, only its read-only socket (virsh -r) for reads.
type Hypervisor interface {
	// Libvirt runs one operation: define {XML}; start, shutdown, destroy, suspend, resume, undefine
	// {Domain}; blockresize {Domain, Target, Bytes}; setmem {Domain, Bytes} (the balloon); attach-disk, detach-disk {Domain, Target vdz,
	// File}; save {Domain, File}; restore {Domain, File, XML?}.
	Libvirt(ctx context.Context, verb string, op LibvirtOp) error
	// Console opens a domain's serial console pty.
	Console(ctx context.Context, domain string) (*os.File, error)
}

// LibvirtOp is one privileged libvirt operation's arguments.
type LibvirtOp struct {
	Domain string
	XML    []byte
	Target string
	Bytes  uint64
	File   string
	// Paused starts or restores the domain paused (start, restore).
	Paused bool
}

// readOnlyVerbs run on libvirt's read-only socket under a Hypervisor.
var readOnlyVerbs = map[string]bool{"list": true, "domstate": true, "dumpxml": true, "domstats": true}

// privileged turns a virsh invocation into the Hypervisor's operation. Under a Hypervisor nothing
// writes through qemu:///system directly: an operation it does not know is refused.
func (l *Libvirt) privileged(ctx context.Context, args []string) ([]byte, error) {
	if len(args) == 0 {
		return nil, errors.New("virsh: no command")
	}
	verb, rest := args[0], args[1:]
	flag := func(name string) bool {
		for _, a := range rest {
			if a == name {
				return true
			}
		}
		return false
	}
	op := LibvirtOp{}
	if len(rest) > 0 {
		op.Domain = rest[0]
	}
	switch verb {
	case "define":
		raw, err := os.ReadFile(op.Domain) // define <file>
		if err != nil {
			return nil, err
		}
		return nil, l.Hypervisor.Libvirt(ctx, "define", LibvirtOp{XML: raw})
	case "start":
		op.Paused = flag("--paused")
		return nil, l.Hypervisor.Libvirt(ctx, "start", op)
	case "shutdown", "destroy", "suspend", "resume", "undefine":
		return nil, l.Hypervisor.Libvirt(ctx, verb, op)
	case "blockresize": // blockresize <id> <target> <bytes>B
		if len(rest) != 3 {
			return nil, fmt.Errorf("virsh blockresize %v", rest)
		}
		n, err := strconv.ParseUint(strings.TrimSuffix(rest[2], "B"), 10, 64)
		if err != nil {
			return nil, err
		}
		op.Target, op.Bytes = rest[1], n
		return nil, l.Hypervisor.Libvirt(ctx, verb, op)
	case "setmem": // setmem <id> <KiB> --live
		if len(rest) < 2 {
			return nil, fmt.Errorf("virsh setmem %v", rest)
		}
		kib, err := strconv.ParseUint(rest[1], 10, 64)
		if err != nil {
			return nil, err
		}
		op.Bytes = kib * 1024
		return nil, l.Hypervisor.Libvirt(ctx, verb, op)
	case "attach-disk": // attach-disk <id> <file> vdz ...
		if len(rest) < 3 {
			return nil, fmt.Errorf("virsh attach-disk %v", rest)
		}
		op.File, op.Target = rest[1], rest[2]
		return nil, l.Hypervisor.Libvirt(ctx, verb, op)
	case "detach-disk": // detach-disk <id> vdz --live
		if len(rest) < 2 {
			return nil, fmt.Errorf("virsh detach-disk %v", rest)
		}
		op.Target = rest[1]
		return nil, l.Hypervisor.Libvirt(ctx, verb, op)
	case "save": // save <id> <file>
		if len(rest) != 2 {
			return nil, fmt.Errorf("virsh save %v", rest)
		}
		op.File = rest[1]
		return nil, l.Hypervisor.Libvirt(ctx, verb, op)
	case "restore": // restore <file> [--xml <file>] [--paused]
		if len(rest) == 0 {
			return nil, errors.New("virsh restore: no state file")
		}
		op = LibvirtOp{File: rest[0]}
		id, err := l.instanceOf(op.File)
		if err != nil {
			return nil, err
		}
		op.Domain = id
		for i := 1; i+1 < len(rest); i++ {
			if rest[i] == "--xml" {
				if op.XML, err = os.ReadFile(rest[i+1]); err != nil {
					return nil, err
				}
			}
		}
		op.Paused = flag("--paused")
		return nil, l.Hypervisor.Libvirt(ctx, verb, op)
	}
	return nil, fmt.Errorf("virsh %s is not an operation bcd helper does", verb)
}

// instanceOf names the instance whose directory holds path (a memory state).
func (l *Libvirt) instanceOf(path string) (string, error) {
	rel, err := filepath.Rel(filepath.Join(l.Dir, "instances"), path)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("%s is not in an instance's directory", path)
	}
	id, _, _ := strings.Cut(filepath.ToSlash(rel), "/")
	if !instanceID.MatchString(id) {
		return "", fmt.Errorf("%s is not in an instance's directory", path)
	}
	return id, nil
}
