//go:build linux && !amd64 && !arm64

package bcx

// seccompArch: no filter on other architectures (bcd ships for amd64 and arm64).
func seccompArch() (arch uint32, denied []uintptr, x32 bool) { return 0, nil, false }
