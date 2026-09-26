package hostconfig

import (
	"context"
	"fmt"

	"github.com/better-compute/better-compute/daemon/internal/converge"
)

// BootArgsDir holds, per unit, the kernel arguments the boot loader was last set up with.
const BootArgsDir = StateDir + "/bootargs"

// planBootArgs keeps a unit's kernel arguments on the boot loader's command line: a GRUB drop-in
// (/etc/default/grub.d/90-bcd-<unit>.cfg) and update-grub on the Debian family, grubby elsewhere.
// args "" removes what the unit added. The arguments apply from the next boot; the caller reports
// the reboot. Nothing is planned while the recorded arguments are already args.
func planBootArgs(sys System, unit, args string) ([]converge.Action, error) {
	state := BootArgsDir + "/" + unit
	have, _, err := readTrim(sys, state)
	if err != nil {
		return nil, err
	}
	if have == args {
		return nil, nil
	}
	dropIn := "/etc/default/grub.d/90-bcd-" + unit + ".cfg"
	var steps []converge.Action
	switch {
	case sys.LookPath("update-grub"):
		if args == "" {
			a, err := ensureAbsent(sys, dropIn)
			if err != nil {
				return nil, err
			}
			steps = append(steps, a...)
		} else {
			cfg := generatedHeader(unit) + `GRUB_CMDLINE_LINUX="$GRUB_CMDLINE_LINUX ` + args + "\"\n"
			steps = append(steps, converge.Action{
				Description: "write " + dropIn,
				Apply:       func(context.Context) error { return sys.WriteFile(dropIn, []byte(cfg), 0o644) },
			})
		}
		steps = append(steps, run(sys, Cmd{Name: "update-grub"}))
	case sys.LookPath("grubby"):
		if have != "" {
			steps = append(steps, run(sys, Cmd{Name: "grubby", Args: []string{"--update-kernel=ALL", "--remove-args=" + have}}))
		}
		if args != "" {
			steps = append(steps, run(sys, Cmd{Name: "grubby", Args: []string{"--update-kernel=ALL", "--args=" + args}}))
		}
	default:
		if args == "" {
			return nil, nil
		}
		return nil, fmt.Errorf("%s: neither update-grub nor grubby is installed to set kernel arguments", unit)
	}
	record := []byte(args + "\n")
	return append(steps, converge.Action{
		Description: "record the kernel arguments",
		Apply: func(context.Context) error {
			if args == "" {
				return sys.RemoveFile(state)
			}
			return sys.WriteFile(state, record, 0o644)
		},
	}), nil
}
