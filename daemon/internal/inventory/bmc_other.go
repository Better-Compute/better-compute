//go:build !linux || !(amd64 || arm64 || ppc64le || riscv64 || s390x || loong64)

package inventory

// IPMIBMC: the kernel IPMI interface is read on 64-bit Linux only.
func IPMIBMC() *BmcSection { return nil }
