//go:build windows

package runtime

// syscallNoCTTY: Windows has no controlling terminals (bcd targets Linux).
const syscallNoCTTY = 0
