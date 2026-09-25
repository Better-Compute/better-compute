//go:build !linux

package bcx

import (
	"errors"
	"os"
	"os/exec"
)

// ShimCommand is the argument that makes the shim executable run RunShim (Linux only).
const ShimCommand = "__bcx-exec"

// prepare runs the binary by path: the sandbox (fd exec, credentials, cgroups, seccomp) is Linux's.
func prepare(cmd *exec.Cmd, _ *os.File, path, _ string, o StartOptions, _ string) (func(), error) {
	if o.Shim != "" || o.Credential != nil || o.CgroupDir != "" {
		return nil, errors.New("the plugin sandbox needs Linux")
	}
	cmd.Path = path
	return func() {}, nil
}

func killGroup(cmd *exec.Cmd, _ string) { _ = cmd.Process.Kill() }

// PrepareCgroup is Linux only.
func PrepareCgroup(string) error { return errors.New("plugin cgroups need Linux") }

// RunShim is Linux only.
func RunShim([]string) error { return errors.New("bcx shim: needs Linux") }
