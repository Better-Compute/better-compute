//go:build !windows

package runtime

import "syscall"

// syscallNoCTTY opens a console's pty without making it bcd's controlling terminal.
const syscallNoCTTY = syscall.O_NOCTTY
