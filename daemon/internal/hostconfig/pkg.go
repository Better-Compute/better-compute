package hostconfig

import (
	"context"
	"fmt"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// Distribution families the package-installing units know.
const (
	FamilyDebian = "debian" // apt: Debian, Ubuntu
	FamilyRHEL   = "rhel"   // dnf: RHEL, Rocky, Alma, Fedora
	FamilySUSE   = "suse"   // zypper: SLES, openSUSE
)

// OSRelease is what /etc/os-release says about the host.
type OSRelease struct {
	ID     string
	IDLike []string
	// VersionID is VERSION_ID ("22.04", "9.4").
	VersionID string
}

// Family returns the package family, or "" for one the units do not know.
func (o OSRelease) Family() string {
	for _, id := range append([]string{o.ID}, o.IDLike...) {
		switch id {
		case "debian", "ubuntu":
			return FamilyDebian
		case "rhel", "centos", "fedora", "rocky", "almalinux":
			return FamilyRHEL
		case "suse", "sles", "opensuse", "opensuse-leap":
			return FamilySUSE
		}
	}
	return ""
}

// ReadOSRelease reads /etc/os-release (else /usr/lib/os-release).
func ReadOSRelease(sys System) (OSRelease, error) {
	var raw []byte
	var err error
	for _, p := range []string{"/etc/os-release", "/usr/lib/os-release"} {
		if raw, err = sys.ReadFile(p); err == nil {
			break
		}
	}
	if err != nil {
		return OSRelease{}, fmt.Errorf("os-release: %w", err)
	}
	var o OSRelease
	for _, line := range strings.Split(string(raw), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"'`)
		switch k {
		case "ID":
			o.ID = strings.ToLower(v)
		case "ID_LIKE":
			o.IDLike = strings.Fields(strings.ToLower(v))
		case "VERSION_ID":
			o.VersionID = v
		}
	}
	return o, nil
}

// install returns the step that installs packages with the family's package manager. The
// repositories (NVIDIA's CUDA repository, Kubernetes') are the OS image's business; a package they
// do not carry fails the step, which is retried.
func install(sys System, family string, pkgs ...string) (converge.Action, error) {
	desc := "install " + strings.Join(pkgs, " ")
	switch family {
	case FamilyDebian:
		env := []string{"DEBIAN_FRONTEND=noninteractive"}
		return converge.Action{Description: desc, Apply: func(ctx context.Context) error {
			if _, err := sys.Run(ctx, Cmd{Name: "apt-get", Args: []string{"-q", "update"}, Env: env}); err != nil {
				return err
			}
			args := append([]string{"-q", "-y", "--no-install-recommends", "-o", "Dpkg::Options::=--force-confold", "install"}, pkgs...)
			_, err := sys.Run(ctx, Cmd{Name: "apt-get", Args: args, Env: env})
			return err
		}}, nil
	case FamilyRHEL:
		return run(sys, Cmd{Name: "dnf", Args: append([]string{"-y", "install"}, pkgs...)}), nil
	case FamilySUSE:
		return run(sys, Cmd{Name: "zypper", Args: append([]string{"--non-interactive", "install"}, pkgs...)}), nil
	}
	return converge.Action{}, converge.Terminal(fmt.Errorf("no package manager known for this distribution"))
}

// serviceActive reports whether a systemd unit is active.
func serviceActive(ctx context.Context, sys System, unit string) bool {
	out, _ := sys.Run(ctx, Cmd{Name: "systemctl", Args: []string{"is-active", unit}})
	return strings.TrimSpace(string(out)) == "active"
}

// enableNow returns the step that enables and starts a systemd unit.
func enableNow(sys System, unit string) converge.Action {
	return run(sys, Cmd{Name: "systemctl", Args: []string{"enable", "--now", unit}})
}
