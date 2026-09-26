package hostconfig

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"strings"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// Paths the NVIDIA units read.
const (
	NvidiaModuleVersion = "/sys/module/nvidia/version"
	NvidiaProcVersion   = "/proc/driver/nvidia/version"
	NVSwitchDevices     = "/proc/driver/nvidia-nvswitch/devices"
	// CDISpecFile is the vendor CDI spec the container-toolkit unit generates (bcd's own
	// allocation specs are /etc/cdi/bcd-<alloc>.json, from the devices converger).
	CDISpecFile = "/etc/cdi/nvidia.yaml"
	// CDIStampFile records what the vendor CDI spec was generated for (driver and GPU list).
	CDIStampFile = StateDir + "/cdi-nvidia.stamp"
)

var driverBranch = regexp.MustCompile(`^[0-9]{3}$`)

// NvidiaDriver is the `nvidia-driver` unit: the driver branch (and the open kernel modules or the
// proprietary ones) installed and loaded. A different driver already loaded is swapped when
// nothing uses the GPUs (modprobe refuses otherwise); if it is in use, the unit asks for a reboot
// and never reboots itself.
type NvidiaDriver struct{}

type nvidiaDriverSettings struct {
	Branch string `json:"branch"`
	Open   *bool  `json:"open"`
}

func (NvidiaDriver) Name() string { return "nvidia-driver" }

// loadedDriver returns the loaded driver's version ("550.54.15") and whether it is the open kernel
// module; version is "" when none is loaded.
func loadedDriver(sys System) (version string, open bool, err error) {
	version, ok, err := readTrim(sys, NvidiaModuleVersion)
	if err != nil || !ok {
		return "", false, err
	}
	banner, _, err := readTrim(sys, NvidiaProcVersion)
	if err != nil {
		return "", false, err
	}
	return version, strings.Contains(banner, "Open Kernel Module"), nil
}

// installedDriver asks modinfo which nvidia module the next modprobe loads.
func installedDriver(ctx context.Context, sys System) (version string, open bool) {
	out, err := sys.Run(ctx, Cmd{Name: "modinfo", Args: []string{"-F", "version", "nvidia"}})
	if err != nil {
		return "", false
	}
	lic, _ := sys.Run(ctx, Cmd{Name: "modinfo", Args: []string{"-F", "license", "nvidia"}})
	return strings.TrimSpace(string(out)), strings.Contains(string(lic), "GPL")
}

func branchOf(version string) string {
	b, _, _ := strings.Cut(version, ".")
	return b
}

// driverPackages names the packages of a branch per distribution: Ubuntu's server drivers, NVIDIA's
// CUDA repository elsewhere (the RHEL family through its DNF module streams).
func driverPackages(o OSRelease, branch string, open bool) (family string, pkgs []string, err error) {
	family = o.Family()
	switch {
	case o.ID == "ubuntu":
		flavor := ""
		if open {
			flavor = "-open"
		}
		return family, []string{"nvidia-headless-" + branch + "-server" + flavor, "nvidia-utils-" + branch + "-server"}, nil
	case family == FamilyDebian:
		if open {
			return family, []string{"nvidia-open-" + branch}, nil
		}
		return family, []string{"cuda-drivers-" + branch}, nil
	case family == FamilyRHEL:
		stream := branch + "-dkms"
		if open {
			stream = branch + "-open"
		}
		return family, []string{"@nvidia-driver:" + stream}, nil
	case family == FamilySUSE:
		if open {
			return family, []string{"nvidia-open-driver-G06-signed-kmp-default", "nvidia-compute-utils-G06"}, nil
		}
		return family, []string{"nvidia-driver-G06-kmp-default", "nvidia-compute-utils-G06"}, nil
	}
	return "", nil, converge.Terminal(fmt.Errorf("nvidia-driver: no driver packages known for %s", o.ID))
}

func (d NvidiaDriver) Plan(ctx context.Context, sys System, settings json.RawMessage) ([]converge.Action, error) {
	var s nvidiaDriverSettings
	if err := decode(d.Name(), settings, &s); err != nil {
		return nil, err
	}
	if !driverBranch.MatchString(s.Branch) {
		return nil, converge.Terminal(fmt.Errorf("nvidia-driver.branch: %q is not a driver branch", s.Branch))
	}
	// Unset "open" accepts whichever flavor is installed.
	flavorOK := func(open bool) bool { return s.Open == nil || *s.Open == open }

	loaded, loadedOpen, err := loadedDriver(sys)
	if err != nil {
		return nil, err
	}
	if loaded != "" && branchOf(loaded) == s.Branch && flavorOK(loadedOpen) {
		return planPersistenced(ctx, sys), nil
	}
	var actions []converge.Action
	installed, installedOpen := installedDriver(ctx, sys)
	if installed == "" || branchOf(installed) != s.Branch || !flavorOK(installedOpen) {
		o, err := ReadOSRelease(sys)
		if err != nil {
			return nil, err
		}
		open := s.Open != nil && *s.Open
		family, pkgs, err := driverPackages(o, s.Branch, open)
		if err != nil {
			return nil, err
		}
		step, err := install(sys, family, pkgs...)
		if err != nil {
			return nil, err
		}
		actions = append(actions, step)
	}
	if loaded != "" {
		// Unload the old driver; modprobe -r refuses while anything holds the GPUs.
		old := loaded
		actions = append(actions, converge.Action{
			Description: "unload NVIDIA driver " + old,
			Apply: func(ctx context.Context) error {
				for _, svc := range []string{"nvidia-fabricmanager", "nvidia-persistenced", "nvidia-dcgm"} {
					_, _ = sys.Run(ctx, Cmd{Name: "systemctl", Args: []string{"stop", svc}})
				}
				if _, err := sys.Run(ctx, Cmd{Name: "modprobe", Args: []string{"-r", "nvidia_uvm", "nvidia_drm", "nvidia_modeset", "nvidia"}}); err != nil {
					return fmt.Errorf("driver %s is in use; reboot the node to load branch %s: %w", old, s.Branch, err)
				}
				return nil
			},
		})
	}
	actions = append(actions,
		run(sys, Cmd{Name: "modprobe", Args: []string{"nvidia"}}),
		run(sys, Cmd{Name: "modprobe", Args: []string{"nvidia_uvm"}}),
		converge.Action{
			Description: "check the loaded driver",
			Apply: func(ctx context.Context) error {
				v, open, err := loadedDriver(sys)
				if err != nil {
					return err
				}
				if branchOf(v) != s.Branch || !flavorOK(open) {
					return fmt.Errorf("driver %q is loaded, not branch %s; reboot the node", v, s.Branch)
				}
				return nil
			},
		})
	return append(actions, planPersistenced(ctx, sys)...), nil
}

// planPersistenced keeps nvidia-persistenced running where it is installed, so the GPUs stay
// initialized between jobs.
func planPersistenced(ctx context.Context, sys System) []converge.Action {
	if !sys.LookPath("nvidia-persistenced") || serviceActive(ctx, sys, "nvidia-persistenced") {
		return nil
	}
	return []converge.Action{enableNow(sys, "nvidia-persistenced")}
}

// FabricManager is the `fabric-manager` unit: NVIDIA Fabric Manager installed (matching the loaded
// driver's branch) and running on NVSwitch systems. On a host without NVSwitches it has nothing to
// do, so a profile can name it for every node of a mixed pool.
type FabricManager struct{}

func (FabricManager) Name() string { return "fabric-manager" }

func (f FabricManager) Plan(ctx context.Context, sys System, settings json.RawMessage) ([]converge.Action, error) {
	var s struct{}
	if err := decode(f.Name(), settings, &s); err != nil {
		return nil, err
	}
	switches, err := sys.ReadDir(NVSwitchDevices)
	if errors.Is(err, fs.ErrNotExist) || (err == nil && len(switches) == 0) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	version, _, err := loadedDriver(sys)
	if err != nil {
		return nil, err
	}
	if version == "" {
		return nil, fmt.Errorf("fabric-manager: no NVIDIA driver is loaded yet")
	}
	var actions []converge.Action
	if !sys.LookPath("nv-fabricmanager") {
		o, err := ReadOSRelease(sys)
		if err != nil {
			return nil, err
		}
		pkg := "nvidia-fabricmanager-" + branchOf(version)
		if o.Family() != FamilyDebian {
			pkg = "nvidia-fabric-manager"
		}
		step, err := install(sys, o.Family(), pkg)
		if err != nil {
			return nil, err
		}
		actions = append(actions, step)
	}
	if len(actions) > 0 || !serviceActive(ctx, sys, "nvidia-fabricmanager") {
		actions = append(actions, enableNow(sys, "nvidia-fabricmanager"))
	}
	return actions, nil
}

// hasNVSwitches reports whether the host has NVSwitches (and so needs Fabric Manager).
func hasNVSwitches(sys System) bool {
	switches, err := sys.ReadDir(NVSwitchDevices)
	return err == nil && len(switches) > 0
}

// Conditions reports FabricManagerDown while an NVSwitch system runs without Fabric Manager: its
// GPUs cannot talk over NVLink, and CUDA fails to initialize multi-GPU jobs.
func (FabricManager) Conditions(ctx context.Context, sys System, _ json.RawMessage) []Condition {
	if !hasNVSwitches(sys) || serviceActive(ctx, sys, "nvidia-fabricmanager") {
		return nil
	}
	return []Condition{{
		Type:    "FabricManagerDown",
		Reason:  "NotRunning",
		Message: "nvidia-fabricmanager is not running on this NVSwitch system: NVLink between its GPUs is down",
	}}
}

// ContainerToolkit is the `container-toolkit` unit: the NVIDIA container toolkit installed, the
// container runtimes on the host (containerd, Docker) configured with its runtime, and, with cdi,
// the vendor CDI spec /etc/cdi/nvidia.yaml regenerated whenever the driver or the GPUs (a MIG
// layout) change.
type ContainerToolkit struct{}

type containerToolkitSettings struct {
	CDI *bool `json:"cdi"`
}

func (ContainerToolkit) Name() string { return "container-toolkit" }

// containerRuntimes are the runtimes nvidia-ctk configures: the program that marks one installed,
// the file its configuration lives in, and the systemd unit restarted after.
var containerRuntimes = []struct{ name, program, config, service string }{
	{"containerd", "containerd", "/etc/containerd/config.toml", "containerd"},
	{"docker", "dockerd", "/etc/docker/daemon.json", "docker"},
}

func (c ContainerToolkit) Plan(ctx context.Context, sys System, settings json.RawMessage) ([]converge.Action, error) {
	var s containerToolkitSettings
	if err := decode(c.Name(), settings, &s); err != nil {
		return nil, err
	}
	cdi := s.CDI == nil || *s.CDI
	var actions []converge.Action
	if !sys.LookPath("nvidia-ctk") {
		o, err := ReadOSRelease(sys)
		if err != nil {
			return nil, err
		}
		step, err := install(sys, o.Family(), "nvidia-container-toolkit")
		if err != nil {
			return nil, err
		}
		actions = append(actions, step)
	}
	for _, rt := range containerRuntimes {
		if !sys.LookPath(rt.program) {
			continue
		}
		have, _, err := readTrim(sys, rt.config)
		if err != nil {
			return nil, err
		}
		if strings.Contains(have, "nvidia-container-runtime") {
			continue
		}
		args := []string{"runtime", "configure", "--runtime=" + rt.name}
		if cdi {
			args = append(args, "--cdi.enabled")
		}
		actions = append(actions,
			run(sys, Cmd{Name: "nvidia-ctk", Args: args}),
			run(sys, Cmd{Name: "systemctl", Args: []string{"restart", rt.service}}))
	}
	if !cdi {
		return actions, nil
	}
	stamp, err := cdiStamp(ctx, sys)
	if err != nil {
		return nil, err
	}
	have, _, err := readTrim(sys, CDIStampFile)
	if err != nil {
		return nil, err
	}
	if _, err := sys.ReadFile(CDISpecFile); err == nil && have == stamp {
		return actions, nil
	} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return append(actions, converge.Action{
		Description: "generate " + CDISpecFile,
		Apply: func(ctx context.Context) error {
			// Generated at apply time: the driver or the MIG layout may have changed since planning.
			stamp, err := cdiStamp(ctx, sys)
			if err != nil {
				return err
			}
			spec, err := sys.Run(ctx, Cmd{Name: "nvidia-ctk", Args: []string{"cdi", "generate", "--format=yaml"}})
			if err != nil {
				return err
			}
			if len(strings.TrimSpace(string(spec))) == 0 {
				return fmt.Errorf("nvidia-ctk cdi generate printed no spec")
			}
			if err := sys.WriteFile(CDISpecFile, spec, 0o644); err != nil {
				return err
			}
			return sys.WriteFile(CDIStampFile, []byte(stamp+"\n"), 0o644)
		},
	}), nil
}

// cdiStamp identifies what the CDI spec describes: the loaded driver and every GPU and MIG device.
func cdiStamp(ctx context.Context, sys System) (string, error) {
	version, _, err := loadedDriver(sys)
	if err != nil {
		return "", err
	}
	if version == "" {
		return "", fmt.Errorf("container-toolkit: no NVIDIA driver is loaded yet")
	}
	devices, err := sys.Run(ctx, Cmd{Name: "nvidia-smi", Args: []string{"-L"}})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(version + "\n" + string(devices)))
	return hex.EncodeToString(sum[:]), nil
}
