// Command bcd is the better-compute daemon: one binary whose modes run on every server (node), per
// datacenter (site), inside the PXE ramdisk (ramdisk) and on test hosts (sim), plus the local
// commands join, status, doctor and version (PLAN.md §6).
//
// sim runs in fakehw builds only. The release version is set at link time:
//
//	go build -ldflags "-X main.version=0.1.0" ./cmd/bcd
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"
	"runtime/debug"

	"github.com/better-compute/better-compute/daemon/internal/bcx"
	"github.com/better-compute/better-compute/daemon/internal/config"
	"github.com/better-compute/better-compute/daemon/internal/inventory"
	"github.com/better-compute/better-compute/daemon/internal/nvml"
)

// version is overridden with -ldflags "-X main.version=<version>".
var version = "0.0.0-dev"

// releaseSequence is the release manifest sequence of this build (-X main.releaseSequence=<n>,
// goreleaser's BCD_RELEASE_SEQUENCE): self-update takes no older release. "0": unknown (dev).
var releaseSequence = "0"

// Exit codes, as in the better-compute CLI: 0 success, 1 failure, 2 usage error or not implemented.
const (
	exitOK      = 0
	exitFailure = 1
	exitUsage   = 2
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == bcx.ShimCommand {
		// bcd as the plugin sandbox's shim (bcx.StartOptions.Shim): returns only on failure.
		fmt.Fprintf(os.Stderr, "%v\n", bcx.RunShim(os.Args[2:]))
		os.Exit(exitFailure)
	}
	code := run(os.Args[1:], os.Stdout, os.Stderr)
	if restartInto != "" {
		// A self-update swapped the binary slots: the same command, from the other binary.
		fmt.Fprintf(os.Stderr, "bcd: restart into %s: %v\n", restartInto, execInto(restartInto))
		os.Exit(exitFailure)
	}
	os.Exit(code)
}

type command struct {
	name    string
	summary string
	flags   func(fs *flag.FlagSet)
	run     func(fs *flag.FlagSet, stdout, stderr io.Writer) int
}

func commands() []command {
	withConfig := func(fs *flag.FlagSet) {
		fs.String("config", config.DefaultPath, "configuration file written by the install script")
	}
	noFlags := func(*flag.FlagSet) {}
	return []command{
		{name: "node", summary: "run the node agent: session, journal, inventory, convergence, commands", flags: withConfig, run: runNode},
		{name: "site", summary: "run the site agent: proxy DHCP, iPXE, image cache, BMC", flags: withConfig, run: runSite},
		{name: "ramdisk", summary: "run inside the PXE ramdisk: inspect, diag, wipe, image stream, kexec", flags: ramdiskFlags, run: runRamdisk},
		{name: "sim", summary: "run simulated daemons on fakehw against a gateway", flags: simFlags, run: runSim},
		{name: "join", summary: "join the fleet; the token is read from BCD_JOIN_TOKEN, stdin or --token-file", flags: joinFlags, run: runJoin},
		{name: "status", summary: "show the running node agent's state", flags: statusFlags, run: runStatus},
		{name: "doctor", summary: "check this host: configuration, NVML, hardware, KVM, IOMMU, gateway, identity", flags: withConfig, run: runDoctor},
		{name: "helper", summary: "run as root beside an unprivileged bcd node: typed privileged operations on [helper] socket", flags: withConfig, run: runHelper},
		{name: "update", summary: "show self-update state; --clear-failed lets failed versions be tried again", flags: updateFlags, run: runUpdate},
		{name: "version", summary: "print the version", flags: noFlags, run: runVersion},
	}
}

func joinFlags(fs *flag.FlagSet) {
	fs.String("config", config.DefaultPath, "configuration file written by the install script")
	fs.String("role", "node", "the agent role to join as: node or site (the token decides what is allowed)")
	fs.String("token-file", "", "read the join token from this file (removed once the join succeeded)")
	fs.String("node-id", "", "the node an installed OS joins as (a provisioned token; the identity must match)")
	fs.String("server", "", "the control plane URL: its well-known join key when join-encryption.jwk is absent, and its gateway and pins when config.toml is")
	fs.String("attestor", "", "the attestor (default join-token; provisioned with --node-id)")
	fs.String("serving-ca-pin", "", "sha256/<base64> pin of the gateway serving CA (required to join without config.toml)")
	fs.String("join-signing-pin", "", "sha256/<base64> pin of the key that signs JoinResponse (required to join without config.toml)")
	fs.String("join-encryption-pin", "", "sha256/<base64> pin of the key the join token is sealed to (required to join without config.toml)")
	fs.String("data-dir", config.DefaultDataDir, "the data directory a configuration written by bcd join names")
}

func simFlags(fs *flag.FlagSet) {
	fs.Int("nodes", 1, "number of simulated daemons")
	fs.Uint64("seed", 1, "fakehw seed of the first daemon; daemon i uses seed+i")
	fs.String("config", config.DefaultPath, "configuration file with the gateway URL and pins; the nodes live under its data_dir/sim")
}

func statusFlags(fs *flag.FlagSet) {
	fs.String("socket", config.DefaultSocketPath, "the node agent's root-only unix socket")
	fs.Bool("json", false, "print the status as JSON")
}

func run(args []string, stdout, stderr io.Writer) int {
	c, fs, code := parse(args, stdout, stderr)
	if c == nil {
		return code
	}
	return c.run(fs, stdout, stderr)
}

// parse finds the command args name and parses its flags. It returns the command, or nil and the
// exit code when there is nothing to run (help, a usage error).
func parse(args []string, stdout, stderr io.Writer) (*command, *flag.FlagSet, int) {
	if len(args) == 0 {
		usage(stderr)
		return nil, nil, exitUsage
	}
	name := args[0]
	switch name {
	case "help", "-h", "-help", "--help":
		usage(stdout)
		return nil, nil, exitOK
	case "-version", "--version":
		name = "version"
	}
	for _, c := range commands() {
		if c.name != name {
			continue
		}
		fs := flag.NewFlagSet(c.name, flag.ContinueOnError)
		fs.SetOutput(stderr)
		c.flags(fs)
		fs.Usage = func() {
			fmt.Fprintf(stderr, "bcd %s - %s\n\nUsage\n  bcd %s [flags]\n\nFlags\n", c.name, c.summary, c.name)
			fs.PrintDefaults()
		}
		if err := fs.Parse(args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil, nil, exitOK
			}
			return nil, nil, exitUsage
		}
		if fs.NArg() > 0 {
			// Never echo arguments: a join token pasted into argv must not reach logs.
			fmt.Fprintf(stderr, "bcd %s: takes no positional arguments\n", c.name)
			if c.name == "join" {
				fmt.Fprintln(stderr, "bcd join reads the join token from BCD_JOIN_TOKEN, stdin or --token-file, never from arguments")
			}
			return nil, nil, exitUsage
		}
		return &c, fs, exitOK
	}
	if isCommandName(name) {
		fmt.Fprintf(stderr, "bcd: unknown command %q\n\n", name)
	} else {
		fmt.Fprint(stderr, "bcd: unknown command\n\n")
	}
	usage(stderr)
	return nil, nil, exitUsage
}

func usage(w io.Writer) {
	fmt.Fprintf(w, "bcd %s - the better-compute daemon\n\nUsage\n  bcd <command> [flags]\n  bcd <command> -h    flags of one command\n\nCommands\n", version)
	for _, c := range commands() {
		fmt.Fprintf(w, "  %-8s %s\n", c.name, c.summary)
	}
	fmt.Fprint(w, "\nExit codes: 0 success, 1 failure, 2 usage error or not implemented yet.\n")
}

// isCommandName reports whether s looks like a command name, and not like a secret pasted in the
// wrong place, so that it is safe to echo.
func isCommandName(s string) bool {
	if s == "" || len(s) > 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; (c < 'a' || c > 'z') && c != '-' {
			return false
		}
	}
	return true
}

func runVersion(_ *flag.FlagSet, stdout, _ io.Writer) int {
	fmt.Fprintf(stdout, "bcd %s %s/%s %s%s\n", version, runtime.GOOS, runtime.GOARCH, runtime.Version(), buildTags())
	return exitOK
}

// buildTags returns " tags=<tags>" when the binary was built with -tags.
func buildTags() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, s := range info.Settings {
		if s.Key == "-tags" && s.Value != "" {
			return " tags=" + s.Value
		}
	}
	return ""
}

// runDoctor checks this host (PLAN.md §14): the configuration file, NVML, the hardware backend, and
// hostChecks (KVM, IOMMU, the gateway reachable, the node's identity). It has no clock check yet.
func runDoctor(fs *flag.FlagSet, stdout, _ io.Writer) int {
	file := fs.Lookup("config").Value.String()
	failed := false
	report := func(status, check, detail string) {
		if status == "fail" {
			failed = true
		}
		fmt.Fprintf(stdout, "%-4s  %-8s  %s\n", status, check, detail)
	}

	cfg, cfgErr := config.Load(file)
	if cfgErr != nil {
		report("fail", "config", cfgErr.Error())
	} else {
		report("ok", "config", fmt.Sprintf("%s: gateway %s, site %s", file, cfg.GatewayURL, cfg.Site))
		if warning := permissionWarning(file); warning != "" {
			report("warn", "config", warning)
		}
	}

	if info, err := nvml.Probe(); err == nil {
		report("ok", "nvml", fmt.Sprintf("driver %s, %d GPUs", info.DriverVersion, info.DeviceCount))
	} else if errors.Is(err, nvml.ErrNotBuilt) || errors.Is(err, nvml.ErrNoDriver) {
		report("warn", "nvml", err.Error())
	} else {
		report("fail", "nvml", err.Error())
	}

	if inv, err := collectInventory(); err != nil {
		report("warn", "hardware", hardwareBackend+": "+err.Error())
	} else if hashes, err := inventory.SectionHashes(inv); err != nil {
		report("fail", "hardware", hardwareBackend+": "+err.Error())
	} else {
		gpus := 0
		if inv.Gpus != nil {
			gpus = len(inv.Gpus.Gpus)
		}
		report("ok", "hardware", fmt.Sprintf("%s: %d GPUs, %d inventory sections hashed", hardwareBackend, gpus, len(hashes)))
	}

	for _, c := range hostChecks(cfg) {
		report(c.status, c.check, c.detail)
	}
	if failed {
		return exitFailure
	}
	return exitOK
}

// permissionWarning flags a configuration file that others can read or write; the install script
// writes it with mode 0600. Windows has no such mode bits.
func permissionWarning(file string) string {
	if runtime.GOOS == "windows" {
		return ""
	}
	st, err := os.Stat(file)
	if err != nil {
		return ""
	}
	if perm := uint32(st.Mode().Perm()); perm&0o077 != 0 {
		return fmt.Sprintf("%s has mode %04o; the install script writes 0600", file, perm)
	}
	return ""
}
