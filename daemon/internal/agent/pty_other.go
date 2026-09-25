//go:build !linux

package agent

import (
	"errors"
	"os"
	osexec "os/exec"
)

// Terminals are Linux-only: bcd runs on Linux.
func startPTY(*osexec.Cmd) (*os.File, error) { return nil, errors.New("pseudo-terminals need Linux") }

func setWinsize(*os.File, uint32, uint32) error { return errors.New("pseudo-terminals need Linux") }

func hangupGroup(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		_ = p.Kill()
	}
}
