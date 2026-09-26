//go:build helpere2e

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/better-compute/better-compute/daemon/internal/helper"
)

// helper-call (helpere2e builds only, never a release): one helper.Request from standard input, sent to
// [helper] socket as the installed bcd binary, as bcd node would; prints "ok" or the helper's error.
// The root helper e2e (internal/helper/roote2e) drives bcd helper through it.
func init() {
	extraCommands = append(extraCommands, command{
		name:    "helper-call",
		summary: "e2e builds: send one helper request (JSON on stdin) to [helper] socket",
		flags:   func(fs *flag.FlagSet) { fs.String("config", "/etc/bcd/config.toml", "configuration file") },
		run:     runHelperCall,
	})
}

func runHelperCall(fs *flag.FlagSet, stdout, stderr io.Writer) int {
	cfg, _, err := loadConfig(fs)
	if err != nil {
		fmt.Fprintf(stderr, "bcd helper-call: %v\n", err)
		return exitFailure
	}
	var req helper.Request
	dec := json.NewDecoder(io.LimitReader(os.Stdin, helper.MaxRequest))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		fmt.Fprintf(stderr, "bcd helper-call: %v\n", err)
		return exitUsage
	}
	c := helper.Client{Socket: cfg.Helper.Socket, Timeout: helper.HostUnitTimeout}
	if _, err := c.Call(context.Background(), req); err != nil {
		fmt.Fprintln(stdout, err)
		return exitFailure
	}
	fmt.Fprintln(stdout, "ok")
	return exitOK
}
