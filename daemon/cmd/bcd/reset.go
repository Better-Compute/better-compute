package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/better-compute/better-compute/daemon/internal/agent"
)

// resetIdentity is bcd join --reset: it moves the node's identity (identity.json, node.key and a
// pending node.key.next) aside, each renamed <name>.reset-<UTC time> in the data directory, so the join
// that follows runs as on a new machine. Nothing is deleted: the old files stay for an operator (a
// TPM key's record still names its key). Root only (outside development builds), and only with --yes;
// without it, it says what it would move.
func resetIdentity(dataDir string, yes bool, stdout, stderr io.Writer) int {
	if !devBuild && os.Geteuid() != 0 {
		fmt.Fprintln(stderr, "bcd join --reset: run it as root")
		return exitFailure
	}
	var present []string
	for _, name := range []string{agent.StateFile, agent.KeyFile, agent.NextKeyFile} {
		if _, err := os.Lstat(filepath.Join(dataDir, name)); err == nil {
			present = append(present, name)
		} else if !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(stderr, "bcd join --reset: %v\n", err)
			return exitFailure
		}
	}
	if len(present) == 0 {
		return exitOK
	}
	who := "this node"
	if state, key, err := agent.LoadState(dataDir); err == nil {
		who = "node " + state.NodeID
		if c, ok := key.(io.Closer); ok {
			_ = c.Close()
		}
	}
	if !yes {
		fmt.Fprintf(stderr, "bcd join --reset moves the identity of %s aside (%v in %s): the join that follows makes a new "+
			"key and joins again (a new node, unless the attestor proves this machine and reclaims it). Run it again with --reset --yes.\n",
			who, present, dataDir)
		return exitUsage
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	for _, name := range present {
		from := filepath.Join(dataDir, name)
		if err := os.Rename(from, from+".reset-"+stamp); err != nil {
			fmt.Fprintf(stderr, "bcd join --reset: %v\n", err)
			return exitFailure
		}
	}
	fmt.Fprintf(stdout, "moved the identity of %s aside (%v, suffix .reset-%s)\n", who, present, stamp)
	return exitOK
}
